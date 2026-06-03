// Deterministic verification of the multi-phase planning + file-based session
// persistence (+ resume) without a live model. A scripted provider returns the
// exact text a real model would: a JSON phase array on the planning call, then
// tool/done JSON with progress signals. We exercise the real Planner, AgentLoop,
// SessionManager save/load, and the resume seeding path.
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { SessionManager } from "../src/memory/session-manager.js";
import type { Phase } from "../src/agent/plan.js";
import type { Provider } from "../src/providers/index.js";
import { setActiveWorkspace } from "../src/config/index.js";

class ScriptedProvider implements Provider {
  readonly name = "scripted-plan";
  private calls = 0;

  async complete(_prompt: string): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) {
      // Planning call — return an ordered JSON phase array.
      return JSON.stringify([
        { title: "Step one", description: "do x" },
        { title: "Step two", description: "do y" },
      ]);
    }
    if (this.calls === 2) {
      // First tool action, reporting phase 1 completed.
      return JSON.stringify({
        thought: "Creating the file for phase 1.",
        action: "filesystem",
        params: { operation: "write", path: "plan-ok.txt", content: "ok" },
        progress: { phase: 1, status: "completed", finding: "created file" },
      });
    }
    // Finish, reporting phase 2 completed.
    return JSON.stringify({
      thought: "All phases complete.",
      action: "done",
      params: {},
      message: "all done",
      progress: { phase: 2, status: "completed" },
    });
  }
}

async function main(): Promise<void> {
  // Point the active workspace at a temp dir BEFORE constructing AgentMemory so
  // nothing is written into the repo root.
  const workspace = path.join(os.tmpdir(), "openagent-verify-plan");
  fs.ensureDirSync(workspace);
  setActiveWorkspace(workspace);

  const sm = new SessionManager();
  const sid = sm.newSessionId();
  const session = new SessionMemory();
  const loop = new AgentLoop(new ScriptedProvider(), session, new AgentMemory(), {
    sessionManager: sm,
    sessionId: sid,
  });

  let planEventPhases: Phase[] = [];
  let phaseUpdateCount = 0;
  loop.on("plan", (phases) => {
    planEventPhases = phases;
  });
  loop.on("phaseUpdate", () => {
    phaseUpdateCount += 1;
  });

  await loop.run("build a two-step thing");

  // ---- Assertions on the live run --------------------------------------------
  const planFired = planEventPhases.length >= 2;
  const phaseUpdatesFired = phaseUpdateCount >= 1;

  // ---- Assertions on persisted state -----------------------------------------
  const loaded = sm.load(sid);
  const stateExists = loaded !== null;
  const phaseCountMatches = loaded !== null && loaded.phases.length === planEventPhases.length;
  const someCompleted = loaded !== null && loaded.phases.some((p) => p.status === "completed");
  const historyPersisted = loaded !== null && loaded.history.length > 0;

  // ---- RESUME path: seed a fresh SessionMemory from the saved state ----------
  let resumeHistoryLen = 0;
  const resumeState = sm.load(sid);
  if (resumeState) {
    const session2 = new SessionMemory();
    session2.replaceHistory(resumeState.history);
    resumeHistoryLen = session2.getHistory().length;
  }
  const resumeOk = resumeHistoryLen > 0;

  const checks: Array<[string, boolean]> = [
    ['"plan" event fired with >=2 phases', planFired],
    ['"phaseUpdate" event fired', phaseUpdatesFired],
    ["AgentState file loads", stateExists],
    ["persisted phase count matches plan", phaseCountMatches],
    ["at least one phase completed", someCompleted],
    ["history persisted to state", historyPersisted],
    ["resume seeds history > 0", resumeOk],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${label}`);

  console.log(`\nsessionId: ${sid}`);
  console.log(`phaseUpdate events: ${phaseUpdateCount}`);
  if (loaded) {
    for (const p of loaded.phases) {
      console.log(` - Phase ${p.id} [${p.status}] ${p.title} (${p.findings.join("; ")})`);
    }
  }

  const allOk = checks.every(([, ok]) => ok);
  console.log(`\nPLAN VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
