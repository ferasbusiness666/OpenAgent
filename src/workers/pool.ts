import os from "node:os";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  WorkerJob,
  WorkerLimits,
  WorkerMessage,
  WorkerResult,
  WorkerStatus,
} from "./types.js";

/** Strongly-typed event payloads emitted by the WorkerPool. */
export interface WorkerPoolEvents {
  jobQueued: (s: WorkerStatus) => void;
  jobStarted: (s: WorkerStatus) => void;
  jobProgress: (s: WorkerStatus) => void;
  jobDone: (r: WorkerResult) => void;
  jobFailed: (r: WorkerResult) => void;
  snapshot: (all: WorkerStatus[]) => void;
}

// Typed on/once/off/emit overlay over Node's EventEmitter (no `any`).
export declare interface WorkerPool {
  on<K extends keyof WorkerPoolEvents>(
    event: K,
    listener: WorkerPoolEvents[K],
  ): this;
  once<K extends keyof WorkerPoolEvents>(
    event: K,
    listener: WorkerPoolEvents[K],
  ): this;
  off<K extends keyof WorkerPoolEvents>(
    event: K,
    listener: WorkerPoolEvents[K],
  ): this;
  emit<K extends keyof WorkerPoolEvents>(
    event: K,
    ...args: Parameters<WorkerPoolEvents[K]>
  ): boolean;
}

/** URL of the worker entry script, resolved relative to this module. */
const workerUrl = new URL("./worker-entry.mjs", import.meta.url);

/** Most recent N statuses retained in the live map / surfaced via snapshots. */
const MAX_TRACKED_STATUSES = 50;

/** An enqueued job plus the resolver for its pending promise. */
interface PendingJob {
  job: WorkerJob;
  resolve: (result: WorkerResult) => void;
}

/**
 * Narrow an arbitrary worker message payload to the {@link WorkerMessage}
 * union. Returns `null` for anything that doesn't match, so the pool can
 * safely ignore malformed posts without casting through `any`.
 */
function parseWorkerMessage(value: unknown): WorkerMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "progress") {
    if (typeof record.detail !== "string") return null;
    return { type: "progress", detail: record.detail };
  }
  if (record.type === "result") {
    if (typeof record.success !== "boolean") return null;
    if (typeof record.output !== "string") return null;
    const engine = record.engine;
    if (engine !== "isolated-vm" && engine !== "vm" && engine !== "shell") {
      return null;
    }
    const error =
      typeof record.error === "string" ? record.error : undefined;
    return {
      type: "result",
      success: record.success,
      output: record.output,
      error,
      engine,
    };
  }
  return null;
}

/**
 * WorkerPool — dispatches {@link WorkerJob}s to a bounded set of Node worker
 * threads, tracks their live {@link WorkerStatus}, enforces per-job timeouts,
 * and resolves a {@link WorkerResult} for each. Emits typed lifecycle events so
 * a UI can render workers in flight.
 */
export class WorkerPool extends EventEmitter {
  private readonly maxWorkers: number;
  private readonly limits: WorkerLimits;

  /** Insertion-ordered live status of every tracked job. */
  private readonly statuses = new Map<string, WorkerStatus>();
  /** Live workers keyed by job id, for shutdown / termination. */
  private readonly liveWorkers = new Map<string, Worker>();
  /** Per-job timeout timers, cleared on finalize. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private readonly queue: PendingJob[] = [];
  private active = 0;

  constructor(options?: {
    maxWorkers?: number;
    limits?: Partial<WorkerLimits>;
  }) {
    super();
    this.maxWorkers =
      options?.maxWorkers ?? Math.max(2, Math.min(4, os.cpus().length));
    this.limits = {
      maxOldGenerationSizeMb: options?.limits?.maxOldGenerationSizeMb ?? 128,
      maxYoungGenerationSizeMb:
        options?.limits?.maxYoungGenerationSizeMb ?? 32,
      defaultTimeoutMs: options?.limits?.defaultTimeoutMs ?? 30000,
    };
  }

  /**
   * Submit a job to the pool. Assigns an id if absent, tracks it as "queued",
   * and resolves once the job completes, fails, or times out. Never rejects —
   * failures are reported via {@link WorkerResult.success}.
   */
  run(
    job: Omit<WorkerJob, "id"> & { id?: string },
  ): Promise<WorkerResult> {
    const id = job.id ?? randomUUID();
    const fullJob: WorkerJob = { ...job, id };

    const status: WorkerStatus = {
      jobId: id,
      kind: fullJob.kind,
      label: makeLabel(fullJob.source),
      state: "queued",
    };
    this.trackStatus(status);
    this.emit("jobQueued", { ...status });
    this.emitSnapshot();

    return new Promise<WorkerResult>((resolve) => {
      this.queue.push({ job: fullJob, resolve });
      this.pump();
    });
  }

  /** Snapshot copy of the most-recent tracked statuses (insertion order). */
  getStatuses(): WorkerStatus[] {
    return Array.from(this.statuses.values()).map((s) => ({ ...s }));
  }

  /** Terminate all live workers and clear all timers. */
  async shutdown(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    const terminations: Array<Promise<number>> = [];
    for (const worker of this.liveWorkers.values()) {
      terminations.push(worker.terminate());
    }
    this.liveWorkers.clear();
    this.queue.length = 0;
    this.active = 0;
    await Promise.allSettled(terminations);
  }

  /** Insert/replace a status, capping retention to the most recent N. */
  private trackStatus(status: WorkerStatus): void {
    this.statuses.set(status.jobId, status);
    while (this.statuses.size > MAX_TRACKED_STATUSES) {
      const oldest = this.statuses.keys().next().value;
      if (oldest === undefined) break;
      this.statuses.delete(oldest);
    }
  }

  private emitSnapshot(): void {
    this.emit("snapshot", this.getStatuses());
  }

  /** Start queued jobs until `maxWorkers` are active. */
  private pump(): void {
    while (this.active < this.maxWorkers && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.active += 1;
      this.start(next);
    }
  }

  /** Spawn a worker for one pending job and wire up its lifecycle. */
  private start(pending: PendingJob): void {
    const { job, resolve } = pending;
    const startedAt = Date.now();
    const timeoutMs = job.timeoutMs ?? this.limits.defaultTimeoutMs;

    const status = this.statuses.get(job.id);
    if (status) {
      status.state = "running";
      status.startedAt = startedAt;
      this.emit("jobStarted", { ...status });
      this.emitSnapshot();
    }

    let settled = false;

    const worker = new Worker(workerUrl, {
      workerData: job,
      resourceLimits: {
        maxOldGenerationSizeMb: this.limits.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: this.limits.maxYoungGenerationSizeMb,
      },
    });
    this.liveWorkers.set(job.id, worker);

    const finalize = (result: Omit<WorkerResult, "durationMs">): void => {
      if (settled) return;
      settled = true;

      const timer = this.timers.get(job.id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(job.id);
      }

      const finalResult: WorkerResult = {
        ...result,
        durationMs: Date.now() - startedAt,
      };

      const current = this.statuses.get(job.id);
      if (current) {
        current.state = finalResult.success ? "completed" : "failed";
        current.endedAt = Date.now();
        if (finalResult.error) current.detail = finalResult.error;
      }

      this.liveWorkers.delete(job.id);
      void worker.terminate();

      this.emit(finalResult.success ? "jobDone" : "jobFailed", finalResult);
      this.emitSnapshot();

      this.active -= 1;
      this.pump();

      resolve(finalResult);
    };

    const timer = setTimeout(() => {
      finalize({
        jobId: job.id,
        success: false,
        output: "",
        error: `timed out after ${timeoutMs}ms`,
        engine: job.kind === "shell" ? "shell" : "vm",
      });
    }, timeoutMs);
    this.timers.set(job.id, timer);

    worker.on("message", (raw: unknown) => {
      const message = parseWorkerMessage(raw);
      if (!message) return;
      if (message.type === "progress") {
        const current = this.statuses.get(job.id);
        if (current) {
          current.detail = message.detail;
          this.emit("jobProgress", { ...current });
          this.emitSnapshot();
        }
        return;
      }
      // message.type === "result"
      finalize({
        jobId: job.id,
        success: message.success,
        output: message.output,
        error: message.error,
        engine: message.engine,
      });
    });

    worker.on("error", (err: Error) => {
      finalize({
        jobId: job.id,
        success: false,
        output: "",
        error: err.message,
        engine: job.kind === "shell" ? "shell" : "vm",
      });
    });

    worker.on("exit", (code: number) => {
      if (settled) return;
      finalize({
        jobId: job.id,
        success: false,
        output: "",
        error: `worker exited with code ${code} before producing a result`,
        engine: job.kind === "shell" ? "shell" : "vm",
      });
    });
  }
}

/** Build a short, single-line label from a job's source. */
function makeLabel(source: string): string {
  const oneLine = source.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}

// ---- Lazy process-wide singleton -------------------------------------------

let singleton: WorkerPool | null = null;

/** Return the shared, lazily-created process-wide pool. */
export function getWorkerPool(): WorkerPool {
  return (singleton ??= new WorkerPool());
}

/** Shut down and discard the shared pool, if one exists. */
export async function closeWorkerPool(): Promise<void> {
  if (singleton) {
    await singleton.shutdown();
    singleton = null;
  }
}
