import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "fs-extra";
import type { Provider, ImageData, GenerateResult } from "../providers/index.js";
import { executeTool, type ToolResult } from "../tools/index.js";
import { SessionMemory } from "../memory/session.js";
import { AgentMemory } from "../memory/agent-md.js";
import { getConfig, resolveWorkspacePath } from "../config/index.js";
import {
  buildGenerateRequest,
  buildReflectionRequest,
  parseReflection,
  isActionName,
  type ActionName,
  type AgentResponse,
  type Reflection,
} from "./planner.js";
import { Planner, type Phase } from "./plan.js";
import { SessionManager, type AgentState } from "../memory/session-manager.js";
import { Corrector } from "./corrector.js";
import { UsageTracker, type SessionUsage } from "./usage.js";
import { WorkingMemory } from "./working-memory.js";
import { LongTermMemory } from "../memory/longterm.js";
import { Tracer } from "../trace.js";
import { computeUnifiedDiff } from "../util/diff.js";
import { randomUUID } from "node:crypto";
import {
  turnFromResult,
  serializeTurn,
  reflectionFromArgs,
  tryParseActionObject,
  stableStringify,
  truncate,
  delay,
  compressObservation,
  errMessage,
  type TurnAction,
  type ParsedTurn,
} from "./turn.js";

// ---- Iteration budget (IMP-04) ----------------------------------------------

/** Baseline provider turns per run() for the simplest one-phase task. */
const BASE_ITERATIONS = 20;
/** Extra turns granted per planned phase — complex plans get more room. */
const PER_PHASE_ITERATIONS = 5;
/** Hard ceiling regardless of plan size or override, to stop runaway loops. */
const ABSOLUTE_MAX_ITERATIONS = 200;

/**
 * IMP-04: dynamic iteration cap — base 20 + 5 per planned phase, clamped to the
 * absolute ceiling. The OPENAGENT_MAX_ITERATIONS environment variable (set by
 * the --max-iterations CLI flag) overrides the computed value for one run.
 */
export function resolveMaxIterations(phaseCount: number): number {
  const env = process.env.OPENAGENT_MAX_ITERATIONS;
  if (env && env.trim().length > 0) {
    const n = Number(env);
    if (Number.isInteger(n) && n > 0) {
      return Math.min(n, ABSOLUTE_MAX_ITERATIONS);
    }
  }
  const dynamic = BASE_ITERATIONS + PER_PHASE_ITERATIONS * Math.max(0, phaseCount);
  return Math.min(Math.max(BASE_ITERATIONS, dynamic), ABSOLUTE_MAX_ITERATIONS);
}

/** How many times a "done" may be sent back for more work by the self-check
 *  before it is accepted regardless (prevents an endless "not done" loop). */
const MAX_REFLECTIONS = 2;

/** Max read-only tool calls the verification pass may make before it must
 *  deliver a verdict (keeps IMP-05 verification cheap and bounded). */
const MAX_VERIFY_TOOL_STEPS = 4;

/** IMP-06: how many times one run() may dynamically rewrite the plan after a
 *  phase gets stuck, before it gives up and surfaces "stuck" to the user. */
const MAX_REPLANS = 2;

/** IMP-31: maximum agent nesting depth. A loop at depth ≥ this cannot `spawn`
 *  children, so recursion (and fan-out cost) is hard-bounded. 1 = only the
 *  top-level agent spawns; its children run to completion but cannot spawn. */
const MAX_SPAWN_DEPTH = 1;
/** Hard ceiling on iterations a spawned child may use, regardless of its plan. */
const CHILD_MAX_ITERATIONS = 30;

/** Filesystem operations the verification pass is allowed to run. */
const VERIFY_READONLY_OPS = ["read", "list", "grep", "find", "diff"] as const;

/** The set of tool actions (vs. the control actions update_plan/done/stuck). */
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
  "plugin",
  "spawn",
] as const;
type ToolAction = (typeof TOOL_ACTIONS)[number];

function isToolAction(action: ActionName): action is ToolAction {
  return (TOOL_ACTIONS as readonly string[]).includes(action);
}

// ---- Explicit loop state (IMP-01) --------------------------------------------

/**
 * Discriminated-union state of the agent loop. run() is a dispatcher over these
 * states — every transition is explicit, emitted via the "stateChange" event,
 * and readable at any time via `loop.state`, which makes the loop debuggable
 * and its transitions testable.
 *
 *   idle → planning → thinking ⇄ executing → … → verifying → done | stuck | error
 */
export type LoopState =
  | { phase: "idle" }
  | { phase: "planning" }
  | { phase: "thinking"; iteration: number }
  | { phase: "executing"; toolName: string; iteration: number }
  | { phase: "verifying"; round: number }
  | { phase: "done"; message: string }
  | { phase: "stuck"; reason: string }
  | { phase: "error"; message: string };

// TurnAction / ParsedTurn now live in ./turn.ts (imported above) and are
// re-exported here so existing importers of loop.ts keep working.
export type { TurnAction, ParsedTurn } from "./turn.js";

/** Per-run mutable context threaded through the state handlers. */
interface RunContext {
  corrector: Corrector;
  reflectionCount: number;
  /** Provider turns consumed so far. */
  iterationsUsed: number;
  /** Dynamic cap for this run (IMP-04). */
  maxIterations: number;
  /** Tool actions handed from thinking → executing. */
  pendingActions: TurnAction[];
  /** The "done" message stashed while the verification pass runs. */
  pendingDoneMessage: string;
  /** IMP-06: how many times the plan has been dynamically rewritten this run. */
  replanCount: number;
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
  /** Emitted on every FSM transition (IMP-01). */
  stateChange: (state: LoopState) => void;
  /** IMP-15: incremental output from a streaming tool (currently shell) while
   *  it runs. The UI buffers these into ~150ms state updates. */
  toolChunk: (data: { tool: string; chunk: string }) => void;
  /** IMP-27: emitted after a filesystem write/edit with the unified diff of the
   *  change, so the UI can render an inline +/- diff view. */
  fileDiff: (data: { path: string; diff: string }) => void;
}

/** Optional collaborators and resume state for an AgentLoop. */
export interface AgentLoopOptions {
  planner?: Planner;
  sessionManager?: SessionManager;
  sessionId?: string;
  goal?: string;
  phases?: Phase[];
  /** IMP-08: persisted working-memory snapshot to restore (from AgentState
   *  metadata). Tolerates any shape — malformed input restores empty. */
  workingMemory?: unknown;
  /** Override the long-term memory store (tests use a temp directory). */
  longTermMemory?: LongTermMemory;
  /** IMP-18: optional cheaper/faster provider used for simple action steps;
   *  planning and verification always use the main (smart) provider. Omitted
   *  (or === the main provider) disables routing. */
  fastProvider?: Provider;
  /** IMP-31: nesting depth of this loop. 0 = top-level; a child created by the
   *  `spawn` action gets parent depth + 1. Depth ≥ MAX_SPAWN_DEPTH cannot spawn
   *  further (prevents runaway recursion / fan-out). */
  spawnDepth?: number;
  /** IMP-31: when set, restrict this (child) loop to these tool actions. */
  allowedActions?: readonly string[];
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
 * AgentLoop — the core ReAct-style loop, structured as an explicit finite state
 * machine (IMP-01). Given a task it plans, repeatedly asks the provider for the
 * next action(s), executes tools (independent actions in parallel, IMP-02),
 * feeds results back, verifies completion before accepting "done" (IMP-05), and
 * self-corrects on failure until it reaches done / stuck / error.
 */
export class AgentLoop extends EventEmitter {
  // Not readonly: the provider can be hot-swapped mid-session (see setProvider)
  // so the user can switch model/provider via /model or /provider without
  // losing the conversation — the shared SessionMemory carries the history.
  private provider: Provider;
  // IMP-18: optional fast/cheap provider for simple action steps. Planning and
  // verification deliberately keep using `provider` (the smart model). undefined
  // when routing is disabled — every step then uses `provider`.
  private fastProvider?: Provider;
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
  // Current FSM state (IMP-01); transitions are emitted via "stateChange".
  private loopState: LoopState = { phase: "idle" };

  // Multi-phase planning + resumable persistence.
  private readonly planner: Planner;
  private readonly sessionManager?: SessionManager;
  private readonly sessionId: string;
  private goal: string;
  private phases: Phase[];
  // IMP-08: structured task state (facts/constraints/artifacts/variables),
  // recited in every provider turn and persisted with the session.
  private readonly workingMemory: WorkingMemory;
  // IMP-09: durable store for success patterns (and the memory tool's notes).
  private readonly longTerm: LongTermMemory;
  // IMP-24: per-session span log (~/.openagent/traces/<sessionId>.jsonl).
  private readonly tracer: Tracer;
  // IMP-31: this loop's nesting depth and (for a child) its scoped tool set.
  private readonly spawnDepth: number;
  private readonly allowedActions?: readonly string[];

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
    this.workingMemory = WorkingMemory.from(options?.workingMemory);
    this.longTerm = options?.longTermMemory ?? new LongTermMemory();
    this.tracer = new Tracer(this.sessionId);
    // Only treat it as a fast provider when it's actually a different instance.
    this.fastProvider =
      options?.fastProvider && options.fastProvider !== provider
        ? options.fastProvider
        : undefined;
    this.spawnDepth = options?.spawnDepth ?? 0;
    this.allowedActions = options?.allowedActions;
  }

  /** True while a run() is in progress (used by the Telegram queue). */
  isRunning(): boolean {
    return this.running;
  }

  /** Current FSM state (a reference to the immutable state object). */
  get state(): LoopState {
    return this.loopState;
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

  /** Swap (or clear) the fast routing provider (IMP-18), e.g. after /settings
   *  changes fastModel. Cleared when it would equal the main provider. */
  setFastProvider(provider: Provider | undefined): void {
    this.fastProvider = provider && provider !== this.provider ? provider : undefined;
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

  /** Current session token/cost totals (a copy). */
  get sessionUsage(): SessionUsage {
    return this.usage.get();
  }

  /** Record one provider call's token usage and notify listeners. The provider
   *  name is taken from whichever provider actually made the call (routing). */
  private trackUsage(result: GenerateResult, provider: Provider = this.provider): void {
    if (result.usage) {
      this.emit("usage", this.usage.add(provider.name, result.usage));
    }
  }

  /** Transition the FSM and notify listeners (IMP-01). */
  private setState(state: LoopState): void {
    this.loopState = state;
    this.tracer.event("state", { phase: state.phase });
    this.emit("stateChange", state);
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
      metadata: { workingMemory: this.workingMemory.data },
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
   * IMP-08: derive working-memory artifacts from successful tool runs without
   * any model cooperation — files written/dirs created, preview URLs, and
   * screenshots are durable task outputs worth keeping in front of the model.
   */
  private trackArtifact(action: TurnAction, resultText: string): void {
    if (action.action === "filesystem") {
      const op = typeof action.params.operation === "string" ? action.params.operation : "";
      const target = typeof action.params.path === "string" ? action.params.path : "";
      if ((op === "write" || op === "mkdir") && target.length > 0) {
        this.workingMemory.addArtifact(target);
      }
      return;
    }
    if (action.action === "serve") {
      const url = /https?:\/\/localhost:\d+/.exec(resultText)?.[0];
      if (url !== undefined) {
        this.workingMemory.addArtifact(url);
      }
      return;
    }
    if (action.action === "browser" && action.params.operation === "screenshot") {
      const file = /([^\s"']+\.png)/i.exec(resultText)?.[1];
      if (file !== undefined) {
        this.workingMemory.addArtifact(file);
      }
    }
  }

  /** Apply an `update_plan` action's params as a progress signal. */
  private applyUpdatePlanAction(params: Record<string, unknown>): void {
    const phase = typeof params.phase === "number" ? params.phase : Number(params.phase);
    const status = params.status;
    if (
      Number.isFinite(phase) &&
      (status === "in_progress" || status === "completed" || status === "failed")
    ) {
      this.applyProgress({
        phase,
        status,
        finding: typeof params.finding === "string" ? params.finding : undefined,
      });
    }
  }

  /**
   * Execute a task end-to-end by driving the FSM until a terminal state.
   * Conversation history is preserved across calls so a follow-up run()
   * continues where "stuck" left off.
   */
  async run(task: string): Promise<void> {
    if (this.running) {
      // Defensive: callers should queue, but never run two loops concurrently.
      this.emit("error", "A task is already running. Ignoring concurrent run().");
      return;
    }
    this.running = true;

    const ctx: RunContext = {
      corrector: new Corrector(),
      reflectionCount: 0,
      iterationsUsed: 0,
      maxIterations: ABSOLUTE_MAX_ITERATIONS,
      pendingActions: [],
      pendingDoneMessage: "Task complete.",
      replanCount: 0,
    };
    this.session.add({ role: "user", content: task, timestamp: new Date() });

    try {
      this.setState({ phase: "planning" });
      await this.handlePlanning(task, ctx);

      let state: LoopState = { phase: "thinking", iteration: 1 };
      while (state.phase !== "done" && state.phase !== "stuck" && state.phase !== "error") {
        this.setState(state);
        switch (state.phase) {
          case "thinking":
            state = await this.handleThinking(ctx);
            break;
          case "executing":
            state = await this.handleExecuting(ctx);
            break;
          case "verifying":
            state = await this.handleVerifying(ctx);
            break;
          default:
            // idle/planning are never re-entered once the loop is running.
            state = { phase: "error", message: `Unexpected state: ${state.phase}` };
        }
      }
      this.setState(state);
      this.finishTerminal(state);
    } finally {
      this.running = false;
    }
  }

  // ---- State handlers ---------------------------------------------------------

  /**
   * PLANNING: decompose a fresh goal into phases, but preserve an in-progress
   * plan. Re-plan when there is no plan yet OR the previous plan is fully
   * completed/failed (a brand-new follow-up task). When phases are still
   * pending/in_progress (e.g. resuming after "stuck"), keep the existing plan
   * and continue it. Also fixes this run's dynamic iteration cap (IMP-04).
   */
  private async handlePlanning(task: string, ctx: RunContext): Promise<void> {
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

      // IMP-09: few-shot from past successes — surface up to two stored
      // success patterns for similar tasks as guidance. Gated on a session
      // manager (real runs) so ephemeral/test loops neither read nor learn.
      if (this.sessionManager) {
        try {
          const hits = await this.longTerm.recallHybrid(task, 3, { tag: "success_pattern" });
          const top = hits.slice(0, 2);
          if (top.length > 0) {
            const blocks = top.map(
              (hit, i) => `${i + 1}. ${this.longTerm.read(hit.id) ?? hit.excerpt}`,
            );
            this.session.add({
              role: "system",
              content:
                "Past successful approaches to similar tasks (guidance — adapt as needed):\n" +
                blocks.join("\n"),
              timestamp: new Date(),
            });
          }
        } catch {
          // Few-shot guidance is best-effort; planning proceeds without it.
        }
      }
    }
    ctx.maxIterations = resolveMaxIterations(this.phases.length);
  }

  /**
   * THINKING: one provider turn. Enforces the iteration cap and budget, compacts
   * oversized context (IMP-03), asks the provider, and routes the parsed turn to
   * the next state: executing (tool actions), verifying (done + self-check on),
   * a terminal state, or back to thinking (plan updates / recoverable parse
   * failures).
   */
  private async handleThinking(ctx: RunContext): Promise<LoopState> {
    ctx.iterationsUsed += 1;
    if (ctx.iterationsUsed > ctx.maxIterations) {
      return {
        phase: "stuck",
        reason:
          `Reached the maximum of ${ctx.maxIterations} steps without finishing. ` +
          `Let me know how you'd like to proceed.`,
      };
    }

    // Budget gate: stop BEFORE the next provider call once the estimated
    // session cost has reached the configured limit (0 = unlimited).
    this.usage.budgetUsd = getConfig().budgetUsd;
    if (this.usage.overBudget()) {
      const totals = this.usage.get();
      return {
        phase: "stuck",
        reason:
          `Budget limit reached: estimated cost ~$${totals.costUsd.toFixed(2)} of the ` +
          `$${this.usage.budgetUsd.toFixed(2)} budget (${totals.calls} provider calls). ` +
          `Raise "budgetUsd" in settings (or set it to 0) to continue.`,
      };
    }

    // IMP-03: compact the history when it approaches the context budget, then
    // IMP-20: prune stale, low-relevance tool observations against the current
    // goal + active phase so the recent/relevant context stays verbatim.
    this.session.compactIfNeeded();
    const activePhase = this.phases.find((p) => p.status === "in_progress");
    const focus = `${this.goal} ${activePhase ? `${activePhase.title} ${activePhase.description}` : ""}`.trim();
    if (focus.length > 0) {
      this.session.pruneToolResults(focus);
    }

    // IMP-18: the action loop runs on the FAST provider when routing is enabled;
    // planning and verification keep using the smart provider. Vision capability
    // is read from whichever provider will actually make this call.
    const provider = this.fastProvider ?? this.provider;
    const useVision = provider.supportsVision && getConfig().enableVision;
    const request = buildGenerateRequest({
      agentMd: this.agentMemory.getContent(),
      workspacePath: this.workspacePath,
      history: this.session.getHistory(),
      now: new Date(),
      phases: this.phases,
      images: useVision && this.pendingImages.length > 0 ? this.pendingImages : undefined,
      // IMP-08: recite the accumulated task state in the volatile final turn.
      workingMemory: this.workingMemory.isEmpty() ? undefined : this.workingMemory.render(),
      // IMP-31: a spawned child only sees its scoped tool set.
      allowedActions: this.allowedActions,
    });
    // Screenshots are shown once: clear them whether or not vision is on, so
    // they never accumulate across turns.
    this.pendingImages = [];

    let result: GenerateResult;
    const span = this.tracer.startSpan("provider.generate", {
      provider: provider.name,
      iteration: ctx.iterationsUsed,
      routed: provider !== this.provider,
    });
    try {
      result = await provider.generate(request);
    } catch (err) {
      span.end({ error: errMessage(err) });
      return { phase: "error", message: `Provider call failed: ${errMessage(err)}` };
    }
    span.end({
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      toolCalls: result.toolCalls.length,
    });
    this.trackUsage(result, provider);

    // ---- Resolve the turn: native tool call(s), else parsed JSON text --------
    const parsed = turnFromResult(result);
    if ("error" in parsed) {
      const outcome = ctx.corrector.recordFailure("parse");
      const note =
        `Your previous turn did not produce a valid action (${parsed.error}). ` +
        `Call exactly one of the available tools to take the next step (or, if your ` +
        `model has no tools, reply with the single JSON action object).`;
      this.session.add({ role: "tool_result", content: note, timestamp: new Date() });
      if (outcome.giveUp) {
        return {
          phase: "error",
          message:
            `Provider did not return a usable action after ${outcome.attempt} attempts. ` +
            `Last text: ${truncate(result.text, 500)}`,
        };
      }
      // Self-healing: back off before re-prompting after a malformed reply.
      if (outcome.backoffMs > 0) {
        await delay(outcome.backoffMs);
      }
      return { phase: "thinking", iteration: ctx.iterationsUsed + 1 };
    }

    const turn = parsed.value;
    // Record the assistant turn verbatim so the model sees its own history.
    this.session.add({
      role: "assistant",
      content: serializeTurn(turn),
      timestamp: new Date(),
    });

    if (turn.thought.length > 0) {
      this.emit("thought", turn.thought);
    }

    // ---- Plan progress (the "progress" field and/or update_plan actions) -----
    if (turn.progress) {
      this.applyProgress(turn.progress);
    }
    const planUpdates = turn.actions.filter((a) => a.action === "update_plan");
    for (const update of planUpdates) {
      this.applyUpdatePlanAction(update.params);
    }

    // ---- Working-memory notes (IMP-08): apply and persist -----------------------
    let noted = 0;
    for (const note of turn.actions.filter((a) => a.action === "note")) {
      noted += this.workingMemory.applyNote(note.params);
    }
    if (noted > 0) {
      this.persistState();
    }

    const terminal = turn.actions.find((a) => a.action === "done" || a.action === "stuck");
    const tools = turn.actions.filter((a) => isToolAction(a.action));

    if (turn.message && turn.message.length > 0 && !terminal) {
      this.emit("message", turn.message);
    }

    // ---- Terminal actions -----------------------------------------------------
    if (terminal && tools.length > 0) {
      // Mixed turn: run the tools; the premature terminal is dropped with a note
      // so the model finishes only after observing the results.
      this.session.add({
        role: "system",
        content:
          `You combined "${terminal.action}" with tool actions in one turn. The tools were ` +
          `executed; issue "${terminal.action}" alone once you have confirmed their results.`,
        timestamp: new Date(),
      });
    } else if (terminal) {
      if (terminal.action === "stuck") {
        return {
          phase: "stuck",
          reason:
            terminal.message ?? turn.message ?? "I'm stuck and need more information to continue.",
        };
      }
      // "done": verify before accepting (IMP-05), bounded by MAX_REFLECTIONS.
      ctx.pendingDoneMessage = terminal.message ?? turn.message ?? "Task complete.";
      if (
        getConfig().enableReflection &&
        this.goal.trim().length > 0 &&
        ctx.reflectionCount < MAX_REFLECTIONS
      ) {
        return { phase: "verifying", round: ctx.reflectionCount + 1 };
      }
      return { phase: "done", message: ctx.pendingDoneMessage };
    }

    if (tools.length === 0) {
      // Only plan updates this turn — take the next thinking turn.
      return { phase: "thinking", iteration: ctx.iterationsUsed + 1 };
    }

    ctx.pendingActions = tools;
    const first = tools[0];
    return {
      phase: "executing",
      toolName: tools.length === 1 && first ? first.action : `${tools.length} parallel actions`,
      iteration: ctx.iterationsUsed,
    };
  }

  /**
   * EXECUTING: run this turn's tool actions. Permission/approval gates are
   * applied per action, sequentially (prompts must not overlap). Approved
   * actions then execute — independent actions in PARALLEL (IMP-02), except
   * browser actions, which share one page and therefore run in order among
   * themselves. Results are observed in the original action order.
   */
  private async handleExecuting(ctx: RunContext): Promise<LoopState> {
    const actions = ctx.pendingActions;
    ctx.pendingActions = [];
    const cfg = getConfig();

    interface Slot {
      action: TurnAction;
      /** Set when a gate blocked/denied the action (fed back, not a failure). */
      blockedNote?: string;
      result?: ToolResult;
      /** IMP-27: file content captured BEFORE a filesystem write, for the diff. */
      preWrite?: string;
    }
    const slots: Slot[] = [];

    // ---- Gates, in order (announce every proposed action first) --------------
    for (const a of actions) {
      this.emit("toolCall", { tool: a.action, params: a.params });

      // Edit gate: block file mutations when the user disabled "Suggest
      // edits". read/list are always allowed. A block is NOT a failure, so
      // we feed a note and continue without touching the corrector.
      if (a.action === "filesystem") {
        const op = typeof a.params.operation === "string" ? a.params.operation : "";
        if (!cfg.permSuggestEdits && (op === "write" || op === "delete" || op === "mkdir")) {
          const note =
            "[filesystem] BLOCKED: file edits are turned off in your permissions " +
            '("Suggest edits" is off). Re-enable it in /settings to allow changes, ' +
            "or proceed without editing files.";
          this.emit("toolResult", { tool: a.action, result: note, success: false });
          slots.push({ action: a, blockedNote: note });
          continue;
        }
      }

      // Approval gate: pause RISKY actions for user approval in interactive
      // mode — a shell command, or code run via a real interpreter (python/
      // node/bash/powershell; the "js" sandbox is contained and exempt).
      // Both have full system access. With no handler registered (headless /
      // Telegram-only) the loop never pauses and stays fully autonomous. A
      // denial is NOT a failure, so we feed a note and continue without
      // touching the corrector.
      const codeLang =
        a.action === "code"
          ? typeof a.params.language === "string"
            ? a.params.language
            : "js"
          : null;
      const codeOp =
        a.action === "code" && typeof a.params.operation === "string"
          ? a.params.operation
          : "run";
      // installDeps/runTests shell out to npm/pip/test runners — same risk
      // class as shell, so they go through the same approval gate.
      const isRiskyCode =
        a.action === "code" &&
        ((codeLang !== null && codeLang !== "js") || codeOp === "installDeps" || codeOp === "runTests");
      if (
        cfg.requireCommandApproval &&
        this.approvalHandler &&
        (a.action === "shell" || isRiskyCode)
      ) {
        const summary =
          a.action === "shell"
            ? typeof a.params.command === "string"
              ? a.params.command
              : stableStringify(a.params)
            : codeOp !== "run"
              ? `${codeOp}: ${stableStringify(a.params)}`
              : `${codeLang}: ${typeof a.params.code === "string" ? a.params.code : stableStringify(a.params)}`;
        let approved = false;
        try {
          approved = await this.approvalHandler({ tool: a.action, summary });
        } catch {
          approved = false;
        }
        if (!approved) {
          const note =
            `[${a.action}] DENIED by the user. It was NOT run. Choose a different ` +
            'approach, or explain what you need and use action "stuck" if you cannot proceed.';
          this.emit("toolResult", {
            tool: a.action,
            result: "Action denied by the user.",
            success: false,
          });
          slots.push({ action: a, blockedNote: note });
          continue;
        }
      }

      const slot: Slot = { action: a };
      // IMP-27: capture the file's current content before a write so we can
      // emit an old→new diff after it succeeds ("" when the file is new).
      if (a.action === "filesystem" && a.params.operation === "write" && typeof a.params.path === "string") {
        const read = await executeTool("filesystem", { operation: "read", path: a.params.path });
        slot.preWrite = read.success ? read.result : "";
      }
      slots.push(slot);
    }

    // ---- Execute: browser actions serially (one shared page), rest parallel --
    const runnable = slots.filter((s) => s.blockedNote === undefined);
    const browserSlots = runnable.filter((s) => s.action.action === "browser");
    const parallelSlots = runnable.filter((s) => s.action.action !== "browser");
    // IMP-15 + IMP-24: stream incremental output to the UI and trace each run.
    const runOne = async (s: (typeof slots)[number]): Promise<void> => {
      const toolSpan = this.tracer.startSpan(`tool.${s.action.action}`);
      // IMP-31: `spawn` runs a child agent rather than a registry tool.
      s.result =
        s.action.action === "spawn"
          ? await this.runChildAgent(s.action.params)
          : await executeTool(s.action.action, s.action.params, {
              onChunk: (chunk) => this.emit("toolChunk", { tool: s.action.action, chunk }),
            });
      toolSpan.end({ success: s.result.success });
    };
    const work: Promise<void>[] = parallelSlots.map(runOne);
    work.push(
      (async () => {
        for (const s of browserSlots) {
          await runOne(s);
        }
      })(),
    );
    await Promise.all(work);

    // ---- Observe, in the original action order --------------------------------
    let anySuccess = false;
    let giveUp: { action: ActionName; error: string } | null = null;
    let maxBackoffMs = 0;
    for (const s of slots) {
      if (s.blockedNote !== undefined) {
        this.session.add({ role: "tool_result", content: s.blockedNote, timestamp: new Date() });
        continue;
      }
      const result = s.result ?? { success: false, result: "", error: "Tool produced no result." };
      this.emit("toolResult", {
        tool: s.action.action,
        result: result.success ? result.result : result.error ?? "Unknown error",
        success: result.success,
      });

      if (result.success) {
        anySuccess = true;
        this.session.add({
          role: "tool_result",
          content: `[${s.action.action}] ${compressObservation(result.result)}`,
          timestamp: new Date(),
        });
        // Vision: queue a screenshot so the model can see it next turn.
        if (s.action.action === "browser" && s.action.params.operation === "screenshot") {
          this.queueScreenshot(result.result);
        }
        // IMP-27: emit an inline diff for a filesystem write.
        if (
          s.action.action === "filesystem" &&
          s.action.params.operation === "write" &&
          s.preWrite !== undefined &&
          typeof s.action.params.path === "string"
        ) {
          const newText = typeof s.action.params.content === "string" ? s.action.params.content : "";
          const diff = computeUnifiedDiff(s.preWrite, newText, s.action.params.path);
          if (diff.length > 0) {
            this.emit("fileDiff", { path: s.action.params.path, diff });
          }
        }
        // IMP-08: auto-track produced artifacts in working memory.
        this.trackArtifact(s.action, result.result);
      } else {
        const signature = `${s.action.action}:${stableStringify(s.action.params)}`;
        const outcome = ctx.corrector.recordFailure(signature);
        const errorText = result.error ?? "Unknown error";
        this.session.add({
          role: "tool_result",
          content:
            `[${s.action.action}] FAILED (attempt ${outcome.attempt}/3): ${errorText}. ` +
            `Adjust your approach or fix the parameters and try again.`,
          timestamp: new Date(),
        });
        if (outcome.giveUp) {
          giveUp = { action: s.action.action, error: errorText };
        } else if (outcome.backoffMs > maxBackoffMs) {
          maxBackoffMs = outcome.backoffMs;
        }
      }
    }

    if (giveUp !== null) {
      // IMP-06: instead of giving up immediately, try to dynamically REPLAN the
      // remaining work around the failure (bounded by MAX_REPLANS). Only when
      // replanning is exhausted or itself fails do we surface "stuck".
      if (ctx.replanCount < MAX_REPLANS) {
        const replanned = await this.attemptReplan(giveUp.action, giveUp.error);
        if (replanned) {
          ctx.replanCount += 1;
          ctx.corrector.reset();
          return { phase: "thinking", iteration: ctx.iterationsUsed + 1 };
        }
      }
      return {
        phase: "stuck",
        reason:
          `The ${giveUp.action} step failed 3 times in a row: ${giveUp.error}. ` +
          `I need your help to proceed.`,
      };
    }
    if (anySuccess && maxBackoffMs === 0) {
      // A fully (or partially-without-repeat-failure) successful step clears
      // the failure streak, exactly like the single-action loop did.
      ctx.corrector.reset();
    }
    // Self-healing: wait with exponential back-off before the next try so
    // transient failures (rate limits, races, flaky network) can clear.
    if (maxBackoffMs > 0) {
      await delay(maxBackoffMs);
    }
    return { phase: "thinking", iteration: ctx.iterationsUsed + 1 };
  }

  /**
   * VERIFYING (IMP-05): before accepting "done", run a bounded checking pass.
   * The reviewer model may inspect the actual results with READ-ONLY filesystem
   * operations (read/list/grep/find/diff — at most MAX_VERIFY_TOOL_STEPS), then
   * must deliver a verdict. An incomplete verdict feeds the gap back and the
   * loop keeps working; any ambiguity is biased toward accepting "done" so a
   * confused critic can never trap the agent.
   */
  private async handleVerifying(ctx: RunContext): Promise<LoopState> {
    const verdict = await this.verifyCompletion();
    if (verdict && !verdict.complete) {
      ctx.reflectionCount += 1;
      const note =
        `Self-check (${ctx.reflectionCount}/${MAX_REFLECTIONS}): the goal is NOT fully complete yet. ` +
        `${verdict.reason}${verdict.nextStep ? ` Next: ${verdict.nextStep}` : ""} ` +
        `Keep working — do not stop until it is genuinely done.`;
      this.emit("thought", note);
      this.session.add({ role: "system", content: note, timestamp: new Date() });
      return { phase: "thinking", iteration: ctx.iterationsUsed + 1 };
    }
    return { phase: "done", message: ctx.pendingDoneMessage };
  }

  /**
   * The verification mini-loop: ask the reviewer; execute its read-only
   * filesystem requests (collecting observations); return its verdict. Returns
   * null on any failure or when no verdict arrives within the step budget —
   * the caller then accepts "done" rather than blocking.
   */
  private async verifyCompletion(): Promise<Reflection | null> {
    const observations: string[] = [];
    try {
      for (let step = 0; step <= MAX_VERIFY_TOOL_STEPS; step += 1) {
        const request = buildReflectionRequest({
          agentMd: this.agentMemory.getContent(),
          workspacePath: this.workspacePath,
          goal: this.goal,
          history: this.session.getHistory(),
          observations,
        });
        const result = await this.provider.generate(request);
        this.trackUsage(result);

        // Native verdict tool call.
        const verdictCall = result.toolCalls.find((c) => c.name === "verdict");
        if (verdictCall) {
          return reflectionFromArgs(verdictCall.arguments);
        }
        // Native read-only filesystem call.
        const fsCall = result.toolCalls.find((c) => c.name === "filesystem");
        if (fsCall && step < MAX_VERIFY_TOOL_STEPS) {
          observations.push(await this.runVerificationFs(fsCall.arguments));
          continue;
        }

        const text = result.text.trim();
        if (text.length === 0) {
          return null;
        }
        // Text models: a JSON filesystem action means "let me check first".
        const asAction = tryParseActionObject(text);
        if (asAction !== null && step < MAX_VERIFY_TOOL_STEPS) {
          if (asAction.action === "filesystem") {
            observations.push(await this.runVerificationFs(asAction.params));
          } else {
            observations.push(
              `[verification] Only read-only filesystem operations (${VERIFY_READONLY_OPS.join(", ")}) ` +
                `are available while checking. Deliver the JSON verdict when ready.`,
            );
          }
          continue;
        }
        return parseReflection(text);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Execute one read-only filesystem request for the verification pass. */
  private async runVerificationFs(params: Record<string, unknown>): Promise<string> {
    const op = typeof params.operation === "string" ? params.operation : "";
    if (!(VERIFY_READONLY_OPS as readonly string[]).includes(op)) {
      return (
        `[verification] The "${op}" operation is not allowed while checking — ` +
        `only ${VERIFY_READONLY_OPS.join(", ")} are.`
      );
    }
    const result = await executeTool("filesystem", params);
    const body = result.success ? result.result : `FAILED: ${result.error ?? "Unknown error"}`;
    return `[verify filesystem ${op}] ${compressObservation(body, 3000)}`;
  }

  /**
   * IMP-09: after a completed task, store a compact "success pattern" (goal +
   * the tool sequence that worked) tagged `success_pattern`, so future similar
   * tasks get it back as few-shot guidance. Gated on a session manager (real
   * runs only) and on the task having taken at least two real tool steps.
   */
  private async recordSuccessPattern(): Promise<void> {
    if (!this.sessionManager || this.goal.trim().length === 0) {
      return;
    }
    const sequence: string[] = [];
    for (const message of this.session.getHistory()) {
      if (message.role !== "assistant") {
        continue;
      }
      try {
        const obj = JSON.parse(message.content) as {
          action?: unknown;
          actions?: Array<{ action?: unknown }>;
        };
        if (typeof obj.action === "string") {
          sequence.push(obj.action);
        } else if (Array.isArray(obj.actions)) {
          for (const a of obj.actions) {
            if (typeof a.action === "string") {
              sequence.push(a.action);
            }
          }
        }
      } catch {
        // Non-JSON assistant content carries no action — skip.
      }
    }
    const toolSequence = sequence.filter((a) => isActionName(a) && isToolAction(a));
    if (toolSequence.length < 2 || toolSequence.length > 40) {
      return;
    }
    const content =
      `Task: ${truncate(this.goal, 300)}\n` +
      `Successful approach (${toolSequence.length} steps): ${toolSequence.join(" → ")}`;
    await this.longTerm.rememberWithEmbedding(content, ["success_pattern"], 6);
  }

  /**
   * IMP-31: run a focused sub-task in a CHILD agent and return its result as a
   * tool observation. The child shares this workspace, long-term memory, and
   * provider(s) but gets a FRESH session memory (isolated context) and no
   * persistence. Depth-bounded (a child cannot spawn past MAX_SPAWN_DEPTH) and
   * iteration-capped. The child inherits this loop's approval handler so risky
   * actions it takes are still gated. Never throws.
   */
  private async runChildAgent(params: Record<string, unknown>): Promise<ToolResult> {
    if (this.spawnDepth >= MAX_SPAWN_DEPTH) {
      return {
        success: false,
        result: "",
        error: `Cannot spawn: maximum sub-agent nesting depth (${MAX_SPAWN_DEPTH}) reached. Do this work yourself.`,
      };
    }
    const task = typeof params.task === "string" ? params.task.trim() : "";
    if (task.length === 0) {
      return { success: false, result: "", error: 'spawn requires a non-empty "task" string.' };
    }
    const allowed = Array.isArray(params.tools)
      ? params.tools.filter((t): t is string => typeof t === "string")
      : undefined;

    const span = this.tracer.startSpan("spawn.child", { depth: this.spawnDepth + 1 });
    const child = new AgentLoop(this.provider, new SessionMemory(), this.agentMemory, {
      spawnDepth: this.spawnDepth + 1,
      ...(allowed && allowed.length > 0 ? { allowedActions: allowed } : {}),
      ...(this.fastProvider ? { fastProvider: this.fastProvider } : {}),
      longTermMemory: this.longTerm,
    });
    // Cap the child's effort regardless of how it plans.
    const prevCap = process.env.OPENAGENT_MAX_ITERATIONS;
    process.env.OPENAGENT_MAX_ITERATIONS = String(CHILD_MAX_ITERATIONS);
    // The child inherits the approval gate so its risky actions still prompt.
    if (this.approvalHandler) {
      child.setApprovalHandler(this.approvalHandler);
    }
    // Surface the child's activity to the parent UI as streaming chunks.
    child.on("toolCall", (d) => this.emit("toolChunk", { tool: "spawn", chunk: `↳ ${d.tool}` }));

    let finalMessage = "";
    let outcome: "done" | "stuck" | "error" = "done";
    child.on("done", (m) => { finalMessage = m; outcome = "done"; });
    child.on("stuck", (m) => { finalMessage = m; outcome = "stuck"; });
    child.on("error", (m) => { finalMessage = m; outcome = "error"; });

    try {
      await child.run(task);
    } catch (err) {
      span.end({ outcome: "error" });
      return { success: false, result: "", error: `Sub-agent crashed: ${errMessage(err)}` };
    } finally {
      if (prevCap === undefined) {
        delete process.env.OPENAGENT_MAX_ITERATIONS;
      } else {
        process.env.OPENAGENT_MAX_ITERATIONS = prevCap;
      }
    }
    span.end({ outcome });

    if (outcome === "done") {
      return { success: true, result: `Sub-agent completed the task.\nResult: ${finalMessage}` };
    }
    return {
      success: false,
      result: "",
      error: `Sub-agent did not finish (${outcome}): ${finalMessage}`,
    };
  }

  /**
   * IMP-06: rewrite the REMAINING plan around a stuck step. Keeps completed
   * phases, asks the (smart) provider for fresh phases that route around the
   * failure, and splices them in as the new pending work. Returns true when the
   * plan was actually rewritten. Never throws — any failure returns false so
   * the caller falls back to "stuck".
   */
  private async attemptReplan(failedAction: string, error: string): Promise<boolean> {
    if (this.goal.trim().length === 0) {
      return false;
    }
    const completed = this.phases.filter((p) => p.status === "completed");
    const failedPhase = this.phases.find((p) => p.status === "in_progress");
    let fresh: Phase[];
    try {
      fresh = await this.planner.replan(
        {
          goal: this.goal,
          completed: completed.map((p) => p.title),
          failedPhase: failedPhase ? failedPhase.title : `${failedAction} step`,
          error,
        },
        this.provider,
      );
    } catch {
      return false;
    }
    if (fresh.length === 0) {
      return false;
    }
    // Keep completed phases; renumber the fresh phases after them and mark the
    // first one in_progress so the loop picks it up next turn.
    const kept = completed.map((p, i) => ({ ...p, id: i + 1 }));
    const offset = kept.length;
    const replanned: Phase[] = fresh.map((p, i) => ({
      ...p,
      id: offset + i + 1,
      status: i === 0 ? ("in_progress" as const) : ("pending" as const),
    }));
    this.phases = [...kept, ...replanned];
    this.emit("phaseUpdate", this.plan);
    this.session.add({
      role: "system",
      content:
        `Replanned after a stuck step (${failedAction}: ${truncate(error, 200)}). ` +
        `The remaining plan was rewritten — continue with the new phases.`,
      timestamp: new Date(),
    });
    this.persistState();
    return true;
  }

  /** Emit the terminal event(s) for the final state and persist. */
  private finishTerminal(state: LoopState): void {
    if (state.phase === "done") {
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
      // IMP-09: learn from this success (fire-and-forget; never blocks "done").
      void this.recordSuccessPattern().catch(() => undefined);
      this.emit("done", state.message);
    } else if (state.phase === "stuck") {
      this.persistState();
      this.emit("stuck", state.reason);
    } else if (state.phase === "error") {
      this.emit("error", state.message);
    }
  }
}

// Turn parsing/serialization + shared utilities live in ./turn.ts (IMP-34).
// Re-export parseAgentResponse so existing importers of loop.ts keep working.
export { parseAgentResponse } from "./turn.js";
export { turnFromResult };
