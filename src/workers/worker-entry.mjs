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
  exec(
    job.source,
    { cwd, timeout, windowsHide: true, maxBuffer: 1 << 20 },
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
 * Try to run "js" source under isolated-vm. Returns a result object on success
 * or throws on any failure (so the caller falls through to the vm fallback).
 */
async function runWithIsolatedVm(source, timeoutMs) {
  let ivm;
  try {
    const mod = await import("isolated-vm");
    ivm = mod.default ?? mod;
  } catch {
    ivm = null;
  }
  if (!ivm || typeof ivm.Isolate !== "function") {
    throw new Error("isolated-vm unavailable");
  }

  const logs = [];
  const isolate = new ivm.Isolate({ memoryLimit: 64 });
  try {
    const context = isolate.createContextSync();
    const jail = context.global;
    jail.setSync("global", jail.derefInto());
    // Expose a host `log` callback the guest can call to accumulate output.
    jail.setSync(
      "log",
      new ivm.Reference((...args) => {
        logs.push(args.map((a) => String(a)).join(" "));
      }),
    );
    // Provide a console.log shim and capture the final expression value.
    const wrapped = `
      const console = { log: (...a) => log.applySync(undefined, a.map(x => String(x))) };
      (function(){ ${source}\n })();
    `;
    const script = isolate.compileScriptSync(wrapped);
    const value = script.runSync(context, { timeout: timeoutMs });
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

/** Run a "js" job: isolated-vm first, vm fallback on any error. */
async function runJs(job) {
  const timeoutMs = job.timeoutMs ?? 30000;
  try {
    const result = await runWithIsolatedVm(job.source, timeoutMs);
    postResult(result);
    return;
  } catch {
    // Fall through to the vm fallback below.
  }
  const fallback = await runWithVm(job.source, timeoutMs);
  postResult(fallback);
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
