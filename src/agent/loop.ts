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
import { Planner, type Phase } from "./plan.js";
import { SessionManager, type AgentState } from "../memory/session-manager.js";
import { Corrector } from "./corrector.js";
import { extractJsonObject } from "../util/json.js";
import { randomUUID } from "node:crypto";

/** Hard ceiling on provider turns per run() to prevent runaway loops. */
const MAX_ITERATIONS = 50;

/** The set of tool actions (vs. the terminal "done"/"stuck" actions). */
const TOOL_ACTIONS = ["shell", "filesystem", "browser", "github"] as const;
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
  /** Emitted once when the goal has been decomposed into phases. */
  plan: (phases: Phase[]) => void;
  /** Emitted whenever a phase's status or findings change. */
  phaseUpdate: (phases: Phase[]) => void;
}

/** Optional collaborators and resume state for an AgentLoop. */
export interface AgentLoopOptions {
  planner?: Planner;
  sessionManager?: SessionManager;
  sessionId?: string;
  goal?: string;
  phases?: Phase[];
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

  // Multi-phase planning + resumable persistence.
  private readonly planner: Planner;
  private readonly sessionManager?: SessionManager;
  private readonly sessionId: string;
  private goal: string;
  private phases: Phase[];

  constructor(
    provider: Provider,
    session: SessionMemory,
    agentMemory: AgentMemory,
    options?: AgentLoopOptions,
  ) {
    super();
    this.provider = provider;
    this.session = session;
    this.agentMemory = agentMemory;
    this.workspacePath = resolveWorkspacePath(getConfig());

    this.planner = options?.planner ?? new Planner(provider);
    this.sessionManager = options?.sessionManager;
    this.sessionId =
      options?.sessionId ?? this.sessionManager?.newSessionId() ?? randomUUID();
    this.goal = options?.goal ?? "";
    this.phases = options?.phases ?? [];
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

  /** A copy of the current plan phases (never the internal reference). */
  get plan(): Phase[] {
    return this.phases.map((p) => ({ ...p, findings: [...p.findings] }));
  }

  /** The id of the session this loop persists under. */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Restore goal and plan from a persisted AgentState. History restoration is
   * handled by the caller seeding the shared SessionMemory (e.g. via
   * session.replaceHistory). Kept simple: only goal/phases are adopted here.
   */
  restore(state: AgentState): void {
    this.goal = state.goal;
    this.phases = state.phases.map((p) => ({ ...p, findings: [...p.findings] }));
  }

  /**
   * Persist the full run state when a SessionManager is configured. Best-effort:
   * SessionManager.save() already swallows its own errors.
   */
  private persistState(): void {
    if (!this.sessionManager) {
      return;
    }
    const state: AgentState = {
      sessionId: this.sessionId,
      goal: this.goal,
      phases: this.phases,
      history: this.session.getHistory(),
      metadata: {},
      updatedAt: new Date().toISOString(),
    };
    this.sessionManager.save(state);
  }

  /**
   * Apply a model-reported plan-progress signal: update the matching phase's
   * status, append any finding, emit "phaseUpdate", and persist. A progress
   * entry for an unknown phase id is ignored.
   */
  private applyProgress(progress: {
    phase: number;
    status: "in_progress" | "completed" | "failed";
    finding?: string;
  }): void {
    const phase = this.phases.find((p) => p.id === progress.phase);
    if (!phase) {
      return;
    }
    phase.status = progress.status;
    if (progress.finding && progress.finding.trim().length > 0) {
      phase.findings.push(progress.finding.trim());
    }
    this.emit("phaseUpdate", this.plan);
    this.persistState();
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

    // ---- Plan once per run when no plan exists yet -----------------------
    if (this.phases.length === 0) {
      this.goal = task;
      try {
        this.phases = await this.planner.decompose(task);
      } catch {
        // decompose itself never throws, but be defensive: fall back to one phase.
        this.phases = [
          { id: 1, title: task.slice(0, 80), description: task, status: "pending", findings: [] },
        ];
      }
      if (this.phases.length === 0) {
        this.phases = [
          { id: 1, title: task.slice(0, 80), description: task, status: "pending", findings: [] },
        ];
      }
      this.emit("plan", this.plan);
      const first = this.phases[0];
      if (first) {
        first.status = "in_progress";
      }
      this.persistState();
    }

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        const prompt = buildPrompt({
          agentMd: this.agentMemory.getContent(),
          workspacePath: this.workspacePath,
          history: this.session.getHistory(),
          now: new Date(),
          phases: this.phases,
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

        // ---- Plan progress update --------------------------------------------
        if (response.progress) {
          this.applyProgress(response.progress);
        }

        // ---- Terminal actions -------------------------------------------------
        if (response.action === "done") {
          this.persistState();
          this.emit("done", response.message ?? "Task complete.");
          return;
        }
        if (response.action === "stuck") {
          this.persistState();
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
              this.persistState();
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

      this.persistState();
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
