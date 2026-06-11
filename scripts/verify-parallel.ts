/**
 * verify-parallel.ts — IMP-02 (parallel tool execution) + IMP-05 (verification
 * may use read-only tools).
 *  1. A native turn with TWO tool calls executes both (one provider turn).
 *  2. A text turn with an "actions" array executes both.
 *  3. A turn mixing tools with "done" runs the tools and drops the premature
 *     done; the task finishes on the next turn.
 *  4. The verification pass re-reads a generated file before its verdict.
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
const planReply = (): GenerateResult => ({
  text: JSON.stringify([{ title: "a", description: "b" }]),
  toolCalls: [],
});

/** Step-scripted provider: planning is answered automatically, then `steps`. */
class Scripted implements Provider {
  readonly name = "parallel";
  readonly supportsVision = false;
  actionTurns = 0;
  constructor(private readonly steps: Array<(req: GenerateRequest) => GenerateResult>) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (textOf(req).includes("planning module")) return planReply();
    const step = this.steps[this.actionTurns];
    this.actionTurns += 1;
    return step
      ? step(req)
      : { text: "", toolCalls: [{ name: "done", arguments: { message: "fallback" } }] };
  }
}

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-parallel-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  const origReflect = getConfig().enableReflection;
  saveConfig({ enableReflection: false });

  try {
    // ---- 1. native batch: two tool calls in one turn ----
    {
      const provider = new Scripted([
        () => ({
          text: "",
          toolCalls: [
            { name: "filesystem", arguments: { operation: "write", path: "p1.txt", content: "one" } },
            { name: "filesystem", arguments: { operation: "write", path: "p2.txt", content: "two" } },
          ],
        }),
        () => ({ text: "", toolCalls: [{ name: "done", arguments: { message: "ok" } }] }),
      ]);
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let toolCalls = 0;
      let toolResults = 0;
      loop.on("toolCall", () => { toolCalls += 1; });
      loop.on("toolResult", (d) => { if (d.success) toolResults += 1; });
      await loop.run("write two files");
      await settle();
      ok("native batch: both files written",
        fs.readFileSync(path.join(ws, "p1.txt"), "utf8") === "one" &&
        fs.readFileSync(path.join(ws, "p2.txt"), "utf8") === "two");
      ok("native batch: two toolCall + two toolResult events", toolCalls === 2 && toolResults === 2);
      ok("native batch: one provider turn produced both", provider.actionTurns === 2);
    }

    // ---- 2. text "actions" array ----
    {
      const provider = new Scripted([
        () => ({
          text: JSON.stringify({
            thought: "two independent writes",
            actions: [
              { action: "filesystem", params: { operation: "write", path: "t1.txt", content: "A" } },
              { action: "filesystem", params: { operation: "write", path: "t2.txt", content: "B" } },
            ],
          }),
          toolCalls: [],
        }),
        () => ({
          text: JSON.stringify({ thought: "", action: "done", params: {}, message: "ok" }),
          toolCalls: [],
        }),
      ]);
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      await loop.run("write two files via text");
      await settle();
      ok("text actions array: both files written",
        fs.readFileSync(path.join(ws, "t1.txt"), "utf8") === "A" &&
        fs.readFileSync(path.join(ws, "t2.txt"), "utf8") === "B");
    }

    // ---- 3. mixed tools + premature done ----
    {
      const provider = new Scripted([
        () => ({
          text: "",
          toolCalls: [
            { name: "filesystem", arguments: { operation: "write", path: "mix.txt", content: "m" } },
            { name: "done", arguments: { message: "too early" } },
          ],
        }),
        () => ({ text: "", toolCalls: [{ name: "done", arguments: { message: "actually done" } }] }),
      ]);
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let doneMsg = "";
      let doneEvents = 0;
      loop.on("done", (m) => { doneMsg = m; doneEvents += 1; });
      await loop.run("mixed turn");
      await settle();
      ok("mixed turn: the tool still ran",
        fs.readFileSync(path.join(ws, "mix.txt"), "utf8") === "m");
      ok("mixed turn: premature done dropped, finished next turn",
        doneEvents === 1 && doneMsg === "actually done" && provider.actionTurns === 2);
    }

    // ---- 4. verification uses a read-only tool before its verdict ----
    saveConfig({ enableReflection: true });
    {
      let sawObservation = false;
      const provider: Provider = new (class implements Provider {
        readonly name = "verifier";
        readonly supportsVision = false;
        selfChecks = 0;
        async generate(req: GenerateRequest): Promise<GenerateResult> {
          const text = textOf(req);
          if (text.includes("planning module")) return planReply();
          if (text.includes("SELF-CHECK")) {
            this.selfChecks += 1;
            if (this.selfChecks === 1) {
              // First round: ask to re-read the generated file.
              return {
                text: "",
                toolCalls: [{ name: "filesystem", arguments: { operation: "read", path: "v.txt" } }],
              };
            }
            // Second round: the observation must be visible in the request.
            sawObservation = text.includes("[verify filesystem read]") && text.includes("verified-content");
            return { text: "", toolCalls: [{ name: "verdict", arguments: { complete: true, reason: "checked" } }] };
          }
          // One action turn: write the file, then declare done.
          if (!text.includes("[filesystem]")) {
            return {
              text: "",
              toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: "v.txt", content: "verified-content" } }],
            };
          }
          return { text: "", toolCalls: [{ name: "done", arguments: { message: "wrote it" } }] };
        }
      })();
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let doneEvents = 0;
      loop.on("done", () => { doneEvents += 1; });
      await loop.run("write v.txt");
      await settle();
      ok("verification read the file and saw its content", sawObservation);
      ok("native verdict accepted; done emitted once", doneEvents === 1);
    }
  } finally {
    saveConfig({ enableReflection: origReflect });
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nPARALLEL VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
