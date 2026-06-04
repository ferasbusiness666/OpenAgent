/**
 * worker-entry.mjs — the script executed inside each Node worker thread.
 *
 * Plain ESM JavaScript (not typechecked): the parent passes a job via
 * `workerData`, and this script posts back exactly one `result` message (and
 * optional `progress` messages) over `parentPort`. It must never hang: the
 * whole handler is wrapped in try/catch so unexpected errors still yield a
 * single failed result.
 *
 * Job kinds:
 *  - "shell": runs the command via child_process.exec, combining stdout+stderr.
 *  - "js":    evaluates the source in a sandbox. Tries `isolated-vm` first (if
 *             installed) and falls back to Node's built-in `vm` module.
 */

import { workerData, parentPort } from "node:worker_threads";
import { exec } from "node:child_process";

/** Best-effort JSON stringify that never throws. */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Post a single result message to the parent. Guards against a missing
 * parentPort (shouldn't happen for a real worker, but keeps us safe).
 */
function postResult(result) {
  if (parentPort) parentPort.postMessage(result);
}

/** Run a "shell" job: combine stdout + stderr into one output string. */
function runShell(job) {
  const cwd = job.cwd ?? process.cwd();
  const timeout = job.timeoutMs ?? 30000;
  // killSignal SIGKILL: on timeout, exec force-kills the child itself (rather
  // than a SIGTERM the child might ignore). The pool's backstop fires later, so
  // this in-worker reap is what prevents the child from being orphaned when a
  // slow command runs past its deadline.
  exec(
    job.source,
    { cwd, timeout, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1 << 20 },
    (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      postResult({
        type: "result",
        success: !error,
        output,
        error: error ? String(error.message) : undefined,
        engine: "shell",
      });
    },
  );
}

/**
 * Load the isolated-vm module if it is installed and usable. Returns the module
 * (with an `Isolate` constructor) or null when it is unavailable. Distinguishing
 * "unavailable" from "the guest threw" is deliberate: only true unavailability
 * should make runJs fall back to the vm sandbox — a guest error is a real result.
 */
async function loadIsolatedVm() {
  try {
    const mod = await import("isolated-vm");
    const ivm = mod.default ?? mod;
    return ivm && typeof ivm.Isolate === "function" ? ivm : null;
  } catch {
    return null;
  }
}

/**
 * Run "js" source under isolated-vm (assumed available). Returns a result object
 * for BOTH success and a guest error — it never throws for guest code, so the
 * caller does not silently re-execute the source under vm on a real error.
 *
 * The source is evaluated as a normal program (no IIFE wrapper) so its trailing
 * expression's completion value is preserved, matching the vm fallback. A host
 * `log` reference backs a `console.log` shim defined ahead of the user code.
 */
function runWithIsolatedVm(ivm, source, timeoutMs) {
  const logs = [];
  const isolate = new ivm.Isolate({ memoryLimit: 64 });
  try {
    const context = isolate.createContextSync();
    const jail = context.global;
    jail.setSync("global", jail.derefInto());
    jail.setSync(
      "log",
      new ivm.Reference((...args) => {
        logs.push(args.map((a) => String(a)).join(" "));
      }),
    );
    const program =
      "const console = { log: (...a) => log.applySync(undefined, a.map(x => String(x))) };\n" +
      source;
    const script = isolate.compileScriptSync(program);
    let value;
    try {
      // copy: true so a non-primitive completion value is marshalled out by
      // value; a guest throw (or a non-copyable result) is reported as failure.
      value = script.runSync(context, { timeout: timeoutMs, copy: true });
    } catch (err) {
      return {
        type: "result",
        success: false,
        output: logs.join("\n"),
        error: String((err && err.message) || err),
        engine: "isolated-vm",
      };
    }
    const valueStr =
      value !== undefined && value !== null ? safeStringify(value) : "";
    const parts = [];
    if (logs.length > 0) parts.push(logs.join("\n"));
    if (valueStr) parts.push(`=> ${valueStr}`);
    return {
      type: "result",
      success: true,
      output: parts.join("\n"),
      engine: "isolated-vm",
    };
  } finally {
    try {
      isolate.dispose();
    } catch {
      /* ignore disposal errors */
    }
  }
}

/** Run "js" source under Node's built-in vm as a fallback sandbox. */
async function runWithVm(source, timeoutMs) {
  const vm = (await import("node:vm")).default;
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.map(String).join(" ")) },
  };
  try {
    const value = vm.runInNewContext(source, sandbox, { timeout: timeoutMs });
    const tail =
      value !== undefined ? `\n=> ${safeStringify(value)}` : "";
    return {
      type: "result",
      success: true,
      output: `${logs.join("\n")}${tail}`,
      engine: "vm",
    };
  } catch (err) {
    return {
      type: "result",
      success: false,
      output: logs.join("\n"),
      error: String((err && err.message) || err),
      engine: "vm",
    };
  }
}

/**
 * Run a "js" job.
 *
 * The LOCAL Node `vm` sandbox is the default, always-available engine: it needs
 * no native build, runs on every platform, and executes inside this worker
 * thread under a heap cap (resourceLimits) and a hard timeout.
 *
 * isolated-vm is an OPT-IN hardening path reserved for later: it is only used
 * when explicitly requested via OPENAGENT_SANDBOX=isolated-vm *and* the optional
 * `isolated-vm` package is installed. It is never selected automatically, so the
 * local engine stays the main path — the scaffolding (loadIsolatedVm /
 * runWithIsolatedVm) is just the hook to build on when stronger isolation is
 * wanted. The source is executed exactly once in either case.
 */
async function runJs(job) {
  const timeoutMs = job.timeoutMs ?? 30000;
  if (process.env.OPENAGENT_SANDBOX === "isolated-vm") {
    const ivm = await loadIsolatedVm();
    if (ivm) {
      postResult(runWithIsolatedVm(ivm, job.source, timeoutMs));
      return;
    }
    // Opted in but the package isn't installed — fall back to the local engine.
  }
  postResult(await runWithVm(job.source, timeoutMs));
}

/** Entry: dispatch on job kind, guaranteeing exactly one result message. */
async function main() {
  const job = workerData;
  if (!parentPort) return;
  try {
    if (!job || typeof job !== "object") {
      postResult({
        type: "result",
        success: false,
        output: "",
        error: "no job provided to worker",
        engine: "vm",
      });
      return;
    }
    if (job.kind === "shell") {
      runShell(job);
      return;
    }
    if (job.kind === "js") {
      await runJs(job);
      return;
    }
    postResult({
      type: "result",
      success: false,
      output: "",
      error: `unknown job kind: ${String(job.kind)}`,
      engine: "vm",
    });
  } catch (err) {
    postResult({
      type: "result",
      success: false,
      output: "",
      error: String((err && err.message) || err),
      engine: job && job.kind === "shell" ? "shell" : "vm",
    });
  }
}

void main();
