/**
 * run-store.ts — the file-based registry for background ("detached") runs.
 *
 * Phase B (async / long-running): a task can execute in a separate, detached
 * process that outlives the TUI. That process can't share the in-memory
 * EventEmitter with an attached UI, so it streams its lifecycle to disk instead:
 *
 *   <RUNS_DIR>/<runId>.json   the RunRecord (task, status, pid, timestamps)
 *   <RUNS_DIR>/<runId>.log    the event stream as JSON-lines (one RunEvent/line)
 *
 * A UI (or `openagent attach`) lists records and tails the log to follow a run.
 * Everything is best-effort and never throws — a background run must not die
 * over a transient FS hiccup, and a reader must tolerate a half-written line.
 *
 * The directory is RUNS_DIR by default, overridable via the OPENAGENT_RUNS_DIR
 * environment variable (used by tests, and inherited by the detached child).
 */

import path from "node:path";
import fs from "fs-extra";
import { RUNS_DIR, ensureDataDir } from "../paths.js";

/** Terminal + in-flight states a background run can be in. */
export type RunStatus = "running" | "done" | "stuck" | "error";

/** Durable metadata for one background run. */
export interface RunRecord {
  runId: string;
  task: string;
  /** Workspace the run operates in. */
  projectPath: string;
  /** Resumable AgentState session id (see SessionManager). */
  sessionId: string;
  status: RunStatus;
  /** OS pid of the detached worker, when known. */
  pid?: number;
  startedAt: string; // ISO
  endedAt?: string; // ISO
  /** Final done/stuck/error message. */
  finalMessage?: string;
}

/** One streamed lifecycle event (mirrors the AgentLoop events). */
export interface RunEvent {
  ts: string; // ISO
  type:
    | "thought"
    | "toolCall"
    | "toolResult"
    | "message"
    | "done"
    | "stuck"
    | "error"
    | "plan"
    | "phaseUpdate";
  data: unknown;
}

/** Input needed to register a new run (status/startedAt are filled in). */
export interface NewRun {
  runId: string;
  task: string;
  projectPath: string;
  sessionId: string;
  pid?: number;
}

/** File-backed registry of background runs. Best-effort: never throws. */
export class RunStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir =
      dir ??
      (process.env.OPENAGENT_RUNS_DIR && process.env.OPENAGENT_RUNS_DIR.trim().length > 0
        ? process.env.OPENAGENT_RUNS_DIR.trim()
        : RUNS_DIR);
  }

  /** Absolute path of a run's metadata file. */
  recordFile(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }

  /** Absolute path of a run's JSONL event log. */
  eventsFile(runId: string): string {
    return path.join(this.dir, `${runId}.log`);
  }

  private ensureDir(): void {
    try {
      if (this.dir === RUNS_DIR) {
        ensureDataDir();
      } else {
        fs.ensureDirSync(this.dir);
      }
    } catch {
      // Best-effort.
    }
  }

  /** Register a new run (status "running"). Returns the created record. */
  create(input: NewRun): RunRecord {
    const record: RunRecord = {
      runId: input.runId,
      task: input.task,
      projectPath: input.projectPath,
      sessionId: input.sessionId,
      status: "running",
      startedAt: new Date().toISOString(),
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
    };
    this.ensureDir();
    try {
      fs.writeJsonSync(this.recordFile(input.runId), record, { spaces: 2 });
    } catch {
      // Best-effort.
    }
    return record;
  }

  /** Read a run's record, or null when missing/corrupt. */
  get(runId: string): RunRecord | null {
    try {
      const raw: unknown = fs.readJsonSync(this.recordFile(runId));
      return isRunRecord(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  /** All runs, newest first by startedAt. Unreadable records are skipped. */
  list(): RunRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const rec = this.get(name.slice(0, -".json".length));
      if (rec) out.push(rec);
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out;
  }

  /** Merge a patch into a run's record (best-effort). */
  update(runId: string, patch: Partial<RunRecord>): void {
    const current = this.get(runId);
    if (!current) return;
    const next: RunRecord = { ...current, ...patch };
    try {
      fs.writeJsonSync(this.recordFile(runId), next, { spaces: 2 });
    } catch {
      // Best-effort.
    }
  }

  /** Append one event as a JSON line to the run's log (best-effort). */
  appendEvent(runId: string, event: RunEvent): void {
    this.ensureDir();
    try {
      fs.appendFileSync(this.eventsFile(runId), JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Best-effort.
    }
  }

  /** Read all events from a run's log, tolerant of a trailing half-written line. */
  readEvents(runId: string): RunEvent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.eventsFile(runId), "utf8");
    } catch {
      return [];
    }
    const out: RunEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRunEvent(parsed)) out.push(parsed);
      } catch {
        // Skip a partial/corrupt line (e.g. mid-write).
      }
    }
    return out;
  }
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "thought",
  "toolCall",
  "toolResult",
  "message",
  "done",
  "stuck",
  "error",
  "plan",
  "phaseUpdate",
]);

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === "string" &&
    typeof v.task === "string" &&
    typeof v.projectPath === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.status === "string" &&
    typeof v.startedAt === "string"
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ts === "string" && typeof v.type === "string" && EVENT_TYPES.has(v.type);
}
