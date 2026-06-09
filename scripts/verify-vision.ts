/**
 * verify-vision.ts — Phase D vision wiring.
 *  1. buildGenerateRequest attaches images to the final user turn.
 *  2. Each API provider encodes an image in its native wire format (fetch is
 *     intercepted — no network). CLIProvider reports supportsVision=false.
 *  3. End-to-end: the loop reads a screenshot the agent took and shows it to a
 *     vision-capable provider on the NEXT turn (guarded on the browser tool).
 */
import { buildGenerateRequest } from "../src/agent/planner.js";
import { APIProvider } from "../src/providers/api.js";
import { CLIProvider } from "../src/providers/cli.js";
import type { GenerateRequest, GenerateResult } from "../src/providers/index.js";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { setActiveWorkspace } from "../src/config/index.js";
import { isBrowserAvailable, closeBrowser } from "../src/tools/index.js";
import type { Provider } from "../src/providers/index.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let cap: Record<string, unknown> | null = null;
function install(responder: (url: string) => unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    cap = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const body = responder(url);
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
  }) as typeof fetch;
}
const flat = (v: unknown): string => JSON.stringify(v);

async function main(): Promise<void> {
  // ---- 1. buildGenerateRequest attaches images to the final user turn ----
  const req = buildGenerateRequest({
    agentMd: "M",
    workspacePath: "/ws",
    history: [{ role: "user", content: "look", timestamp: new Date() }],
    phases: [],
    images: [{ data: "XYZ", mediaType: "image/png" }],
  });
  const lastMsg = req.messages[req.messages.length - 1]!;
  ok("buildGenerateRequest attaches images to the last user turn", (lastMsg.images?.[0]?.data) === "XYZ");

  // ---- 2. provider encodings ----
  const visReq: GenerateRequest = {
    system: "S",
    messages: [{ role: "user", content: "see", images: [{ data: "ABCD", mediaType: "image/png" }] }],
  };
  ok("APIProvider.supportsVision is true", new APIProvider("k", "anthropic", "").supportsVision === true);
  ok("CLIProvider.supportsVision is false", new CLIProvider("claude", "").supportsVision === false);

  install(() => ({ content: [{ type: "text", text: "ok" }] }));
  await new APIProvider("k", "anthropic", "").generate(visReq);
  ok("anthropic encodes a base64 image block", flat(cap?.messages).includes('"type":"image"') && flat(cap?.messages).includes('"data":"ABCD"'));

  install(() => ({ choices: [{ message: { content: "ok" } }] }));
  await new APIProvider("k", "openai", "").generate(visReq);
  ok("openai encodes an image_url data URI", flat(cap?.messages).includes("image_url") && flat(cap?.messages).includes("data:image/png;base64,ABCD"));

  install(() => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
  await new APIProvider("k", "google", "").generate(visReq);
  ok("gemini encodes inlineData", flat(cap?.contents).includes("inlineData") && flat(cap?.contents).includes('"data":"ABCD"'));

  // ---- 3. end-to-end: screenshot → seen on the next turn ----
  if (isBrowserAvailable()) {
    const ws = path.join(os.tmpdir(), "openagent-vision-" + Date.now());
    fs.ensureDirSync(ws);
    setActiveWorkspace(ws);

    let sawImageOnNextTurn = false;
    let step = 0;
    const provider: Provider = {
      name: "scripted-vision",
      supportsVision: true,
      async generate(r: GenerateRequest): Promise<GenerateResult> {
        const text = r.system + "\n" + r.messages.map((m) => m.content).join("\n");
        if (text.includes("planning module")) {
          return { text: JSON.stringify([{ title: "shot", description: "screenshot the page" }]), toolCalls: [] };
        }
        // If any message carries an image, the screenshot reached the model.
        if (r.messages.some((m) => (m.images?.length ?? 0) > 0)) sawImageOnNextTurn = true;
        step += 1;
        if (step === 1) {
          return { text: JSON.stringify({ thought: "open", action: "browser", params: { operation: "navigate", url: "data:text/html,<h1>hi</h1>" } }), toolCalls: [] };
        }
        if (step === 2) {
          return { text: JSON.stringify({ thought: "shoot", action: "browser", params: { operation: "screenshot" } }), toolCalls: [] };
        }
        return { text: JSON.stringify({ thought: "done", action: "done", params: {}, message: "ok" }), toolCalls: [] };
      },
    };

    const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
    await loop.run("screenshot the page and look at it");
    await sleep(30);
    ok("a screenshot the agent took is shown to it on the next turn", sawImageOnNextTurn);
    await closeBrowser();
    fs.removeSync(ws);
  } else {
    console.log("i browser unavailable — skipping end-to-end screenshot→vision test");
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nVISION VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
