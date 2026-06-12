/**
 * verify-trace.ts — IMP-24: Tracer / span / event / pruneOldTraces tests.
 *
 * Tests:
 *  1. new Tracer("vt-check"): two spans (one with end-attrs overriding start-attr)
 *     + one event → file has 3 JSON lines; names/durMs>=0/attr-override verified.
 *     DELETE the trace file in finally.
 *  2. String attr of 500 chars → truncated to ~300 (MAX_ATTR_STRING_CHARS).
 *  3. Span.end twice → still 1 line for that span.
 *  4. OPENAGENT_NO_TRACE=1 (save/restore): tracingEnabled() false;
 *     new Tracer + span + event writes NO file.
 *  5. pruneOldTraces: create a fake old .jsonl 30 days old → gone after
 *     pruneOldTraces(14); a fresh file survives. Clean up both.
 */

import path from "node:path";
import fs from "fs-extra";
import { Tracer, tracingEnabled, pruneOldTraces } from "../src/trace.js";
import { TRACES_DIR } from "../src/paths.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };

async function main(): Promise<void> {
  // Ensure the traces directory exists before we start.
  fs.ensureDirSync(TRACES_DIR);

  const traceFile = path.join(TRACES_DIR, "vt-check.jsonl");

  try {
    // ---- 1. Two spans + one event = 3 lines ---------------------------------
    {
      // Clean up from any prior failed run.
      if (fs.existsSync(traceFile)) fs.removeSync(traceFile);

      const tracer = new Tracer("vt-check");

      // Span 1: start with model="old-model", end with model="new-model" (override).
      const span1 = tracer.startSpan("provider.generate", { model: "old-model", step: 1 });
      // Tiny pause to get durMs > 0 reliably on most hardware — but we only
      // assert durMs >= 0 so a 0 is fine too.
      await new Promise<void>((r) => setTimeout(r, 2));
      span1.end({ model: "new-model", exitCode: 0 });

      // Span 2: a quick shell span.
      const span2 = tracer.startSpan("tool.shell", { command: "echo hi" });
      span2.end({ exitCode: 0 });

      // Event (durMs === 0).
      tracer.event("state.thinking", { stepIndex: 3 });

      // File must now exist with exactly 3 lines.
      ok("trace file created", fs.existsSync(traceFile));
      const rawLines = fs
        .readFileSync(traceFile, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      ok("trace file has exactly 3 JSON lines", rawLines.length === 3);

      // Parse all three.
      const parsed = rawLines.map((l) => {
        try {
          return JSON.parse(l) as {
            ts: string;
            name: string;
            durMs: number;
            attrs: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      });
      ok("all 3 lines parse as JSON", parsed.every((p) => p !== null));

      const [s1, s2, ev] = parsed as Array<{
        ts: string;
        name: string;
        durMs: number;
        attrs: Record<string, unknown>;
      }>;

      ok("span1 name is provider.generate", s1?.name === "provider.generate");
      ok("span1 durMs >= 0", typeof s1?.durMs === "number" && s1.durMs >= 0);
      ok(
        "span1 end-attr model overrides start-attr (model === 'new-model')",
        s1?.attrs?.model === "new-model",
      );
      // step: 1 was a start-attr that was NOT overridden — it should survive.
      ok("span1 start-attr step:1 survived", s1?.attrs?.step === 1);

      ok("span2 name is tool.shell", s2?.name === "tool.shell");
      ok("span2 durMs >= 0", typeof s2?.durMs === "number" && s2.durMs >= 0);

      ok("event name is state.thinking", ev?.name === "state.thinking");
      ok("event durMs === 0", ev?.durMs === 0);
      ok("event attr stepIndex === 3", ev?.attrs?.stepIndex === 3);
    }

    // ---- 2. String attr truncation (>300 chars → ~300) ----------------------
    {
      const longFile = path.join(TRACES_DIR, "vt-trunc.jsonl");
      if (fs.existsSync(longFile)) fs.removeSync(longFile);
      try {
        const tracer2 = new Tracer("vt-trunc");
        const longVal = "x".repeat(500);
        const span = tracer2.startSpan("test.trunc", { bigAttr: longVal });
        span.end();

        ok("truncation trace file created", fs.existsSync(longFile));
        const line = fs.readFileSync(longFile, "utf8").trim().split(/\r?\n/)[0];
        const parsed2 = JSON.parse(line ?? "{}") as { attrs?: Record<string, unknown> };
        const stored = parsed2?.attrs?.bigAttr;
        ok(
          "500-char attr truncated to <= 301 chars (300 + '…')",
          typeof stored === "string" && stored.length <= 302 && stored.length < 500,
        );
        ok(
          "truncated attr ends with '…'",
          typeof stored === "string" && stored.endsWith("…"),
        );
      } finally {
        if (fs.existsSync(longFile)) fs.removeSync(longFile);
      }
    }

    // ---- 3. Span.end twice → only 1 line for that span ---------------------
    {
      const doubleFile = path.join(TRACES_DIR, "vt-double.jsonl");
      if (fs.existsSync(doubleFile)) fs.removeSync(doubleFile);
      try {
        const tracer3 = new Tracer("vt-double");
        const span = tracer3.startSpan("double.end");
        span.end({ call: 1 });
        span.end({ call: 2 }); // second call must be a no-op
        const lines = fs
          .readFileSync(doubleFile, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.length > 0);
        ok("span.end twice → exactly 1 line written", lines.length === 1);
        // Confirm it was the FIRST end() that won (call:1).
        const parsed3 = JSON.parse(lines[0] ?? "{}") as { attrs?: Record<string, unknown> };
        ok("first end() attrs preserved (call === 1)", parsed3?.attrs?.call === 1);
      } finally {
        if (fs.existsSync(doubleFile)) fs.removeSync(doubleFile);
      }
    }

    // ---- 4. OPENAGENT_NO_TRACE=1 → no writes --------------------------------
    {
      const noTraceFile = path.join(TRACES_DIR, "vt-notrace.jsonl");
      if (fs.existsSync(noTraceFile)) fs.removeSync(noTraceFile);

      const origNoTrace = process.env.OPENAGENT_NO_TRACE;
      process.env.OPENAGENT_NO_TRACE = "1";

      try {
        ok("tracingEnabled() === false when OPENAGENT_NO_TRACE=1", tracingEnabled() === false);

        const tracer4 = new Tracer("vt-notrace");
        const span = tracer4.startSpan("suppressed.span", { x: 1 });
        span.end({ y: 2 });
        tracer4.event("suppressed.event", { z: 3 });

        ok("no trace file created when OPENAGENT_NO_TRACE=1", !fs.existsSync(noTraceFile));
      } finally {
        if (origNoTrace === undefined) {
          delete process.env.OPENAGENT_NO_TRACE;
        } else {
          process.env.OPENAGENT_NO_TRACE = origNoTrace;
        }
        if (fs.existsSync(noTraceFile)) fs.removeSync(noTraceFile);
      }
    }

    // ---- 5. pruneOldTraces --------------------------------------------------
    {
      const oldFile = path.join(TRACES_DIR, "vt-old-trace.jsonl");
      const freshFile = path.join(TRACES_DIR, "vt-fresh-trace.jsonl");

      // Write both files.
      fs.writeFileSync(oldFile, '{"ts":"2000-01-01T00:00:00.000Z","name":"old","durMs":0,"attrs":{}}\n', "utf8");
      fs.writeFileSync(freshFile, '{"ts":"2000-01-01T00:00:00.000Z","name":"fresh","durMs":0,"attrs":{}}\n', "utf8");

      // Make oldFile appear 30 days old.
      const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const thirtyDaysAgoSec = thirtyDaysAgoMs / 1000;
      fs.utimesSync(oldFile, thirtyDaysAgoSec, thirtyDaysAgoSec);
      // freshFile keeps its current mtime (just created).

      pruneOldTraces(14);

      ok("old trace file (30 days) pruned after pruneOldTraces(14)", !fs.existsSync(oldFile));
      ok("fresh trace file survives pruneOldTraces(14)", fs.existsSync(freshFile));

      // Clean up fresh file.
      if (fs.existsSync(freshFile)) fs.removeSync(freshFile);
    }

  } finally {
    // Always delete the primary test trace file.
    if (fs.existsSync(traceFile)) fs.removeSync(traceFile);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nTRACE VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
