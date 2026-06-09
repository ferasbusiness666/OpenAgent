/**
 * verify-runs.ts — Phase B (background runs) engine verification.
 *  1. RunStore CRUD + JSONL event round-trip (temp dir).
 *  2. executeRun in-process with a scripted provider → events streamed, status done.
 *  3. launchBackgroundRun real DETACHED spawn via the selftest hook → the child
 *     process boots, records a terminal status, and exits independently.
 */
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { RunStore } from "../src/agent/run-store.js";
import { executeRun, launchBackgroundRun } from "../src/agent/runner.js";
import type { Provider, GenerateRequest } from "../src/providers/index.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => {
  checks.push([l, c]);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ScriptedProvider implements Provider {
  readonly name = "scripted-run";
  readonly supportsVision = false;
  async generate(req: GenerateRequest): Promise<string> {
    const text = req.system + "\n" + req.messages.map((m) => m.content).join("\n");
    if (text.includes("planning module")) {
      return JSON.stringify([{ title: "do it", description: "the work" }]);
    }
    return JSON.stringify({ thought: "all done", action: "done", params: {}, message: "finished run" });
  }
}

async function main(): Promise<void> {
  const tmp = path.join(os.tmpdir(), "openagent-verify-runs-" + Date.now());
  fs.ensureDirSync(tmp);

  // ---- 1. RunStore CRUD + event round-trip ----
  {
    const store = new RunStore(tmp);
    const rec = store.create({ runId: "r1", task: "do x", projectPath: tmp, sessionId: "s1" });
    ok("create returns a running record", rec.status === "running" && rec.runId === "r1");
    ok("get round-trips the record", store.get("r1")?.task === "do x");
    store.appendEvent("r1", { ts: new Date().toISOString(), type: "thought", data: "thinking" });
    store.appendEvent("r1", { ts: new Date().toISOString(), type: "done", data: "ok" });
    const evs = store.readEvents("r1");
    ok("events JSONL round-trips (2 events)", evs.length === 2 && evs[1]!.type === "done");
    store.update("r1", { status: "done", finalMessage: "fin" });
    ok("update persists status", store.get("r1")?.status === "done");
    store.create({ runId: "r2", task: "y", projectPath: tmp, sessionId: "s2" });
    ok("list returns all runs", store.list().length === 2);
  }

  // ---- 2. executeRun in-process with a scripted provider ----
  {
    const store = new RunStore(tmp);
    store.create({ runId: "exec1", task: "compute something", projectPath: process.cwd(), sessionId: "sess-exec1" });
    await executeRun("exec1", { provider: new ScriptedProvider(), runStore: store });
    const rec = store.get("exec1");
    ok("executeRun drives the loop to done", rec?.status === "done");
    ok("executeRun records a final message", (rec?.finalMessage ?? "").includes("finished run"));
    const evs = store.readEvents("exec1");
    ok("executeRun streamed events to the log", evs.length > 0 && evs.some((e) => e.type === "done"));
  }

  // ---- 3. real detached spawn (selftest hook → no LLM needed) ----
  {
    const detachedDir = path.join(tmp, "detached");
    fs.ensureDirSync(detachedDir);
    process.env.OPENAGENT_RUNS_DIR = detachedDir;
    process.env.OPENAGENT_RUN_SELFTEST = "1";
    try {
      const { runId, pid } = launchBackgroundRun("selftest task", process.cwd());
      ok("launchBackgroundRun returns a runId", typeof runId === "string" && runId.length > 0);
      ok("launchBackgroundRun spawned a pid", typeof pid === "number");
      // Poll the detached child's record until it settles (or time out).
      const store = new RunStore(detachedDir);
      let status = "running";
      for (let i = 0; i < 60 && status === "running"; i += 1) {
        await sleep(500);
        status = store.get(runId)?.status ?? "running";
      }
      ok("detached child completed in a separate process", status === "done");
      ok("detached child recorded the selftest result", store.get(runId)?.finalMessage === "selftest");
    } finally {
      delete process.env.OPENAGENT_RUN_SELFTEST;
      delete process.env.OPENAGENT_RUNS_DIR;
    }
  }

  fs.removeSync(tmp);
  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nRUNS VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
