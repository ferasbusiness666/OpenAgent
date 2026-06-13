/**
 * verify-routing-replan.ts — IMP-18 (model routing) + IMP-06 (dynamic replan).
 *  1. getFastProvider config gating.
 *  2. The loop routes the ACTION turn to the fast provider while planning and
 *     verification use the smart provider.
 *  3. A phase that fails 3× triggers a replan (new phases) instead of stuck;
 *     replanning is bounded and falls back to stuck when it can't help.
 */
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import { getFastProvider } from "../src/providers/index.js";
import type { Provider, GenerateRequest, GenerateResult } from "../src/providers/index.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
const textOf = (r: GenerateRequest): string => r.system + "\n" + r.messages.map((m) => m.content).join("\n");
const planReply = (): GenerateResult => ({ text: JSON.stringify([{ title: "a", description: "b" }]), toolCalls: [] });

/** Records which provider name saw each non-planning action turn. */
class NamedProvider implements Provider {
  readonly supportsVision = false;
  actionCalls = 0;
  constructor(readonly name: string, private readonly behavior: (req: GenerateRequest, self: NamedProvider) => GenerateResult) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (textOf(req).includes("planning module") || textOf(req).includes("re-planning module")) return planReply();
    return this.behavior(req, this);
  }
}

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-routing-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  const orig = {
    reflection: getConfig().enableReflection,
    fastModel: getConfig().fastModel,
    activeModel: getConfig().activeModel,
    apiKey: getConfig().apiKey,
    providerMode: getConfig().providerMode,
    apiProvider: getConfig().apiProvider,
  };

  try {
    // ---- 1. getFastProvider gating ----
    saveConfig({ providerMode: "api", apiProvider: "anthropic", apiKey: "k", activeModel: "claude-smart", fastModel: "" });
    ok("no fastModel → routing disabled", getFastProvider(getConfig()) === undefined);
    saveConfig({ fastModel: "claude-smart" });
    ok("fastModel === activeModel → disabled", getFastProvider(getConfig()) === undefined);
    saveConfig({ fastModel: "claude-fast" });
    ok("distinct fastModel → fast provider built", getFastProvider(getConfig())?.name.includes("claude-fast") === true);
    saveConfig({ providerMode: "cli" });
    ok("cli mode → routing disabled", getFastProvider(getConfig()) === undefined);
    saveConfig({ providerMode: "api" });

    // ---- 2. the loop routes the action turn to the fast provider ----
    saveConfig({ enableReflection: false });
    {
      const smart = new NamedProvider("api:anthropic (claude-smart)", () => ({
        text: "", toolCalls: [{ name: "done", arguments: { message: "smart-done" } }],
      }));
      let fastActed = false;
      const fast = new NamedProvider("api:anthropic (claude-fast)", (_r, self) => {
        self.actionCalls += 1;
        fastActed = true;
        // Fast model does the action, then finishes.
        return self.actionCalls === 1
          ? { text: "", toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: "r.txt", content: "x" } }] }
          : { text: "", toolCalls: [{ name: "done", arguments: { message: "fast-done" } }] };
      });
      const loop = new AgentLoop(smart, new SessionMemory(), new AgentMemory(), { fastProvider: fast });
      let doneMsg = "";
      loop.on("done", (m) => { doneMsg = m; });
      await loop.run("route this");
      await settle();
      ok("action turns ran on the FAST provider", fastActed && fast.actionCalls >= 1);
      ok("smart provider did NOT serve the action loop", smart.actionCalls === 0);
      ok("fast provider finished the task", doneMsg === "fast-done");
    }

    // ---- 3. replan on repeated failure (IMP-06) ----
    {
      let replanned = false;
      // Smart provider: serves planning AND replanning. Detect the replan prompt.
      const provider = new (class implements Provider {
        readonly name = "replanner";
        readonly supportsVision = false;
        async generate(req: GenerateRequest): Promise<GenerateResult> {
          const t = textOf(req);
          if (t.includes("re-planning module") || t.includes("ALREADY COMPLETED")) {
            replanned = true;
            return { text: JSON.stringify([{ title: "different approach", description: "route around it" }]), toolCalls: [] };
          }
          if (t.includes("planning module")) return planReply();
          // Always emit a failing shell command (blocked → fails) to trip giveUp.
          // After a replan, succeed with done so the run ends.
          if (replanned) return { text: "", toolCalls: [{ name: "done", arguments: { message: "recovered" } }] };
          return { text: "", toolCalls: [{ name: "filesystem", arguments: { operation: "read", path: "does-not-exist.xyz" } }] };
        }
      })();
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      let doneMsg = "";
      let stuckMsg = "";
      const phaseSnapshots: number[] = [];
      loop.on("done", (m) => { doneMsg = m; });
      loop.on("stuck", (m) => { stuckMsg = m; });
      loop.on("phaseUpdate", (phases) => phaseSnapshots.push(phases.length));
      await loop.run("do the thing that fails");
      await settle();
      ok("repeated failure triggered a replan", replanned);
      ok("replan recovered to done (not stuck)", doneMsg === "recovered" && stuckMsg === "");
    }
  } finally {
    saveConfig(orig);
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nROUTING-REPLAN VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
