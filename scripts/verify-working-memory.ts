/**
 * verify-working-memory.ts — IMP-08 (WorkingMemory class + loop integration).
 *
 * Part A: class-level tests (no loop).
 * Part B: loop integration with a scripted provider.
 */
import { WorkingMemory } from "../src/agent/working-memory.js";
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
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

// ---------------------------------------------------------------------------
// Scripted provider: handles planning automatically, then plays a script.
// ---------------------------------------------------------------------------
class Scripted implements Provider {
  readonly name = "scripted";
  readonly supportsVision = false;
  private step = 0;
  readonly requests: GenerateRequest[] = [];
  constructor(private readonly script: Array<() => GenerateResult>) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const text = req.system + "\n" + req.messages.map((m) => m.content).join("\n");
    if (text.includes("planning module")) {
      return {
        text: JSON.stringify([{ title: "step", description: "do it" }]),
        toolCalls: [],
      };
    }
    const fn = this.script[this.step];
    this.step += 1;
    return fn
      ? fn()
      : { text: "", toolCalls: [{ name: "done", arguments: { message: "fallback done" } }] };
  }
}

// ---------------------------------------------------------------------------
// Part A — WorkingMemory class (no loop)
// ---------------------------------------------------------------------------
function testPartA(): void {
  // --- Dedupe: same fact twice → stored once ---
  {
    const wm = new WorkingMemory();
    wm.addFact("the repo uses pnpm");
    wm.addFact("the repo uses pnpm");
    ok("dedupe: same fact twice → 1 entry", wm.data.facts.length === 1);
  }

  // --- Cap: 16 addFact calls → only 15 stored (oldest evicted) ---
  {
    const wm = new WorkingMemory();
    for (let i = 0; i < 16; i++) wm.addFact(`fact number ${i}`);
    ok("cap: 16 facts → 15 stored", wm.data.facts.length === 15);
    // "fact number 0" is the oldest and should be evicted.
    ok("cap: oldest evicted first", !wm.data.facts.includes("fact number 0"));
    ok("cap: newest retained", wm.data.facts.includes("fact number 15"));
  }

  // --- applyNote returns count of real changes ---
  {
    const wm = new WorkingMemory();
    const count1 = wm.applyNote({ facts: ["new fact a", "new fact b"], variables: { key: "val" } });
    ok("applyNote: returns 3 changes on first apply", count1 === 3);
    // Applying same data again → 0 real changes
    const count2 = wm.applyNote({ facts: ["new fact a", "new fact b"], variables: { key: "val" } });
    ok("applyNote: returns 0 changes on duplicate apply", count2 === 0);
  }

  // --- from(garbage) → empty ---
  {
    const wm = WorkingMemory.from("not an object");
    ok("from(garbage): isEmpty() true", wm.isEmpty());
    const wm2 = WorkingMemory.from(null);
    ok("from(null): isEmpty() true", wm2.isEmpty());
    const wm3 = WorkingMemory.from([1, 2, 3]);
    ok("from(array): isEmpty() true", wm3.isEmpty());
  }

  // --- from(valid snapshot) round-trips via .data ---
  {
    const original = new WorkingMemory();
    original.addFact("port is 3000");
    original.addConstraint("never delete files");
    original.addArtifact("output.json");
    original.setVariable("env", "staging");

    const snapshot = original.data;
    const restored = WorkingMemory.from(snapshot);
    const d = restored.data;

    ok("round-trip: facts preserved", d.facts.includes("port is 3000"));
    ok("round-trip: constraints preserved", d.constraints.includes("never delete files"));
    ok("round-trip: artifacts preserved", d.artifacts.includes("output.json"));
    ok("round-trip: variables preserved", d.variables["env"] === "staging");
  }

  // --- render() omits empty sections ---
  {
    const wm = new WorkingMemory();
    ok("render(): empty → empty string", wm.render() === "");

    wm.addFact("only fact");
    const rendered = wm.render();
    ok("render(): has Facts section", rendered.includes("Facts:"));
    ok("render(): no Constraints section when empty", !rendered.includes("Constraints:"));
    ok("render(): no Artifacts section when empty", !rendered.includes("Artifacts:"));
    ok("render(): no Variables section when empty", !rendered.includes("Variables:"));
  }
}

// ---------------------------------------------------------------------------
// Part B — Loop integration
// ---------------------------------------------------------------------------
async function testPartB(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-wm-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  const origReflect = getConfig().enableReflection;
  saveConfig({ enableReflection: false });

  try {
    // ---- B1 / B2 / B3: note action, artifact auto-tracking, no toolCall for note ----
    {
      const provider = new Scripted([
        // Turn 1: native "note" tool call with facts + variable
        () => ({
          text: "",
          toolCalls: [{ name: "note", arguments: { facts: ["the port is 4001"], variables: { env: "prod" } } }],
        }),
        // Turn 2: filesystem write (triggers auto-artifact tracking)
        () => ({
          text: "",
          toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: "wm.txt", content: "hello" } }],
        }),
        // Turn 3: done
        () => ({
          text: "",
          toolCalls: [{ name: "done", arguments: { message: "all done" } }],
        }),
      ]);

      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let toolCallCount = 0;
      loop.on("toolCall", () => { toolCallCount += 1; });

      await loop.run("do the task");
      await settle();

      // After the note turn, the NEXT request should contain "# Working memory"
      // and "the port is 4001" and "env = prod". The note turn produces requests
      // at indices: 0=planning, 1=note turn itself (doesn't contain WM yet since
      // WM is injected INTO this request pre-turn), actually the WM is injected
      // into the request that contains the current turn's final user message.
      //
      // The note is applied AFTER the provider returns it; so:
      //   req[0] = planning
      //   req[1] = first action turn (no WM yet)
      //   req[2] = turn after note was applied → SHOULD contain WM
      //   req[3] = turn after filesystem write → SHOULD contain "wm.txt" in Artifacts
      //   req[4] = planning for sub-run (or just done)
      //
      // Let's check request at index 2 (after note) contains the WM content.
      const reqAfterNote = provider.requests[2];
      const textAfterNote = reqAfterNote
        ? reqAfterNote.system + "\n" + reqAfterNote.messages.map((m) => m.content).join("\n")
        : "";
      ok(
        "B1: request after note contains '# Working memory'",
        textAfterNote.includes("Working memory") || textAfterNote.includes("working memory") || textAfterNote.includes("# Working memory"),
      );
      ok(
        "B1: request after note contains 'the port is 4001'",
        textAfterNote.includes("the port is 4001"),
      );
      ok(
        "B1: request after note contains 'env = prod'",
        textAfterNote.includes("env = prod"),
      );

      // After filesystem write, wm.txt should appear in Artifacts in the next request.
      const reqAfterWrite = provider.requests[3];
      const textAfterWrite = reqAfterWrite
        ? reqAfterWrite.system + "\n" + reqAfterWrite.messages.map((m) => m.content).join("\n")
        : "";
      ok(
        "B2: request after write has 'wm.txt' in Artifacts",
        textAfterWrite.includes("wm.txt"),
      );

      // Note turn must NOT have fired a toolCall event (note is handled internally).
      // Only 1 toolCall event: the filesystem write.
      ok(
        "B3: exactly 1 toolCall event (note is internal; filesystem is the only real one)",
        toolCallCount === 1,
      );
    }

    // ---- B4: restoring pre-seeded workingMemory via options.workingMemory ----
    {
      const seeded: unknown = {
        facts: ["seeded fact"],
        constraints: [],
        artifacts: [],
        variables: {},
      };
      const provider2 = new Scripted([
        () => ({
          text: "",
          toolCalls: [{ name: "done", arguments: { message: "done immediately" } }],
        }),
      ]);
      const loop2 = new AgentLoop(provider2, new SessionMemory(), new AgentMemory(), {
        workingMemory: seeded,
      });
      await loop2.run("seeded run");
      await settle();

      // The FIRST action request (index 1, after planning at 0) should contain "seeded fact".
      const firstActionReq = provider2.requests[1];
      const firstActionText = firstActionReq
        ? firstActionReq.system + "\n" + firstActionReq.messages.map((m) => m.content).join("\n")
        : "";
      ok(
        "B4: first request already contains seeded fact",
        firstActionText.includes("seeded fact"),
      );
    }
  } finally {
    saveConfig({ enableReflection: origReflect });
    fs.removeSync(ws);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  testPartA();
  await testPartB();

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nWORKING_MEMORY VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
