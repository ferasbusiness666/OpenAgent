/**
 * verify-usage.ts — tests for provider usage parsing (IMP-17) and loop
 * accumulation + budget gate (IMP-23).
 *
 * Part A — offline provider usage parsing (fetch intercepted).
 * Part B — loop accumulation + budget gate.
 * Part C — mock providers (MockProvider, RecordingProvider, ReplayProvider).
 */

import { APIProvider } from "../src/providers/api.js";
import { MockProvider, RecordingProvider, ReplayProvider } from "../src/providers/mock.js";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import type { Provider, GenerateRequest, GenerateResult } from "../src/providers/index.js";
import type { SessionUsage } from "../src/agent/usage.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const reqText = (r: GenerateRequest): string =>
  r.system + "\n" + r.messages.map((m) => m.content).join("\n");

// ── Fetch mock helper (mirrors verify-toolcall.ts) ──────────────────────────

type MockFetch = (input: unknown, init?: RequestInit) => Promise<Response>;
let originalFetch: typeof globalThis.fetch;

function installFetch(responder: () => unknown): void {
  (globalThis as { fetch: MockFetch }).fetch = async (
    _input: unknown,
    _init?: RequestInit,
  ): Promise<Response> => {
    const b = responder();
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(b),
      json: async () => b,
    } as unknown as Response;
  };
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ── Scripted provider for Part B ─────────────────────────────────────────────

class ScriptedUsageProvider implements Provider {
  readonly name = "api:anthropic (claude-sonnet-4)";
  readonly supportsVision = false;
  private step = 0;
  private readonly writeResult: GenerateResult;
  private readonly doneResult: GenerateResult;

  constructor() {
    this.writeResult = {
      text: "",
      toolCalls: [
        {
          name: "filesystem",
          arguments: { operation: "write", path: "u.txt", content: "x" },
        },
      ],
      usage: { inputTokens: 1000, outputTokens: 500 },
    };
    this.doneResult = {
      text: "",
      toolCalls: [{ name: "done", arguments: { message: "done" } }],
      usage: { inputTokens: 1000, outputTokens: 500 },
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // Planning module: return phases array.
    if (reqText(req).includes("planning module")) {
      return {
        text: JSON.stringify([
          { title: "a", description: "b" },
          { title: "c", description: "d" },
        ]),
        toolCalls: [],
      };
    }
    const current = this.step;
    this.step += 1;
    if (current === 0) return this.writeResult;
    return this.doneResult;
  }
}

// ── Budget-exceeding scripted provider ────────────────────────────────────────

class AlwaysWriteProvider implements Provider {
  readonly name = "api:anthropic (claude-sonnet-4)";
  readonly supportsVision = false;

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (reqText(req).includes("planning module")) {
      return {
        text: JSON.stringify([
          { title: "a", description: "b" },
        ]),
        toolCalls: [],
      };
    }
    return {
      text: "",
      toolCalls: [
        {
          name: "filesystem",
          arguments: { operation: "write", path: "bgt.txt", content: "x" },
        },
      ],
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  originalFetch = globalThis.fetch;

  const origReflect = getConfig().enableReflection;
  const origBudget = getConfig().budgetUsd;

  // ===========================================================================
  // Part A — provider usage parsing (offline, fetch intercepted)
  // ===========================================================================

  // ---- A1. Anthropic usage (cache_read + cache_creation fold into inputTokens) ----
  {
    installFetch(() => ({
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
      },
    }));
    const r = await new APIProvider("k", "anthropic", "").generate({
      system: "S",
      messages: [{ role: "user", content: "act" }],
    });
    restoreFetch();
    // input_tokens(100) + cache_creation_input_tokens(10) = 110
    ok(
      "Anthropic usage: inputTokens=110, outputTokens=50, cacheReadTokens=30",
      r.usage !== undefined &&
        r.usage.inputTokens === 110 &&
        r.usage.outputTokens === 50 &&
        r.usage.cacheReadTokens === 30,
    );
  }

  // ---- A2. OpenAI usage + cached_tokens ----------------------------------------
  {
    installFetch(() => ({
      choices: [{ message: { content: "hi" } }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 150 },
      },
    }));
    const r = await new APIProvider("k", "openai", "").generate({
      system: "S",
      messages: [{ role: "user", content: "act" }],
    });
    restoreFetch();
    ok(
      "OpenAI usage: inputTokens=200, outputTokens=20, cacheReadTokens=150",
      r.usage !== undefined &&
        r.usage.inputTokens === 200 &&
        r.usage.outputTokens === 20 &&
        r.usage.cacheReadTokens === 150,
    );
  }

  // ---- A3. Gemini usage (no cache field) ---------------------------------------
  {
    installFetch(() => ({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 30 },
    }));
    const r = await new APIProvider("k", "google", "").generate({
      system: "S",
      messages: [{ role: "user", content: "act" }],
    });
    restoreFetch();
    ok(
      "Gemini usage: inputTokens=300, outputTokens=30, cacheReadTokens=undefined",
      r.usage !== undefined &&
        r.usage.inputTokens === 300 &&
        r.usage.outputTokens === 30 &&
        r.usage.cacheReadTokens === undefined,
    );
  }

  // ---- A4. No usage in response → result.usage === undefined -------------------
  {
    installFetch(() => ({
      content: [{ type: "text", text: "hi" }],
      // no usage field
    }));
    const r = await new APIProvider("k", "anthropic", "").generate({
      system: "S",
      messages: [{ role: "user", content: "act" }],
    });
    restoreFetch();
    ok("No usage in response → result.usage === undefined", r.usage === undefined);
  }

  // ===========================================================================
  // Part B — loop accumulation + budget gate
  // ===========================================================================

  const ws1 = path.join(os.tmpdir(), "openagent-usage-b-" + Date.now());
  fs.ensureDirSync(ws1);

  saveConfig({ enableReflection: false, budgetUsd: 0 });
  setActiveWorkspace(ws1);

  try {
    // ---- B5. Loop accumulation: at least 2 usage events, last totals >= 2000 in ----
    {
      const provider = new ScriptedUsageProvider();
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      const usageEvents: SessionUsage[] = [];
      loop.on("usage", (u) => usageEvents.push({ ...u }));
      await loop.run("write a file");
      await settle();
      const last = usageEvents[usageEvents.length - 1];
      ok("usage events: at least 2 emitted", usageEvents.length >= 2);
      ok(
        "last usage event: inputTokens >= 2000",
        last !== undefined && last.inputTokens >= 2000,
      );
      ok("last usage event: costUsd > 0", last !== undefined && last.costUsd > 0);
    }

    // ---- B6. Budget gate: loop emits "stuck" with "Budget" message --------------
    {
      saveConfig({ budgetUsd: 0.001 });
      setActiveWorkspace(ws1);
      const provider = new AlwaysWriteProvider();
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let stuckMsg = "";
      let doneMsg = "";
      loop.on("stuck", (m) => { stuckMsg = m; });
      loop.on("done", (m) => { doneMsg = m; });
      await loop.run("keep writing");
      await settle();
      ok(
        "budget gate: emits stuck (not done) with Budget in message",
        stuckMsg.includes("Budget") && doneMsg === "",
      );
      saveConfig({ budgetUsd: 0 });
    }
  } finally {
    fs.removeSync(ws1);
  }

  // ===========================================================================
  // Part C — mock providers
  // ===========================================================================

  // ---- C7. MockProvider: script consumed, exhaustion returns safe done JSON ----
  {
    const scriptResult: GenerateResult = { text: "a", toolCalls: [] };
    const mock = new MockProvider([scriptResult]);
    const r1 = await mock.generate({ system: "S", messages: [{ role: "user", content: "q1" }] });
    const r2 = await mock.generate({ system: "S", messages: [{ role: "user", content: "q2" }] });
    ok("MockProvider: first result is the scripted one", r1.text === "a");
    ok(
      "MockProvider: exhaustion result text contains 'mock script exhausted'",
      r2.text.includes("mock script exhausted"),
    );
    ok("MockProvider: requests getter recorded 2 requests", mock.requests.length === 2);
  }

  // ---- C8. RecordingProvider + ReplayProvider ---------------------------------
  {
    const fixturePath = path.join(os.tmpdir(), "openagent-fixture-" + Date.now() + ".jsonl");
    try {
      const inner = new MockProvider([
        { text: "result-one", toolCalls: [] },
        { text: "result-two", toolCalls: [] },
      ]);
      const recorder = new RecordingProvider(inner, fixturePath);

      const req1: GenerateRequest = { system: "S", messages: [{ role: "user", content: "m1" }] };
      const req2: GenerateRequest = { system: "S", messages: [{ role: "user", content: "m2" }] };
      const rec1 = await recorder.generate(req1);
      const rec2 = await recorder.generate(req2);

      // Give RecordingProvider a moment to flush (it writes synchronously, but be safe).
      await settle();

      // Fixture file must exist and have 2 valid lines.
      const fixtureExists = fs.existsSync(fixturePath);
      let lineCount = 0;
      let parsedOk = true;
      if (fixtureExists) {
        const raw = fs.readFileSync(fixturePath, "utf8");
        const lines = raw.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
        lineCount = lines.length;
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as { request?: unknown; result?: unknown };
            if (!parsed.request || !parsed.result) parsedOk = false;
          } catch {
            parsedOk = false;
          }
        }
      }
      ok(
        "RecordingProvider: fixture has 2 JSONL lines with {request, result}",
        fixtureExists && lineCount === 2 && parsedOk,
      );

      // ReplayProvider replays in order, throws when exhausted.
      const replay = new ReplayProvider(fixturePath);
      const rp1 = await replay.generate(req1);
      const rp2 = await replay.generate(req2);
      ok("ReplayProvider: returns same result.text values in order", rp1.text === rec1.text && rp2.text === rec2.text);

      let exhausted = false;
      try {
        await replay.generate(req1);
      } catch {
        exhausted = true;
      }
      ok("ReplayProvider: throws when exhausted", exhausted);
    } finally {
      try { fs.removeSync(fixturePath); } catch { /* best-effort */ }
    }
  }

  // Restore originals.
  saveConfig({ enableReflection: origReflect, budgetUsd: origBudget });

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nUSAGE VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
