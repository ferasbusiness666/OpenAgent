/**
 * verify-fsm.ts — IMP-01 (explicit state machine) + IMP-04 (dynamic cap).
 *  1. stateChange events trace planning → thinking → executing → … → done,
 *     and loop.state ends terminal.
 *  2. resolveMaxIterations math + OPENAGENT_MAX_ITERATIONS override.
 *  3. The cap actually stops a never-finishing run with "stuck".
 *  4. The verifying state appears when reflection is on.
 */
import { AgentLoop, resolveMaxIterations, type LoopState } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import type { Provider, GenerateRequest, GenerateResult } from "../src/providers/index.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const textOf = (r: GenerateRequest): string => r.system + "\n" + r.messages.map((m) => m.content).join("\n");

/** Writes one file, then finishes. */
class WriteThenDoneProvider implements Provider {
  readonly name = "fsm";
  readonly supportsVision = false;
  private step = 0;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (textOf(req).includes("planning module")) {
      return { text: JSON.stringify([{ title: "a", description: "b" }]), toolCalls: [] };
    }
    this.step += 1;
    return this.step === 1
      ? { text: "", toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: "fsm.txt", content: "s" } }] }
      : { text: "", toolCalls: [{ name: "done", arguments: { message: "ok" } }] };
  }
}

/** Never finishes — always another (successful) write. */
class EndlessProvider implements Provider {
  readonly name = "endless";
  readonly supportsVision = false;
  private step = 0;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (textOf(req).includes("planning module")) {
      return { text: JSON.stringify([{ title: "a", description: "b" }]), toolCalls: [] };
    }
    this.step += 1;
    return { text: "", toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: `e${this.step}.txt`, content: "x" } }] };
  }
}

/** Done on the first action turn; verdict complete on the self-check. */
class VerifiedDoneProvider implements Provider {
  readonly name = "verified";
  readonly supportsVision = false;
  selfChecks = 0;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const text = textOf(req);
    if (text.includes("planning module")) {
      return { text: JSON.stringify([{ title: "a", description: "b" }]), toolCalls: [] };
    }
    if (text.includes("SELF-CHECK")) {
      this.selfChecks += 1;
      return { text: JSON.stringify({ complete: true, reason: "looks right" }), toolCalls: [] };
    }
    return { text: "", toolCalls: [{ name: "done", arguments: { message: "finished" } }] };
  }
}

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-fsm-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  const origReflect = getConfig().enableReflection;
  const origEnv = process.env.OPENAGENT_MAX_ITERATIONS;

  try {
    // ---- 1. state trace ----
    saveConfig({ enableReflection: false });
    delete process.env.OPENAGENT_MAX_ITERATIONS;
    {
      const loop = new AgentLoop(new WriteThenDoneProvider(), new SessionMemory(), new AgentMemory());
      const phases: string[] = [];
      loop.on("stateChange", (s: LoopState) => phases.push(s.phase));
      await loop.run("write a file");
      await settle();
      ok("trace starts planning → thinking", phases[0] === "planning" && phases[1] === "thinking");
      ok("trace includes executing", phases.includes("executing"));
      ok("trace ends done", phases[phases.length - 1] === "done");
      ok("no verifying state when reflection is off", !phases.includes("verifying"));
      ok("loop.state is terminal done", loop.state.phase === "done");
    }

    // ---- 2. resolveMaxIterations ----
    ok("cap: 0 phases → 20", resolveMaxIterations(0) === 20);
    ok("cap: 3 phases → 35", resolveMaxIterations(3) === 35);
    ok("cap: clamped at 200", resolveMaxIterations(100) === 200);
    process.env.OPENAGENT_MAX_ITERATIONS = "7";
    ok("cap: env override wins", resolveMaxIterations(5) === 7);
    process.env.OPENAGENT_MAX_ITERATIONS = "bogus";
    ok("cap: invalid override falls back to computed", resolveMaxIterations(5) === 45);

    // ---- 3. the cap stops a runaway loop ----
    process.env.OPENAGENT_MAX_ITERATIONS = "3";
    {
      const loop = new AgentLoop(new EndlessProvider(), new SessionMemory(), new AgentMemory());
      let stuckMsg = "";
      loop.on("stuck", (m) => { stuckMsg = m; });
      await loop.run("never finish");
      await settle();
      ok("endless run goes stuck at the cap", stuckMsg.includes("maximum of 3"));
      ok("loop.state is terminal stuck", loop.state.phase === "stuck");
    }
    delete process.env.OPENAGENT_MAX_ITERATIONS;

    // ---- 4. verifying state appears with reflection on ----
    saveConfig({ enableReflection: true });
    {
      const provider = new VerifiedDoneProvider();
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      const phases: string[] = [];
      let doneEvents = 0;
      loop.on("stateChange", (s: LoopState) => phases.push(s.phase));
      loop.on("done", () => { doneEvents += 1; });
      await loop.run("do it");
      await settle();
      ok("verifying state entered before done", phases.includes("verifying"));
      ok("self-check consulted once, done emitted once", provider.selfChecks === 1 && doneEvents === 1);
    }
  } finally {
    saveConfig({ enableReflection: origReflect });
    if (origEnv === undefined) {
      delete process.env.OPENAGENT_MAX_ITERATIONS;
    } else {
      process.env.OPENAGENT_MAX_ITERATIONS = origEnv;
    }
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nFSM VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
