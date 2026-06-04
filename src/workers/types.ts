/**
 * Type contracts for the multi-worker execution engine.
 *
 * The {@link WorkerPool} dispatches {@link WorkerJob}s to Node worker threads,
 * tracks their live {@link WorkerStatus}, and resolves a {@link WorkerResult}
 * for each. Worker threads communicate back to the parent exclusively via the
 * {@link WorkerMessage} discriminated union so the parent can narrow without
 * resorting to `any`.
 */

/** The two kinds of work a worker can perform. */
export type WorkerJobKind = "shell" | "js";

/** A unit of work submitted to the pool. */
export interface WorkerJob {
  id: string;
  kind: WorkerJobKind;
  /** For "shell": the command line. For "js": the JS source to evaluate. */
  source: string;
  /** Per-job wall-clock timeout (ms). Pool applies a default when omitted. */
  timeoutMs?: number;
  /** Working directory for "shell" jobs. */
  cwd?: string;
}

/** Resource + timeout limits applied to spawned worker threads. */
export interface WorkerLimits {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  defaultTimeoutMs: number;
}

/** Lifecycle state of a single job, surfaced to the UI. */
export type WorkerState = "queued" | "running" | "completed" | "failed";

/** Live, UI-facing status of a single job. */
export interface WorkerStatus {
  jobId: string;
  kind: WorkerJobKind;
  /** Short human label (truncated source). */
  label: string;
  state: WorkerState;
  startedAt?: number;
  endedAt?: number;
  /** Last progress line / error summary. */
  detail?: string;
}

/** Final outcome of a job, resolved from {@link WorkerPool.run}. */
export interface WorkerResult {
  jobId: string;
  success: boolean;
  /** stdout for shell; result value + console logs for js. */
  output: string;
  error?: string;
  durationMs: number;
  engine?: "isolated-vm" | "vm" | "shell";
}

/**
 * Messages a worker thread posts to the parent. Discriminated on `type` so the
 * parent can narrow an incoming `unknown` payload without casting.
 */
export type WorkerMessage =
  | { type: "progress"; detail: string }
  | {
      type: "result";
      success: boolean;
      output: string;
      error?: string;
      engine: "isolated-vm" | "vm" | "shell";
    };
