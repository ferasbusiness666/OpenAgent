/**
 * verify-scheduler.ts — standalone smoke test for the Phase-4 Scheduler.
 *
 * Drives the scheduler with explicit `now` values against a temp file so the
 * behavior is fully deterministic (no real timers, no ~/.openagent writes).
 *
 * Run with: npx tsx scripts/verify-scheduler.ts
 */

import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { Scheduler } from "../src/scheduler/scheduler.js";
import type { Schedule } from "../src/scheduler/types.js";

let pass = true;

function check(label: string, condition: boolean): void {
  const mark = condition ? "✓" : "✗";
  // eslint-disable-next-line no-console
  console.log(`${mark} ${label}`);
  if (!condition) {
    pass = false;
  }
}

const tmp = path.join(os.tmpdir(), `openagent-scheduler-verify-${Date.now()}.json`);

function cleanup(): void {
  try {
    fs.removeSync(tmp);
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  cleanup();

  const s = new Scheduler({ filePath: tmp });

  // Count "due" events across the whole run via a listener.
  let dueEventCount = 0;
  s.on("due", () => {
    dueEventCount += 1;
  });

  // -------------------------------------------------------------------------
  // Interval test
  // -------------------------------------------------------------------------
  const interval = s.add({ task: "t1", trigger: { type: "interval", everyMs: 1000 } });
  const createdAt = Date.parse(interval.createdAt);

  const notYet = s.checkDue(createdAt + 500);
  check("interval: not due at +500ms", notYet.length === 0);

  const dueNow = s.checkDue(createdAt + 1500);
  check("interval: due at +1500ms (1 item)", dueNow.length === 1);
  check("interval: due item is t1", dueNow[0]?.task === "t1");
  check("interval: 'due' event fired (count >= 1)", dueEventCount >= 1);

  // Immediately re-check at the SAME now — lastRun advanced, so not due.
  const dueAgain = s.checkDue(createdAt + 1500);
  check("interval: not due again at same now (lastRun advanced)", dueAgain.length === 0);

  // Clean slate for the next tests.
  s.remove(interval.id);

  // -------------------------------------------------------------------------
  // Once test
  // -------------------------------------------------------------------------
  const dueCountBeforeOnce = dueEventCount;
  const onceAt = new Date(Date.now() - 1000).toISOString();
  s.add({ task: "t2", trigger: { type: "once", at: onceAt } });
  const onceNow = Date.now();

  const onceDue = s.checkDue(onceNow);
  check("once: due once", onceDue.length === 1 && onceDue[0]?.task === "t2");
  check("once: 'due' event fired", dueEventCount === dueCountBeforeOnce + 1);

  const onceAgain = s.checkDue(onceNow);
  check("once: not due again (disabled after firing)", onceAgain.length === 0);

  const onceList = s.list();
  const t2 = onceList.find((x: Schedule) => x.task === "t2");
  check("once: schedule disabled after firing", t2?.enabled === false);

  // -------------------------------------------------------------------------
  // Daily test
  // -------------------------------------------------------------------------
  const daily = s.add({ task: "t3", trigger: { type: "daily", time: "00:00" } });
  check("daily: add succeeded", typeof daily.id === "string" && daily.id.length > 0);
  const nextRunMs = daily.nextRun ? Date.parse(daily.nextRun) : NaN;
  check("daily: nextRun is a parseable ISO timestamp", !Number.isNaN(nextRunMs));
  // nextRun for "00:00" is today's 00:00 (if still ahead) or tomorrow's — never
  // before the start of today.
  const startOfToday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  check("daily: nextRun is today-or-future", nextRunMs >= startOfToday);

  let threwOnInvalid = false;
  try {
    s.add({ task: "bad", trigger: { type: "daily", time: "99:99" } });
  } catch {
    threwOnInvalid = true;
  }
  check("daily: add() throws on invalid time '99:99'", threwOnInvalid);

  // -------------------------------------------------------------------------
  // remove() test
  // -------------------------------------------------------------------------
  const before = s.list().length;
  const toRemove = s.add({ task: "t4", trigger: { type: "interval", everyMs: 5000 } });
  const afterAdd = s.list().length;
  check("remove: list grew after add", afterAdd === before + 1);
  const removed = s.remove(toRemove.id);
  check("remove: remove() returned true", removed === true);
  check("remove: list shrank back", s.list().length === before);

  // -------------------------------------------------------------------------
  // Result
  // -------------------------------------------------------------------------
  // eslint-disable-next-line no-console
  console.log(`SCHEDULER VERIFY: ${pass ? "PASS" : "FAIL"}`);
  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`verify-scheduler crashed: ${msg}`);
  cleanup();
  process.exit(1);
});
