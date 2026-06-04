/**
 * scheduler.ts — a file-based, in-process scheduling engine (Phase 4).
 *
 * The Scheduler persists a JSON array of {@link Schedule}s to disk (defaulting
 * to ~/.openagent/schedules.json) and polls them on a fixed interval. When a
 * schedule's trigger is due it records `lastRun`, recomputes `nextRun`, and
 * emits a typed "due" event so a host can dispatch the task to the agent.
 *
 * Design notes / decisions:
 *  - All disk I/O is best-effort and never throws: a missing or corrupt file
 *    reads as an empty list, and write failures are swallowed. The scheduler
 *    must never crash the host process over a transient FS problem.
 *  - `checkDue(now)` is pure-driveable: callers (and tests) may pass an explicit
 *    `now` so due-ness is fully deterministic and the polling timer is optional.
 *  - The polling timer is `.unref()`-ed so it never keeps the process alive.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import { SCHEDULES_PATH, ensureDataDir } from "../paths.js";
import type { Schedule, ScheduleTrigger } from "./types.js";

/** Default poll cadence (ms) when none is supplied. */
const DEFAULT_POLL_MS = 30_000;

/** "HH:MM" 24-hour clock matcher used to validate daily triggers. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Strongly-typed event payloads emitted by the Scheduler. */
export interface SchedulerEvents {
  /** A schedule's trigger fired; payload is the (already-updated) schedule. */
  due: (s: Schedule) => void;
  /** The persisted set changed (add/remove/enable/fire). */
  change: (all: Schedule[]) => void;
}

// Typed on/once/off/emit overlay over Node's EventEmitter (no `any`).
export declare interface Scheduler {
  on<K extends keyof SchedulerEvents>(
    event: K,
    listener: SchedulerEvents[K],
  ): this;
  once<K extends keyof SchedulerEvents>(
    event: K,
    listener: SchedulerEvents[K],
  ): this;
  off<K extends keyof SchedulerEvents>(
    event: K,
    listener: SchedulerEvents[K],
  ): this;
  emit<K extends keyof SchedulerEvents>(
    event: K,
    ...args: Parameters<SchedulerEvents[K]>
  ): boolean;
}

/**
 * File-backed scheduler. Construct with an optional `filePath` (handy for
 * tests) and `pollMs`, then call {@link Scheduler.start} to begin polling — or
 * drive {@link Scheduler.checkDue} directly with an explicit `now`.
 */
export class Scheduler extends EventEmitter {
  private readonly filePath: string;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(options?: { filePath?: string; pollMs?: number }) {
    super();
    this.filePath = options?.filePath ?? SCHEDULES_PATH;
    this.pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  }

  // -------------------------------------------------------------------------
  // Persistence (best-effort — never throws)
  // -------------------------------------------------------------------------

  /**
   * Reads the schedule list from disk. Returns [] for a missing or corrupt
   * file, or one that does not contain a JSON array. Never throws.
   */
  private read(): Schedule[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      // Trust the on-disk shape only as far as it is an array; each element is
      // narrowed to the Schedule fields we use. Malformed elements are dropped.
      return parsed.filter(isSchedule);
    } catch {
      return [];
    }
  }

  /**
   * Writes the schedule list to disk. Best-effort: ensures the data dir exists
   * when writing the default path, and swallows any error. Never throws.
   */
  private write(schedules: Schedule[]): void {
    try {
      if (this.filePath === SCHEDULES_PATH) {
        ensureDataDir();
      }
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(schedules, null, 2),
        "utf-8",
      );
    } catch {
      // Best-effort — a write failure must not crash the host.
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns the current persisted list of schedules. */
  list(): Schedule[] {
    return this.read();
  }

  /**
   * Adds a new schedule. Validates the trigger and throws on invalid input.
   * Persists the updated list and emits "change".
   *
   * @param input - task prompt, trigger, and optional initial `enabled` flag.
   * @returns The newly created (and persisted) schedule.
   */
  add(input: {
    task: string;
    trigger: ScheduleTrigger;
    enabled?: boolean;
  }): Schedule {
    if (typeof input.task !== "string" || input.task.trim().length === 0) {
      throw new Error("Schedule requires a non-empty task.");
    }
    this.validateTrigger(input.trigger);

    const now = Date.now();
    const schedule: Schedule = {
      id: randomUUID(),
      task: input.task,
      trigger: input.trigger,
      enabled: input.enabled ?? true,
      createdAt: new Date(now).toISOString(),
    };
    const nextRun = this.computeNextRun(input.trigger, now);
    if (nextRun !== undefined) {
      schedule.nextRun = nextRun;
    }

    const schedules = this.read();
    schedules.push(schedule);
    this.write(schedules);
    this.emit("change", schedules);
    return schedule;
  }

  /**
   * Removes a schedule by id. Persists and emits "change" when something was
   * actually removed.
   *
   * @returns true if a schedule was removed.
   */
  remove(id: string): boolean {
    const schedules = this.read();
    const next = schedules.filter((s) => s.id !== id);
    if (next.length === schedules.length) {
      return false;
    }
    this.write(next);
    this.emit("change", next);
    return true;
  }

  /**
   * Enables or disables a schedule by id. Persists and emits "change" when the
   * schedule was found (even if the flag was already at the requested value).
   *
   * @returns true if a schedule with `id` exists.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const schedules = this.read();
    const target = schedules.find((s) => s.id === id);
    if (!target) {
      return false;
    }
    target.enabled = enabled;
    this.write(schedules);
    this.emit("change", schedules);
    return true;
  }

  /** Begins polling on the configured cadence. Idempotent. */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      this.checkDue();
    }, this.pollMs);
    // Do not keep the event loop / process alive purely for the scheduler.
    this.timer.unref();
  }

  /** Stops polling. Safe to call when not started. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Evaluates every enabled schedule against `now` and fires those that are due.
   *
   * For each due schedule it sets `lastRun`, recomputes `nextRun`, emits "due",
   * and (for "once" triggers) disables the schedule so it never re-fires.
   * Persists once and emits "change" if anything changed.
   *
   * @param now - Epoch ms to evaluate against. Defaults to Date.now(); tests
   *              pass an explicit value for deterministic behavior.
   * @returns The list of schedules that fired this call.
   */
  checkDue(now: number = Date.now()): Schedule[] {
    const schedules = this.read();
    const due: Schedule[] = [];
    let changed = false;

    for (const schedule of schedules) {
      if (!schedule.enabled) {
        continue;
      }
      if (!this.isDue(schedule, now)) {
        continue;
      }

      schedule.lastRun = new Date(now).toISOString();
      const nextRun = this.computeNextRun(schedule.trigger, now);
      if (nextRun !== undefined) {
        schedule.nextRun = nextRun;
      } else {
        delete schedule.nextRun;
      }
      // A "once" trigger fires exactly one time, then goes dormant.
      if (schedule.trigger.type === "once") {
        schedule.enabled = false;
      }
      changed = true;
      due.push(schedule);
    }

    if (changed) {
      this.write(schedules);
    }

    // Emit "due" after persisting so a synchronous listener that re-reads disk
    // sees the advanced lastRun and won't observe the same schedule as due.
    for (const schedule of due) {
      this.emit("due", schedule);
    }
    if (changed) {
      this.emit("change", schedules);
    }

    return due;
  }

  // -------------------------------------------------------------------------
  // Internal: due-ness + next-run computation
  // -------------------------------------------------------------------------

  /** Determines whether a single schedule is due at `now` (epoch ms). */
  private isDue(schedule: Schedule, now: number): boolean {
    const trigger = schedule.trigger;
    switch (trigger.type) {
      case "interval": {
        const anchor = schedule.lastRun
          ? Date.parse(schedule.lastRun)
          : Date.parse(schedule.createdAt);
        if (Number.isNaN(anchor)) {
          return false;
        }
        return now - anchor >= trigger.everyMs;
      }
      case "once": {
        const at = Date.parse(trigger.at);
        if (Number.isNaN(at)) {
          return false;
        }
        return now >= at && schedule.lastRun === undefined;
      }
      case "daily": {
        const target = dailyTargetMs(trigger.time, now);
        if (target === undefined) {
          return false;
        }
        if (now < target) {
          return false;
        }
        // Already fired today? Compare local calendar days.
        if (schedule.lastRun !== undefined) {
          const last = Date.parse(schedule.lastRun);
          if (!Number.isNaN(last) && isSameLocalDay(last, now)) {
            return false;
          }
        }
        return true;
      }
    }
  }

  /**
   * Computes a best-effort next-run ISO timestamp relative to `fromMs`.
   * Returns undefined for an invalid trigger (e.g. unparseable "once" date).
   */
  private computeNextRun(
    trigger: ScheduleTrigger,
    fromMs: number,
  ): string | undefined {
    switch (trigger.type) {
      case "interval": {
        if (!(trigger.everyMs > 0)) {
          return undefined;
        }
        return new Date(fromMs + trigger.everyMs).toISOString();
      }
      case "once": {
        const at = Date.parse(trigger.at);
        if (Number.isNaN(at)) {
          return undefined;
        }
        // If it has not yet fired, the next run is `at`; once past, there is
        // no further run.
        return at >= fromMs ? new Date(at).toISOString() : undefined;
      }
      case "daily": {
        const todayTarget = dailyTargetMs(trigger.time, fromMs);
        if (todayTarget === undefined) {
          return undefined;
        }
        // If today's target is still ahead, that's next; otherwise tomorrow's.
        const next =
          todayTarget > fromMs
            ? todayTarget
            : todayTarget + 24 * 60 * 60 * 1000;
        return new Date(next).toISOString();
      }
    }
  }

  /** Validates a trigger, throwing a descriptive Error when invalid. */
  private validateTrigger(trigger: ScheduleTrigger): void {
    switch (trigger.type) {
      case "interval":
        if (!(typeof trigger.everyMs === "number" && trigger.everyMs > 0)) {
          throw new Error(
            'Invalid interval trigger: "everyMs" must be a number greater than 0.',
          );
        }
        return;
      case "once": {
        const at = Date.parse(trigger.at);
        if (Number.isNaN(at)) {
          throw new Error(
            `Invalid once trigger: "at" (${trigger.at}) is not a valid date.`,
          );
        }
        return;
      }
      case "daily":
        if (!HHMM_RE.test(trigger.time)) {
          throw new Error(
            `Invalid daily trigger: "time" (${trigger.time}) must match HH:MM (24-hour).`,
          );
        }
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level pure helpers
// ---------------------------------------------------------------------------

/**
 * Computes the epoch-ms of the "HH:MM" local time on the calendar day of `now`.
 * Returns undefined if the time string is malformed.
 */
function dailyTargetMs(time: string, now: number): number | undefined {
  const match = HHMM_RE.exec(time);
  if (!match) {
    return undefined;
  }
  const [hourStr, minuteStr] = time.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** True when two epoch-ms timestamps fall on the same local calendar day. */
function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Runtime guard that narrows an unknown disk element to a usable Schedule.
 * Keeps best-effort reads safe against partially corrupt files.
 */
function isSchedule(value: unknown): value is Schedule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string") return false;
  if (typeof v["task"] !== "string") return false;
  if (typeof v["enabled"] !== "boolean") return false;
  if (typeof v["createdAt"] !== "string") return false;
  const trigger = v["trigger"];
  if (typeof trigger !== "object" || trigger === null) return false;
  const t = trigger as Record<string, unknown>;
  switch (t["type"]) {
    case "interval":
      return typeof t["everyMs"] === "number";
    case "once":
      return typeof t["at"] === "string";
    case "daily":
      return typeof t["time"] === "string";
    default:
      return false;
  }
}
