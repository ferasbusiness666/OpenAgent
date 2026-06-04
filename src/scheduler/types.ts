/**
 * types.ts — shared types for the file-based scheduling engine (Phase 4).
 *
 * A {@link Schedule} is a persisted, file-backed description of a recurring or
 * one-shot agent task. The {@link Scheduler} polls these and emits a "due"
 * event when a schedule's trigger fires.
 */

/**
 * The condition under which a schedule fires.
 *
 *  - "interval": fires repeatedly every `everyMs` milliseconds.
 *  - "once":     fires a single time at the ISO timestamp `at`, then disables.
 *  - "daily":    fires every day at the local "HH:MM" (24h) clock time `time`.
 */
export type ScheduleTrigger =
  | { type: "interval"; everyMs: number } // repeating every everyMs
  | { type: "once"; at: string } // ISO timestamp; fires once
  | { type: "daily"; time: string }; // "HH:MM" 24h local; repeats daily

/** A persisted scheduled task. */
export interface Schedule {
  id: string;
  task: string; // the agent prompt to run when due
  trigger: ScheduleTrigger;
  enabled: boolean;
  createdAt: string; // ISO
  lastRun?: string; // ISO
  nextRun?: string; // ISO (computed best-effort)
}
