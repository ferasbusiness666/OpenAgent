/**
 * scripts/eval.ts — Open Agent evaluation harness.
 *
 * Usage:
 *   npx tsx scripts/eval.ts            # real provider (requires configured API key)
 *   npx tsx scripts/eval.ts --selftest # scripted provider — no LLM calls, fast
 *
 * For each EvalTask the harness:
 *   1. Creates a fresh temp workspace directory.
 *   2. Points the active workspace there (setActiveWorkspace).
 *   3. Builds an AgentLoop with the chosen provider.
 *   4. Calls loop.run(task.prompt) with a 90-second safety timeout.
 *   5. Runs task.check(workspaceDir) and records pass/fail.
 *   6. Cleans up the temp dir.
 *
 * --selftest uses a SCRIPTED provider that deterministically drives each task to
 * success without hitting any real model. It works by:
 *   - Returning a JSON phase-array on the planning turn (system contains "planning
 *     module").
 *   - Inspecting the most-recent user message on every subsequent turn to figure
 *     out which file to write (keyed on task-prompt keywords).
 *   - Returning a "done" action on the turn after the write succeeds.
 * Reflection is disabled during selftest (saveConfig + restore) so the scripted
 * "done" is never sent back for more work.
 */

import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import type { Provider } from "../src/providers/index.js";
import { getProvider } from "../src/providers/index.js";
import type { GenerateRequest, GenerateResult } from "../src/providers/messages.js";
import {
  getConfig,
  isConfigComplete,
  saveConfig,
  setActiveWorkspace,
} from "../src/config/index.js";
import { EVAL_TASKS, type EvalTask } from "../src/eval/tasks.js";

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

/**
 * Maps a task name to the file it should write (path + content).
 * Keys match EVAL_TASKS[*].name.
 */
const TASK_WRITES: Record<string, { filePath: string; content: string }> = {
  "create-file": { filePath: "hello.txt", content: "Hello World" },
  "compute-and-write": { filePath: "answer.txt", content: "42" },
  "list-then-summarize": {
    filePath: "notes.md",
    content: "# Notes\n- A bullet point\n",
  },
};

/**
 * Infer which task we're driving by looking at keywords in the full request
 * text (system + all message contents).
 */
function inferTaskName(request: GenerateRequest): string | null {
  const needle = [
    request.system,
    ...request.messages.map((m) => m.content),
  ]
    .join(" ")
    .toLowerCase();

  if (needle.includes("hello.txt")) return "create-file";
  if (needle.includes("answer.txt") || needle.includes("6 * 7") || needle.includes("6*7"))
    return "compute-and-write";
  if (needle.includes("notes.md") || (needle.includes("notes") && needle.includes("bullet")))
    return "list-then-summarize";
  return null;
}

/**
 * Deterministic scripted provider. Never makes network calls.
 *
 * Turn sequence per task (call count is per-instance so it resets for each task):
 *   Turn 1: planning prompt → return a JSON phase array.
 *   Turn 2: main loop, first action turn → return a filesystem write action.
 *   Turn 3: write succeeded → return a done action.
 *   Turn 4+: safety net done (shouldn't be reached if reflection is off).
 */
class ScriptedProvider implements Provider {
  readonly name = "scripted-eval";
  readonly supportsVision = false;
  private calls = 0;
  private wroteFile = false;

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;

    // Turn 1: planning module call (system is the planning-module prompt).
    if (
      request.system.toLowerCase().includes("planning module") ||
      (this.calls === 1 && request.tools === undefined)
    ) {
      // Return a minimal single-phase plan so the loop can continue.
      const planArray = JSON.stringify([
        { title: "Write the file", description: "Write the requested file to the workspace." },
      ]);
      return { text: planArray, toolCalls: [] };
    }

    // Subsequent turns: action turns (loop sends tools, or just text).
    if (!this.wroteFile) {
      const taskName = inferTaskName(request);
      const write = taskName !== null ? TASK_WRITES[taskName] : undefined;
      if (write !== undefined) {
        // Filesystem write action.
        this.wroteFile = true;
        const action = {
          thought: `Writing ${write.filePath} as requested.`,
          action: "filesystem",
          params: {
            operation: "write",
            path: write.filePath,
            content: write.content,
          },
        };
        return { text: JSON.stringify(action), toolCalls: [] };
      }
      // Fallback: we couldn't identify the task — send done anyway.
    }

    // The write has been executed (or we couldn't identify it): declare done.
    const done = {
      thought: "The file has been written. Task complete.",
      action: "done",
      params: {},
      message: "Done.",
    };
    return { text: JSON.stringify(done), toolCalls: [] };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Wrap loop.run() in a safety timeout so a hanging run never blocks the suite. */
function runWithTimeout(
  loop: AgentLoop,
  prompt: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, timeoutMs);

    loop
      .run(prompt)
      .then(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
  });
}

async function runTask(
  task: EvalTask,
  provider: Provider,
): Promise<{ name: string; passed: boolean; error?: string }> {
  const workspaceDir = path.join(os.tmpdir(), `openagent-eval-${task.name}-${Date.now()}`);
  fs.ensureDirSync(workspaceDir);

  try {
    setActiveWorkspace(workspaceDir);

    const session = new SessionMemory();
    // AgentMemory with an explicit projectDir so it never writes into the real
    // workspace root and always has a clean slate for each task.
    const agentMemory = new AgentMemory({ projectDir: workspaceDir, load: false });

    const loop = new AgentLoop(provider, session, agentMemory);

    await runWithTimeout(loop, task.prompt, 90_000);

    const passed = task.check(workspaceDir);
    return { name: task.name, passed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: task.name, passed: false, error: msg };
  } finally {
    try {
      fs.removeSync(workspaceDir);
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isSelftest = args.includes("--selftest");

  let provider: Provider;
  let originalReflection: boolean | undefined;

  if (isSelftest) {
    // Disable reflection so scripted "done" is accepted immediately.
    const before = getConfig();
    originalReflection = before.enableReflection;
    saveConfig({ enableReflection: false });
    provider = new ScriptedProvider();
    console.log("Running eval with scripted provider (--selftest mode).\n");
  } else {
    const cfg = getConfig();
    if (!isConfigComplete(cfg)) {
      console.log("No provider configured — run setup or use --selftest.");
      process.exit(0);
    }
    provider = getProvider(cfg);
    console.log(`Running eval with real provider: ${provider.name}\n`);
  }

  let passed = 0;
  const total = EVAL_TASKS.length;

  try {
    for (const task of EVAL_TASKS) {
      // In selftest, create a fresh ScriptedProvider per task so the call
      // counter resets cleanly.
      const taskProvider = isSelftest ? new ScriptedProvider() : provider;
      const result = await runTask(task, taskProvider);
      if (result.passed) {
        passed += 1;
        console.log(`  ✓ ${result.name}`);
      } else {
        const extra = result.error !== undefined ? ` (${result.error})` : "";
        console.log(`  ✗ ${result.name}${extra}`);
      }
    }
  } finally {
    // Restore reflection setting if we changed it.
    if (isSelftest && originalReflection !== undefined) {
      saveConfig({ enableReflection: originalReflection });
    }
  }

  console.log(`\nEVAL: ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

void main();
