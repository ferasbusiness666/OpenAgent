/**
 * verify-toolcall.ts — native function-calling.
 *  1. The loop consumes a provider's STRUCTURED toolCalls (not text JSON): a
 *     native filesystem-write tool call runs, and a native `done` finishes.
 *  2. A native `update_plan` tool call updates the plan (phaseUpdate fires).
 *  3. Each API provider sends native tools and parses a tool_use response
 *     (fetch intercepted — no network).
 */
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { APIProvider } from "../src/providers/api.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import type { Provider, GenerateRequest, GenerateResult, ToolCall } from "../src/providers/index.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const reqText = (r: GenerateRequest): string => r.system + "\n" + r.messages.map((m) => m.content).join("\n");

/** Drives the loop purely via structured toolCalls (native function-calling). */
class ToolCallProvider implements Provider {
  readonly name = "toolcall";
  readonly supportsVision = false;
  private step = 0;
  constructor(private readonly script: ToolCall[][]) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (reqText(req).includes("planning module")) {
      return { text: JSON.stringify([{ title: "a", description: "b" }, { title: "c", description: "d" }]), toolCalls: [] };
    }
    const calls = this.script[this.step] ?? [{ name: "done", arguments: { message: "fallback" } }];
    this.step += 1;
    return { text: "", toolCalls: calls };
  }
}

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-toolcall-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  const origReflect = getConfig().enableReflection;
  saveConfig({ enableReflection: false }); // deterministic: no self-check re-prompts

  try {
    // ---- 1. native tool call executes; native done finishes ----
    {
      const provider = new ToolCallProvider([
        [{ name: "filesystem", arguments: { operation: "write", path: "tc.txt", content: "native" } }],
        [{ name: "done", arguments: { message: "finished via tools" } }],
      ]);
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let doneMsg = "";
      loop.on("done", (m) => { doneMsg = m; });
      await loop.run("write a file");
      await settle();
      ok("native filesystem tool call executed", fs.readFileSync(path.join(ws, "tc.txt"), "utf8") === "native");
      ok("native done tool call finished with its message", doneMsg === "finished via tools");
    }

    // ---- 2. native update_plan tool call updates the plan ----
    {
      const provider = new ToolCallProvider([
        [{ name: "update_plan", arguments: { phase: 1, status: "completed", finding: "did step 1" } }],
        [{ name: "done", arguments: { message: "ok" } }],
      ]);
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let phase1Completed = false;
      loop.on("phaseUpdate", (phases) => {
        if (phases.some((p) => p.id === 1 && p.status === "completed")) phase1Completed = true;
      });
      await loop.run("do two steps");
      await settle();
      ok("native update_plan marked phase 1 completed", phase1Completed);
    }
  } finally {
    saveConfig({ enableReflection: origReflect });
    fs.removeSync(ws);
  }

  // ---- 3. providers send native tools + parse a tool_use response ----
  let cap: Record<string, unknown> | null = null;
  const install = (responder: () => unknown): void => {
    globalThis.fetch = (async (_i: unknown, init?: RequestInit): Promise<Response> => {
      cap = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const b = responder();
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(b), json: async () => b } as unknown as Response;
    }) as typeof fetch;
  };
  const toolReq: GenerateRequest = {
    system: "S",
    messages: [{ role: "user", content: "act" }],
    tools: [{ name: "done", description: "finish", parameters: { type: "object", properties: { message: { type: "string" } }, required: [] } }],
  };

  install(() => ({ content: [{ type: "tool_use", name: "done", input: { message: "a" } }] }));
  let r = await new APIProvider("k", "anthropic", "").generate(toolReq);
  ok("anthropic sends tools + parses tool_use", r.toolCalls[0]?.name === "done" && cap !== null && "tools" in cap);

  install(() => ({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "done", arguments: '{"message":"a"}' } }] } }] }));
  r = await new APIProvider("k", "openai", "").generate(toolReq);
  ok("openai sends tools + parses tool_calls", r.toolCalls[0]?.name === "done" && (r.toolCalls[0]?.arguments.message === "a"));

  install(() => ({ candidates: [{ content: { parts: [{ functionCall: { name: "done", args: { message: "a" } } }] } }] }));
  r = await new APIProvider("k", "google", "").generate(toolReq);
  ok("gemini sends tools + parses functionCall", r.toolCalls[0]?.name === "done");

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nTOOLCALL VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
