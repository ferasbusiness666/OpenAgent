/**
 * verify-reflection.ts — Phase E: self-critique before "done".
 *  1. A premature "done" is sent back by the self-check, then accepted once the
 *     critic says the goal is complete (bounded by MAX_REFLECTIONS).
 *  2. With enableReflection=false, "done" is accepted immediately (no critique).
 */
import { AgentLoop } from "../src/agent/loop.js";
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

/** Always tries "done" on an action turn; says "not complete" on the FIRST
 *  self-check and "complete" thereafter. */
class CriticProvider implements Provider {
  readonly name = "critic";
  readonly supportsVision = false;
  reflections = 0;
  doneAttempts = 0;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const text = textOf(req);
    if (text.includes("planning module")) {
      return { text: JSON.stringify([{ title: "do", description: "the work" }]), toolCalls: [] };
    }
    if (text.includes("SELF-CHECK")) {
      this.reflections += 1;
      return this.reflections === 1
        ? { text: JSON.stringify({ complete: false, reason: "a step is missing", nextStep: "finish it" }), toolCalls: [] }
        : { text: JSON.stringify({ complete: true, reason: "all good" }), toolCalls: [] };
    }
    this.doneAttempts += 1;
    return { text: JSON.stringify({ thought: "I think I'm done", action: "done", params: {}, message: "finished" }), toolCalls: [] };
  }
}

/** Never self-checks (used for the disabled case). */
class EagerProvider implements Provider {
  readonly name = "eager";
  readonly supportsVision = false;
  reflections = 0;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const text = textOf(req);
    if (text.includes("planning module")) return { text: JSON.stringify([{ title: "do", description: "it" }]), toolCalls: [] };
    if (text.includes("SELF-CHECK")) { this.reflections += 1; return { text: JSON.stringify({ complete: false, reason: "x" }), toolCalls: [] }; }
    return { text: JSON.stringify({ thought: "done", action: "done", params: {}, message: "done" }), toolCalls: [] };
  }
}

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-reflect-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  const orig = getConfig().enableReflection;

  try {
    // ---- 1. reflection blocks a premature done, then accepts ----
    saveConfig({ enableReflection: true });
    {
      const provider = new CriticProvider();
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let doneEvents = 0;
      loop.on("done", () => { doneEvents += 1; });
      await loop.run("do the thing");
      await settle();
      ok("self-check ran (consulted twice)", provider.reflections === 2);
      ok("agent tried to finish twice (first done was sent back)", provider.doneAttempts === 2);
      ok("done is emitted exactly once, after the goal is verified", doneEvents === 1);
    }

    // ---- 2. disabled → done accepted immediately, no self-check ----
    saveConfig({ enableReflection: false });
    {
      const provider = new EagerProvider();
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let doneEvents = 0;
      loop.on("done", () => { doneEvents += 1; });
      await loop.run("do the thing");
      await settle();
      ok("disabled: no self-check call", provider.reflections === 0);
      ok("disabled: done accepted immediately", doneEvents === 1);
    }
  } finally {
    saveConfig({ enableReflection: orig });
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nREFLECTION VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
