/**
 * verify-code.ts — Phase C: multi-language code execution.
 * Exercises the `code` tool through the real executeTool dispatch: the JS vm
 * sandbox, a real-interpreter language (node, always present), runtime
 * detection, the default-language path, invalid-language validation, and a
 * clean failure for an unavailable interpreter. Python is tested when present.
 */
import { executeTool, closeWorkerPool } from "../src/tools/index.js";
import { CodeTool } from "../src/tools/code.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => {
  checks.push([l, c]);
};

async function main(): Promise<void> {
  // ---- js (in-process vm sandbox) ----
  const js = await executeTool("code", { language: "js", code: "6*7" });
  ok("js (vm) runs and returns 42", js.success && js.result.includes("42"));

  // ---- default language is js ----
  const def = await executeTool("code", { code: "5*5" });
  ok("default language is js", def.success && def.result.includes("25"));

  // ---- node (real interpreter, always available here) ----
  const node = await executeTool("code", { language: "node", code: "console.log(40+2)" });
  ok("node runs via the local interpreter and returns 42", node.success && node.result.includes("42"));

  // ---- runtime detection ----
  const runtimes = new CodeTool().detectRuntimes();
  ok("detectRuntimes reports js available", runtimes.some((r) => r.language === "js" && r.available));
  ok("detectRuntimes reports node available", runtimes.some((r) => r.language === "node" && r.available));

  // ---- python (only if installed) ----
  const pythonInfo = runtimes.find((r) => r.language === "python");
  if (pythonInfo?.available) {
    const py = await executeTool("code", { language: "python", code: "print(40+2)" });
    ok("python runs and returns 42", py.success && py.result.includes("42"));
  } else {
    console.log("i python not installed — skipping python exec test");
  }

  // ---- invalid language → validation error ----
  const bad = await executeTool("code", { language: "ruby", code: "puts 1" });
  ok("invalid language is rejected", !bad.success && (bad.error ?? "").includes("language"));

  // ---- an unavailable interpreter fails cleanly (no crash) ----
  const unavailable = runtimes.find((r) => r.language !== "js" && !r.available);
  if (unavailable) {
    const r = await executeTool("code", { language: unavailable.language, code: "echo hi" });
    ok(`unavailable interpreter (${unavailable.language}) fails cleanly`, !r.success && (r.error ?? "").length > 0);
  } else {
    console.log("i all interpreters available — skipping not-found test");
  }

  await closeWorkerPool();
  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nCODE VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
