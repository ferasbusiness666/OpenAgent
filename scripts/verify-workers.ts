/**
 * verify-workers.ts — standalone smoke test for the multi-worker engine.
 *
 * Validates the WorkerPool against the JS sandbox (vm fallback, since
 * isolated-vm is typically not installed here), error handling, parallel
 * dispatch, timeout enforcement, and the shell path. Prints per-test lines and
 * a final `WORKERS VERIFY: PASS|FAIL`, then exits with a matching code.
 *
 * Run: `npx tsx scripts/verify-workers.ts`
 */

import { getWorkerPool, closeWorkerPool } from "../src/workers/pool.js";

interface Check {
  label: string;
  ok: boolean;
  note?: string;
}

const checks: Check[] = [];

function record(label: string, ok: boolean, note?: string): void {
  checks.push({ label, ok, note });
}

async function main(): Promise<void> {
  const pool = getWorkerPool();

  // Overall safety net: the whole script should finish well within ~20s.
  const watchdog = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error("verify-workers: watchdog fired (>20s) — forcing exit");
    process.exit(1);
  }, 20000);
  watchdog.unref();

  // Test 1 — basic JS: console.log + final expression value.
  try {
    const r = await pool.run({
      kind: "js",
      source: "console.log('hi'); 40+2",
    });
    const ok = r.success && r.output.includes("42") && r.output.includes("hi");
    record("Test 1 runJs basic (42 + hi)", ok, ok ? undefined : r.output || r.error);
  } catch (err) {
    record("Test 1 runJs basic (42 + hi)", false, String(err));
  }

  // Test 2 — error propagation.
  try {
    const r = await pool.run({
      kind: "js",
      source: "throw new Error('boom')",
    });
    const ok = !r.success && (r.error ?? "").includes("boom");
    record("Test 2 runJs error (boom)", ok, ok ? undefined : r.error ?? r.output);
  } catch (err) {
    record("Test 2 runJs error (boom)", false, String(err));
  }

  // Test 3 — parallel dispatch across workers.
  try {
    const results = await Promise.all([
      pool.run({ kind: "js", source: "21*2" }),
      pool.run({ kind: "js", source: "21*2" }),
      pool.run({ kind: "js", source: "21*2" }),
    ]);
    const ok = results.every((r) => r.success && r.output.includes("42"));
    record(
      "Test 3 parallel (3x 42)",
      ok,
      ok ? undefined : results.map((r) => r.output || r.error).join(" | "),
    );
  } catch (err) {
    record("Test 3 parallel (3x 42)", false, String(err));
  }

  // Test 4 — timeout: an infinite loop must be terminated, not hang.
  try {
    const r = await pool.run({
      kind: "js",
      source: "while(true){}",
      timeoutMs: 600,
    });
    const ok = !r.success;
    record("Test 4 timeout (infinite loop)", ok, ok ? r.error : "did not fail");
  } catch (err) {
    record("Test 4 timeout (infinite loop)", false, String(err));
  }

  // Test 5 — shell path (cross-platform via node -e).
  try {
    const r = await pool.run({
      kind: "shell",
      source: 'node -e "console.log(40+2)"',
    });
    const ok = r.output.includes("42");
    record("Test 5 shell (node -e 42)", ok, ok ? undefined : r.output || r.error);
  } catch (err) {
    record("Test 5 shell (node -e 42)", false, String(err));
  }

  clearTimeout(watchdog);
  await closeWorkerPool();

  const allOk = checks.every((c) => c.ok);
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    const suffix = c.ok ? "" : ` — ${c.note ?? "failed"}`;
    // eslint-disable-next-line no-console
    console.log(`${mark} ${c.label}${suffix}`);
  }
  // eslint-disable-next-line no-console
  console.log(`WORKERS VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
