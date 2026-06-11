/**
 * verify-fewshot.ts — IMP-09 (few-shot success-pattern recording + injection).
 *
 *  1. Recording: two filesystem writes → done → success_pattern note stored.
 *  2. Injection: pre-seeded store → "Past successful approaches" in request.
 *  3. Gating: loop WITHOUT sessionManager → NO new success_pattern note.
 *
 * The local embedding backend may activate here (no API key set); that's fine —
 * we don't intercept fetch. Just allow a bit of extra time for the first run.
 */
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { LongTermMemory } from "../src/memory/longterm.js";
import { SessionManager } from "../src/memory/session-manager.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import type { Provider, GenerateRequest, GenerateResult } from "../src/providers/index.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const settle = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------
class Scripted implements Provider {
  readonly name = "scripted-fewshot";
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

// Two-writes-then-done script factory.
function twoWritesThenDone(file1: string, file2: string): Array<() => GenerateResult> {
  return [
    () => ({
      text: "",
      toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: file1, content: "x" } }],
    }),
    () => ({
      text: "",
      toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: file2, content: "y" } }],
    }),
    () => ({
      text: "",
      toolCalls: [{ name: "done", arguments: { message: "wrote both files" } }],
    }),
  ];
}

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-fewshot-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);

  const origReflect = getConfig().enableReflection;
  saveConfig({ enableReflection: false });

  try {
    // ---- 1. Recording ----
    {
      const ltmDir = path.join(os.tmpdir(), "openagent-ltm-rec-" + Date.now());
      fs.ensureDirSync(ltmDir);
      const ltm = new LongTermMemory(ltmDir);
      const sm = new SessionManager();

      const provider = new Scripted(twoWritesThenDone("rec1.txt", "rec2.txt"));
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory(), {
        longTermMemory: ltm,
        sessionManager: sm,
      });

      await loop.run("write two files to test recording");
      // recordSuccessPattern is fire-and-forget — give it time to settle.
      await settle(600);

      const notes = ltm.list();
      const patternNotes = notes.filter((n) => n.tags.includes("success_pattern"));
      ok("recording: at least one success_pattern note created", patternNotes.length >= 1);

      if (patternNotes.length > 0) {
        const firstId = patternNotes[0]?.id ?? "";
        const content = ltm.read(firstId) ?? "";
        ok(
          "recording: success_pattern note contains 'filesystem → filesystem'",
          content.includes("filesystem → filesystem"),
        );
      } else {
        ok("recording: success_pattern note contains 'filesystem → filesystem'", false);
      }
      fs.removeSync(ltmDir);
    }

    // ---- 2. Injection: pre-seeded store surfaces "Past successful approaches" ----
    {
      const ltmDir2 = path.join(os.tmpdir(), "openagent-ltm-inj-" + Date.now());
      fs.ensureDirSync(ltmDir2);
      const ltm2 = new LongTermMemory(ltmDir2);

      // Pre-seed a success_pattern note (importance 6, as recordSuccessPattern uses).
      await ltm2.rememberWithEmbedding(
        "Task: write two files\nSuccessful approach (2 steps): filesystem → filesystem",
        ["success_pattern"],
        6,
      );

      const sm2 = new SessionManager();
      // This provider just immediately says done — we only care about what's
      // injected into the planning requests.
      const provider2 = new Scripted([
        () => ({
          text: "",
          toolCalls: [{ name: "done", arguments: { message: "already done" } }],
        }),
      ]);
      const loop2 = new AgentLoop(provider2, new SessionMemory(), new AgentMemory(), {
        longTermMemory: ltm2,
        sessionManager: sm2,
      });

      await loop2.run("write two files");
      await settle(300);

      // The few-shot guidance is injected as a system role message in the session
      // before the first action turn. buildGenerateRequest maps "system" messages
      // as "SYSTEM NOTE:\n..." in user turns. So we look in the requests for the
      // phrase "Past successful approaches".
      const allText = provider2.requests
        .flatMap((r) => r.messages)
        .map((m) => m.content)
        .join("\n");
      ok(
        "injection: some request contains 'Past successful approaches'",
        allText.includes("Past successful approaches"),
      );
      fs.removeSync(ltmDir2);
    }

    // ---- 3. Gating: no sessionManager → no success_pattern note ----
    {
      const ltmDir3 = path.join(os.tmpdir(), "openagent-ltm-gate-" + Date.now());
      fs.ensureDirSync(ltmDir3);
      const ltm3 = new LongTermMemory(ltmDir3);

      const countBefore = ltm3.list().filter((n) => n.tags.includes("success_pattern")).length;

      // No sessionManager passed.
      const provider3 = new Scripted(twoWritesThenDone("gate1.txt", "gate2.txt"));
      const loop3 = new AgentLoop(provider3, new SessionMemory(), new AgentMemory(), {
        longTermMemory: ltm3,
        // NO sessionManager
      });

      await loop3.run("write two files gating test");
      await settle(600);

      const countAfter = ltm3.list().filter((n) => n.tags.includes("success_pattern")).length;
      ok(
        "gating: no sessionManager → no new success_pattern note",
        countAfter === countBefore,
      );
      fs.removeSync(ltmDir3);
    }
  } finally {
    saveConfig({ enableReflection: origReflect });
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nFEWSHOT VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
