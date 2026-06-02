import { EventEmitter } from "node:events";
import type { Provider } from "../providers/index.js";
import { executeTool, type ToolResult } from "../tools/index.js";
import { SessionMemory } from "../memory/session.js";
import { AgentMemory } from "../memory/agent-md.js";
import { getConfig, resolveWorkspacePath } from "../config/index.js";
import {
  AgentResponseSchema,
  buildPrompt,
  type AgentResponse,
} from "./planner.js";
import { Corrector } from "./corrector.js";

/** Hard ceiling on provider turns per run() to prevent runaway loops. */
const MAX_ITERATIONS = 50;

/** The set of tool actions (vs. the terminal "done"/"stuck" actions). */
const TOOL_ACTIONS = ["shell", "filesystem", "browser"] as const;
type ToolAction = (typeof TOOL_ACTIONS)[number];

function isToolAction(action: AgentResponse["action"]): action is ToolAction {
  return (TOOL_ACTIONS as readonly string[]).includes(action);
}

/** Strongly-typed event payloads emitted by the AgentLoop. */
export interface AgentEvents {
  thought: (thought: string) => void;
  toolCall: (data: { tool: string; params: Record<string, unknown> }) => void;
  toolResult: (data: { tool: string; result: string; success: boolean }) => void;
  message: (message: string) => void;
  done: (finalMessage: string) => void;
  stuck: (question: string) => void;
  error: (message: string) => void;
}

// Typed on/once/off/emit overlay over Node's EventEmitter (no `any`).
export declare interface AgentLoop {
  on<K extends keyof AgentEvents>(event: K, listener: AgentEvents[K]): this;
  once<K extends keyof AgentEvents>(event: K, listener: AgentEvents[K]): this;
  off<K extends keyof AgentEvents>(event: K, listener: AgentEvents[K]): this;
  emit<K extends keyof AgentEvents>(
    event: K,
    ...args: Parameters<AgentEvents[K]>
  ): boolean;
}

/**
 * AgentLoop — the core ReAct-style loop. Given a task it repeatedly asks the
 * provider for the next JSON action, executes tools, feeds results back, and
 * self-corrects on failure until the model reports "done" or "stuck".
 */
export class AgentLoop extends EventEmitter {
  // Not readonly: the provider can be hot-swapped mid-session (see setProvider)
  // so the user can switch model/provider via /model or /provider without
  // losing the conversation — the shared SessionMemory carries the history.
  private provider: Provider;
  private readonly session: SessionMemory;
  private readonly agentMemory: AgentMemory;
  // Cached for the system prompt; refreshed from config via refreshWorkspace()
  // after a /settings change to the workspace path.
  private workspacePath: string;
  private running = false;

  constructor(provider: Provider, session: SessionMemory, agentMemory: AgentMemory) {
    super();
    this.provider = provider;
    this.session = session;
    this.agentMemory = agentMemory;
    this.workspacePath = resolveWorkspacePath(getConfig());
  }

  /** True while a run() is in progress (used by the Telegram queue). */
  isRunning(): boolean {
    return this.running;
  }

  /** Name of the currently active provider (e.g. "gemini" or "api:anthropic"). */
  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Swap the active provider. The conversation is NOT reset — the same
   * SessionMemory keeps the full history, so the next provider turn continues
   * exactly where the previous one left off. Used by mid-chat /model and
   * /provider switches. Switching is only initiated by the UI while idle.
   */
  setProvider(provider: Provider): void {
    this.provider = provider;
  }

  /** Re-read the workspace path from config (after a /settings change). */
  refreshWorkspace(): void {
    this.workspacePath = resolveWorkspacePath(getConfig());
  }

  /**
   * Execute a task end-to-end. Adds the task to session memory and drives the
   * loop until a terminal event (done / stuck / error). Conversation history is
   * preserved across calls so a follow-up run() continues where "stuck" left off.
   */
  async run(task: string): Promise<void> {
    if (this.running) {
      // Defensive: callers should queue, but never run two loops concurrently.
      this.emit("error", "A task is already running. Ignoring concurrent run().");
      return;
    }
    this.running = true;

    const corrector = new Corrector();
    this.session.add({ role: "user", content: task, timestamp: new Date() });

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        const prompt = buildPrompt({
          agentMd: this.agentMemory.getContent(),
          workspacePath: this.workspacePath,
          history: this.session.getHistory(),
          now: new Date(),
        });

        // ---- Ask the provider -------------------------------------------------
        let raw: string;
        try {
          raw = await this.provider.complete(prompt);
        } catch (err) {
          this.emit("error", `Provider call failed: ${errMessage(err)}`);
          return;
        }

        // ---- Parse the JSON response -----------------------------------------
        const parsed = parseAgentResponse(raw);
        if ("error" in parsed) {
          const outcome = corrector.recordFailure("parse");
          const note =
            `Your previous response could not be parsed as the required JSON object ` +
            `(${parsed.error}). You MUST reply with a single valid JSON object matching ` +
            `the format. Do not include any other text.`;
          this.session.add({ role: "tool_result", content: note, timestamp: new Date() });
          if (outcome.giveUp) {
            this.emit(
              "error",
              `Provider did not return valid JSON after ${outcome.attempt} attempts. ` +
                `Last raw output: ${truncate(raw, 500)}`,
            );
            return;
          }
          continue;
        }

        const response = parsed.value;
        // Record the assistant turn verbatim so the model sees its own history.
        this.session.add({
          role: "assistant",
          content: JSON.stringify(response),
          timestamp: new Date(),
        });

        if (response.thought.length > 0) {
          this.emit("thought", response.thought);
        }
        if (response.message && response.message.length > 0 && response.action !== "done" && response.action !== "stuck") {
          this.emit("message", response.message);
        }

        // ---- Terminal actions -------------------------------------------------
        if (response.action === "done") {
          this.emit("done", response.message ?? "Task complete.");
          return;
        }
        if (response.action === "stuck") {
          this.emit(
            "stuck",
            response.message ?? "I'm stuck and need more information to continue.",
          );
          return;
        }

        // ---- Tool actions -----------------------------------------------------
        if (isToolAction(response.action)) {
          const params = response.params;
          this.emit("toolCall", { tool: response.action, params });

          const result: ToolResult = await executeTool(response.action, params);

          this.emit("toolResult", {
            tool: response.action,
            result: result.success ? result.result : result.error ?? "Unknown error",
            success: result.success,
          });

          if (result.success) {
            corrector.reset();
            this.session.add({
              role: "tool_result",
              content: `[${response.action}] ${result.result}`,
              timestamp: new Date(),
            });
          } else {
            const signature = `${response.action}:${stableStringify(params)}`;
            const outcome = corrector.recordFailure(signature);
            const errorText = result.error ?? "Unknown error";
            this.session.add({
              role: "tool_result",
              content:
                `[${response.action}] FAILED (attempt ${outcome.attempt}/3): ${errorText}. ` +
                `Adjust your approach or fix the parameters and try again.`,
              timestamp: new Date(),
            });
            if (outcome.giveUp) {
              this.emit(
                "stuck",
                `The ${response.action} step failed 3 times in a row: ${errorText}. ` +
                  `I need your help to proceed.`,
              );
              return;
            }
          }
          continue;
        }

        // Should be unreachable thanks to the schema enum.
        this.emit("error", `Unknown action: ${String(response.action)}`);
        return;
      }

      this.emit(
        "stuck",
        `Reached the maximum of ${MAX_ITERATIONS} steps without finishing. ` +
          `Let me know how you'd like to proceed.`,
      );
    } finally {
      this.running = false;
    }
  }
}

// ---- JSON parsing helpers ---------------------------------------------------

type ParseSuccess = { value: AgentResponse };
type ParseFailure = { error: string };

/**
 * Parse a provider's raw text into an AgentResponse. Tolerates markdown code
 * fences and surrounding prose by extracting the first balanced JSON object,
 * then validates it against the schema.
 */
export function parseAgentResponse(raw: string): ParseSuccess | ParseFailure {
  const jsonText = extractJsonObject(raw);
  if (jsonText === null) {
    return { error: "no JSON object found in output" };
  }

  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    return { error: `JSON.parse failed: ${errMessage(err)}` };
  }

  const validated = AgentResponseSchema.safeParse(data);
  if (!validated.success) {
    return { error: validated.error.issues.map((i) => i.message).join("; ") };
  }
  return { value: validated.data };
}

/**
 * Extract the first balanced top-level JSON object from arbitrary text,
 * accounting for strings and escape sequences so braces inside strings don't
 * confuse the matcher. Strips ```json / ``` fences first.
 */
function extractJsonObject(raw: string): string | null {
  const stripped = raw.replace(/```json/gi, "```").replace(/```/g, "");
  const start = stripped.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Deterministic stringify (sorted keys) so identical params share a signature. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
