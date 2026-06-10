import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "fs-extra";
import type { Provider, ImageData, GenerateResult } from "../providers/index.js";
import { executeTool, type ToolResult } from "../tools/index.js";
import { SessionMemory } from "../memory/session.js";
import { AgentMemory } from "../memory/agent-md.js";
import { getConfig, resolveWorkspacePath } from "../config/index.js";
import {
  AgentResponseSchema,
  buildGenerateRequest,
  buildReflectionRequest,
  parseReflection,
  type AgentResponse,
  type Reflection,
} from "./planner.js";
import { Planner, type Phase } from "./plan.js";
import { SessionManager, type AgentState } from "../memory/session-manager.js";
import { Corrector } from "./corrector.js";
import { UsageTracker, type SessionUsage } from "./usage.js";
import { extractJsonObject } from "../util/json.js";
import { randomUUID } from "node:crypto";

/** Hard ceiling on provider turns per run() to prevent runaway loops. */
const MAX_ITERATIONS = 50;

/** How many times a "done" may be sent back for more work by the self-check
 *  before it is accepted regardless (prevents an endless "not done" loop). */
const MAX_REFLECTIONS = 2;

/** The set of tool actions (vs. the terminal "done"/"stuck" actions). */
const TOOL_ACTIONS = [
  "shell",
  "filesystem",
  "browser",
  "github",
  "research",
  "code",
  "memory",
  "serve",
  "http",
] as const;
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
  /** Emitted after each provider call that reported token usage, with the
   *  session's running totals (tokens + estimated cost). */
  usage: (totals: SessionUsage) => void;
}

/** Optional collaborators and resume state for an AgentLoop. */
export interface AgentLoopOptions {
  planner?: Planner;
  sessionManager?: SessionManager;
  sessionId?: string;
  goal?: string;
  phases?: Phase[];
}

/** A request to approve a potentially risky action (currently shell commands). */
export interface ApprovalRequest {
  tool: string;
  summary: string; // e.g. the shell command being proposed
}
/** Resolves true to allow the action, false to deny it. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

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
  // Optional gate for interactive approval of risky actions (shell commands).
  // When unset the loop never pauses — headless/non-interactive runs stay
  // fully autonomous (see setApprovalHandler).
  private approvalHandler?: ApprovalHandler;
  // Screenshots captured this turn, attached to the NEXT provider request so a
  // vision-capable model can see the page. Shown once, then cleared.
  private pendingImages: ImageData[] = [];
  // Running token totals + estimated cost for this session, fed from each
  // provider call's usage metadata; also enforces the configured budget.
  private readonly usage = new UsageTracker();

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

  /** Register (or clear with undefined) the handler used to approve risky
   *  actions in interactive mode. When no handler is set the loop never pauses
   *  (headless / non-interactive runs stay fully autonomous). */
  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  /**
   * Ask the model to self-check the work against the goal before "done" is
   * accepted. Returns the verdict, or null on any failure (in which case the
   * caller accepts "done" rather than blocking).
   */
  private async reflect(): Promise<Reflection | null> {
    try {
      const request = buildReflectionRequest({
        agentMd: this.agentMemory.getContent(),
        workspacePath: this.workspacePath,
        goal: this.goal,
        history: this.session.getHistory(),
      });
      const result = await this.provider.generate(request);
      this.trackUsage(result);
      return parseReflection(result.text);
    } catch {
      return null;
    }
  }

  /**
   * After a successful `browser screenshot`, read the saved PNG and queue it so
   * the next provider turn can show it to a vision-capable model. Best-effort:
   * skips silently when vision is off, the path can't be parsed, or the read
   * fails — a screenshot we can't show just isn't shown.
   */
  private queueScreenshot(resultText: string): void {
    if (!this.provider.supportsVision || !getConfig().enableVision) {
      return;
    }
    const match = /([^\s"']+\.png)/i.exec(resultText);
    const raw = match ? match[1] : undefined;
    if (raw === undefined) {
      return;
    }
    const file = path.isAbsolute(raw) ? raw : path.join(this.workspacePath, raw);
    try {
      if (!fs.existsSync(file)) {
        return;
      }
      const data = fs.readFileSync(file).toString("base64");
      if (data.length > 0) {
        this.pendingImages.push({ data, mediaType: "image/png" });
      }
    } catch {
      // Best-effort — ignore an unreadable screenshot.
    }
  }

  /** A copy of the current plan phases (never the internal reference). */
  get plan(): Phase[] {
    return this.phases.map((p) => ({
      ...p,
      findings: Array.isArray(p.findings) ? [...p.findings] : [],
    }));
  }

  /** The id of the session this loop persists under. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Current session token/cost totals (a copy). */
  get sessionUsage(): SessionUsage {
    return this.usage.get();
  }

  /** Record one provider call's token usage and notify listeners. */
  private trackUsage(result: GenerateResult): void {
    if (result.usage) {
      this.emit("usage", this.usage.add(this.provider.name, result.usage));
    }
  }

  /**
   * Clear the plan for a brand-new conversation (e.g. after /clear). The shared
   * SessionMemory is reset separately by the caller; here we only drop the goal
   * and phases and emit the now-empty plan so the UI's plan view clears.
   */
  reset(): void {
    this.phases = [];
    this.goal = "";
    this.emit("phaseUpdate", this.plan);
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
      if (!Array.isArray(phase.findings)) {
        phase.findings = [];
      }
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
    let reflectionCount = 0;
    this.session.add({ role: "user", content: task, timestamp: new Date() });

    try {
      // ---- Plan for a fresh goal, but preserve an in-progress plan --------
      // Re-plan when there is no plan yet OR the previous plan is fully
      // completed/failed (a brand-new follow-up task). When phases are still
      // pending/in_progress (e.g. resuming after "stuck"), keep the existing
      // plan and continue it. The planning block is inside the try so that a
      // throw from decompose/emit/a listener still resets this.running below.
      const noActivePlan =
        this.phases.length === 0 ||
        this.phases.every((p) => p.status === "completed" || p.status === "failed");
      if (noActivePlan) {
        this.goal = task;
        try {
          this.phases = await this.planner.decompose(task, this.provider);
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

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        // Budget gate: stop BEFORE the next provider call once the estimated
        // session cost has reached the configured limit (0 = unlimited).
        this.usage.budgetUsd = getConfig().budgetUsd;
        if (this.usage.overBudget()) {
          const totals = this.usage.get();
          this.persistState();
          this.emit(
            "stuck",
            `Budget limit reached: estimated cost ~$${totals.costUsd.toFixed(2)} of the ` +
              `$${this.usage.budgetUsd.toFixed(2)} budget (${totals.calls} provider calls). ` +
              `Raise "budgetUsd" in settings (or set it to 0) to continue.`,
          );
          return;
        }

        const useVision = this.provider.supportsVision && getConfig().enableVision;
        const request = buildGenerateRequest({
          agentMd: this.agentMemory.getContent(),
          workspacePath: this.workspacePath,
          history: this.session.getHistory(),
          now: new Date(),
          phases: this.phases,
          images: useVision && this.pendingImages.length > 0 ? this.pendingImages : undefined,
        });
        // Screenshots are shown once: clear them whether or not vision is on, so
        // they never accumulate across turns.
        this.pendingImages = [];

        // ---- Ask the provider (native tools → a structured action) ----------
        let result: GenerateResult;
        try {
          result = await this.provider.generate(request);
        } catch (err) {
          this.emit("error", `Provider call failed: ${errMessage(err)}`);
          return;
        }
        this.trackUsage(result);

        // ---- Resolve the action: native tool call, else parsed JSON text -----
        const parsed = responseFromResult(result);
        if ("error" in parsed) {
          const outcome = corrector.recordFailure("parse");
          const note =
            `Your previous turn did not produce a valid action (${parsed.error}). ` +
            `Call exactly one of the available tools to take the next step (or, if your ` +
            `model has no tools, reply with the single JSON action object).`;
          this.session.add({ role: "tool_result", content: note, timestamp: new Date() });
          if (outcome.giveUp) {
            this.emit(
              "error",
              `Provider did not return a usable action after ${outcome.attempt} attempts. ` +
                `Last text: ${truncate(result.text, 500)}`,
            );
            return;
          }
          // Self-healing: back off before re-prompting after a malformed reply.
          if (outcome.backoffMs > 0) {
            await delay(outcome.backoffMs);
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
        // Text/CLI mode carries progress in a JSON field; native tool-calling
        // reports it via a dedicated `update_plan` tool call.
        if (response.progress) {
          this.applyProgress(response.progress);
        }
        if (response.action === "update_plan") {
          const p = response.params;
          const phase = typeof p.phase === "number" ? p.phase : Number(p.phase);
          const status = p.status;
          if (
            Number.isFinite(phase) &&
            (status === "in_progress" || status === "completed" || status === "failed")
          ) {
            this.applyProgress({
              phase,
              status,
              finding: typeof p.finding === "string" ? p.finding : undefined,
            });
          }
          continue;
        }

        // ---- Terminal actions -------------------------------------------------
        if (response.action === "done") {
          // Self-critique: before accepting "done", ask the model to verify the
          // goal is truly met. If it isn't (and we haven't nudged too many
          // times), feed the critique back and keep working instead of stopping.
          if (
            getConfig().enableReflection &&
            this.goal.trim().length > 0 &&
            reflectionCount < MAX_REFLECTIONS
          ) {
            const verdict = await this.reflect();
            if (verdict && !verdict.complete) {
              reflectionCount += 1;
              const note =
                `Self-check (${reflectionCount}/${MAX_REFLECTIONS}): the goal is NOT fully complete yet. ` +
                `${verdict.reason}${verdict.nextStep ? ` Next: ${verdict.nextStep}` : ""} ` +
                `Keep working — do not stop until it is genuinely done.`;
              this.emit("thought", note);
              this.session.add({ role: "system", content: note, timestamp: new Date() });
              continue;
            }
          }
          // "done" means the whole task is finished. Mark any still-open phases
          // completed so a follow-up run() with a new goal re-plans from scratch
          // (the noActivePlan gate) instead of resuming this now-stale plan.
          let changed = false;
          for (const phase of this.phases) {
            if (phase.status !== "completed" && phase.status !== "failed") {
              phase.status = "completed";
              changed = true;
            }
          }
          if (changed) {
            this.emit("phaseUpdate", this.plan);
          }
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
          const cfg = getConfig();

          // Edit gate: block file mutations when the user disabled "Suggest
          // edits". read/list are always allowed. A block is NOT a failure, so
          // we feed a note and continue without touching the corrector.
          if (response.action === "filesystem") {
            const op = typeof params.operation === "string" ? params.operation : "";
            if (
              !cfg.permSuggestEdits &&
              (op === "write" || op === "delete" || op === "mkdir")
            ) {
              this.emit("toolCall", { tool: response.action, params });
              const note =
                "[filesystem] BLOCKED: file edits are turned off in your permissions " +
                '("Suggest edits" is off). Re-enable it in /settings to allow changes, ' +
                "or proceed without editing files.";
              this.emit("toolResult", {
                tool: response.action,
                result: note,
                success: false,
              });
              this.session.add({
                role: "tool_result",
                content: note,
                timestamp: new Date(),
              });
              continue;
            }
          }

          // Show the proposed action before any approval gate so the UI can
          // display what the agent wants to do.
          this.emit("toolCall", { tool: response.action, params });

          // Approval gate: pause RISKY actions for user approval in interactive
          // mode — a shell command, or code run via a real interpreter (python/
          // node/bash/powershell; the "js" sandbox is contained and exempt).
          // Both have full system access. With no handler registered (headless /
          // Telegram-only) the loop never pauses and stays fully autonomous. A
          // denial is NOT a failure, so we feed a note and continue without
          // touching the corrector.
          const codeLang =
            response.action === "code"
              ? typeof params.language === "string"
                ? params.language
                : "js"
              : null;
          const isRiskyCode = codeLang !== null && codeLang !== "js";
          if (
            cfg.requireCommandApproval &&
            this.approvalHandler &&
            (response.action === "shell" || isRiskyCode)
          ) {
            const summary =
              response.action === "shell"
                ? typeof params.command === "string"
                  ? params.command
                  : stableStringify(params)
                : `${codeLang}: ${typeof params.code === "string" ? params.code : stableStringify(params)}`;
            let approved = false;
            try {
              approved = await this.approvalHandler({ tool: response.action, summary });
            } catch {
              approved = false;
            }
            if (!approved) {
              const note =
                `[${response.action}] DENIED by the user. It was NOT run. Choose a different ` +
                'approach, or explain what you need and use action "stuck" if you cannot proceed.';
              this.emit("toolResult", {
                tool: response.action,
                result: "Action denied by the user.",
                success: false,
              });
              this.session.add({ role: "tool_result", content: note, timestamp: new Date() });
              continue;
            }
          }

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
              content: `[${response.action}] ${compressObservation(result.result)}`,
              timestamp: new Date(),
            });
            // Vision: queue a screenshot so the model can see it next turn.
            if (
              response.action === "browser" &&
              params.operation === "screenshot"
            ) {
              this.queueScreenshot(result.result);
            }
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
            // Self-healing: wait with exponential back-off before the next try so
            // transient failures (rate limits, races, flaky network) can clear.
            if (outcome.backoffMs > 0) {
              await delay(outcome.backoffMs);
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

/**
 * Adapt a provider {@link GenerateResult} into an AgentResponse. Prefer a native
 * tool call (API providers with function-calling); otherwise fall back to
 * parsing the JSON action object from text (CLI / providers without tools).
 */
export function responseFromResult(result: GenerateResult): ParseSuccess | ParseFailure {
  const call = result.toolCalls[0];
  if (call) {
    const args = call.arguments ?? {};
    const message = typeof args.message === "string" ? args.message : undefined;
    const validated = AgentResponseSchema.safeParse({
      thought: result.text ?? "",
      action: call.name,
      params: args,
      ...(message !== undefined ? { message } : {}),
    });
    if (!validated.success) {
      return {
        error: `unknown or invalid tool "${call.name}": ${validated.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      };
    }
    return { value: validated.data };
  }
  if (result.text.trim().length > 0) {
    return parseAgentResponse(result.text);
  }
  return { error: "the model returned neither a tool call nor any text" };
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

/** Promise that resolves after `ms` milliseconds (used for retry back-off). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap a tool observation kept in the MODEL context (head + tail) so a huge
 * output doesn't bloat the prompt and blow the cache window. The UI still shows
 * the full result via the toolResult event; only the model-context copy stored
 * in session history is trimmed.
 */
function compressObservation(text: string, max = 6000): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, 4000);
  const tail = text.slice(-1500);
  const omitted = text.length - head.length - tail.length;
  return (
    `${head}\n\n... [${omitted} characters omitted to save context — ` +
    `re-run with a narrower query/path if you need the rest] ...\n\n${tail}`
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
