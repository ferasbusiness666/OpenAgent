/**
 * scripts/eval.ts — Open Agent evaluation harness.
 *
 * Usage:
 *   npx tsx scripts/eval.ts            # real provider (requires configured API key)
 *   npx tsx scripts/eval.ts --selftest # scripted provider — no LLM calls, fast
 *   npx tsx scripts/eval.ts --json     # also write metrics to eval-results.json
 *   npx tsx scripts/eval.ts --selftest --json   # combinable
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
 *
 * Metrics collected per task:
 *   name      — task identifier
 *   passed    — boolean
 *   steps     — number of toolCall events emitted during the run
 *   tokensIn  — input tokens from loop.sessionUsage after the run
 *   tokensOut — output tokens from loop.sessionUsage after the run
 *   costUsd   — estimated cost from loop.sessionUsage after the run
 *   ms        — wall-clock milliseconds for the run
 *
 * --json writes the full metrics array to eval-results.json in cwd.
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
// Per-task metric record
// ---------------------------------------------------------------------------

export interface TaskMetric {
  name: string;
  passed: boolean;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  ms: number;
}

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

/**
 * Maps a task name to the file operations it should perform to satisfy its check.
 * Keys match EVAL_TASKS[*].name.
 *
 * Each entry is an array of write/delete actions to execute in sequence:
 *   { op: "write", filePath, content }   — write a file (mkdir -p the parent)
 *   { op: "delete", filePath }            — delete a file
 */
type ScriptAction =
  | { op: "write"; filePath: string; content: string }
  | { op: "delete"; filePath: string };

const TASK_SCRIPTS: Record<string, ScriptAction[]> = {
  "create-file": [
    { op: "write", filePath: "hello.txt", content: "Hello World" },
  ],
  "compute-and-write": [
    { op: "write", filePath: "answer.txt", content: "42" },
  ],
  "list-then-summarize": [
    { op: "write", filePath: "notes.md", content: "# Notes\n- A bullet point\n" },
  ],
  "write-json": [
    { op: "write", filePath: "config.json", content: '{"name":"openagent"}' },
  ],
  "make-directory": [
    { op: "write", filePath: "src/index.js", content: "" },
  ],
  "multi-file": [
    { op: "write", filePath: "a.txt", content: "alpha" },
    { op: "write", filePath: "b.txt", content: "beta" },
  ],
  "append-or-edit": [
    { op: "write", filePath: "version.txt", content: "1.0.1" },
  ],
  "count-lines": [
    {
      op: "write",
      filePath: "data.txt",
      content: "line 1\nline 2\nline 3\nline 4\nline 5\n",
    },
    { op: "write", filePath: "count.txt", content: "5" },
  ],
  "find-pattern": [
    { op: "write", filePath: "apple.md", content: "fruit" },
    { op: "write", filePath: "needle.md", content: "needle" },
    { op: "write", filePath: "carrot.md", content: "vegetable" },
    { op: "write", filePath: "found.txt", content: "needle.md" },
  ],
  "html-page": [
    {
      op: "write",
      filePath: "site/index.html",
      content:
        "<!DOCTYPE html><html><head><title>Eval</title></head><body><h1>Eval</h1></body></html>",
    },
  ],
  "csv-summary": [
    {
      op: "write",
      filePath: "scores.csv",
      content: "name,score\nalice,10\nbob,20\ncarol,30\n",
    },
    { op: "write", filePath: "total.txt", content: "60" },
  ],
  "rename-file": [
    { op: "write", filePath: "final.txt", content: "v1" },
    // draft.txt never existed in the workspace so no delete needed — but if
    // some scripted turn wrote it we delete it here to be safe.
    { op: "delete", filePath: "draft.txt" },
  ],
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

  // Check from most-specific to least-specific to avoid false matches.
  if (needle.includes("hello.txt")) return "create-file";
  if (needle.includes("answer.txt") || needle.includes("6 * 7") || needle.includes("6*7"))
    return "compute-and-write";
  if (needle.includes("notes.md") || (needle.includes("notes") && needle.includes("bullet")))
    return "list-then-summarize";
  if (needle.includes("config.json") && needle.includes("openagent")) return "write-json";
  if (needle.includes("src") && needle.includes("index.js")) return "make-directory";
  if (needle.includes("a.txt") && needle.includes("b.txt")) return "multi-file";
  if (needle.includes("version.txt") && needle.includes("1.0")) return "append-or-edit";
  if (needle.includes("data.txt") && needle.includes("count.txt")) return "count-lines";
  if (needle.includes("needle.md") || (needle.includes("needle") && needle.includes("found.txt")))
    return "find-pattern";
  if (needle.includes("site") && needle.includes("index.html")) return "html-page";
  if (needle.includes("scores.csv") || needle.includes("total.txt")) return "csv-summary";
  if (needle.includes("draft.txt") || needle.includes("final.txt")) return "rename-file";
  return null;
}

/**
 * Deterministic scripted provider. Never makes network calls.
 *
 * Turn sequence per task (call count is per-instance so it resets for each task):
 *   Turn 1: planning prompt → return a JSON phase array.
 *   Turn 2+: one NATIVE filesystem tool call per script action — the actions
 *            run through the real agent loop and the real filesystem tool, so
 *            the selftest exercises the whole execution path (and the steps/
 *            metrics columns reflect real tool runs).
 *   Final turn: a native "done" call.
 */
class ScriptedProvider implements Provider {
  readonly name = "scripted-eval";
  readonly supportsVision = false;
  private calls = 0;
  private step = 0;
  private actions: ScriptAction[] | null = null;

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;

    // Turn 1: planning module call.
    if (
      request.system.toLowerCase().includes("planning module") ||
      (this.calls === 1 && request.tools === undefined)
    ) {
      const planArray = JSON.stringify([
        { title: "Write the file", description: "Write the requested file to the workspace." },
      ]);
      return { text: planArray, toolCalls: [] };
    }

    // Resolve this task's scripted action sequence once.
    if (this.actions === null) {
      const taskName = inferTaskName(request);
      this.actions = (taskName !== null ? TASK_SCRIPTS[taskName] : undefined) ?? [];
    }

    // Emit the next scripted action as a REAL filesystem tool call.
    const action = this.actions[this.step];
    if (action !== undefined) {
      this.step += 1;
      const args: Record<string, unknown> =
        action.op === "write"
          ? { operation: "write", path: action.filePath, content: action.content }
          : { operation: "delete", path: action.filePath };
      return { text: "", toolCalls: [{ name: "filesystem", arguments: args }] };
    }

    return { text: "", toolCalls: [{ name: "done", arguments: { message: "Done." } }] };
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
): Promise<TaskMetric> {
  const workspaceDir = path.join(os.tmpdir(), `openagent-eval-${task.name}-${Date.now()}`);
  fs.ensureDirSync(workspaceDir);

  const startMs = Date.now();
  let steps = 0;

  try {
    setActiveWorkspace(workspaceDir);

    const session = new SessionMemory();
    const agentMemory = new AgentMemory({ projectDir: workspaceDir, load: false });
    const loop = new AgentLoop(provider, session, agentMemory);

    // Count toolCall events for this task run.
    const onToolCall = (): void => {
      steps += 1;
    };
    loop.on("toolCall", onToolCall);

    await runWithTimeout(loop, task.prompt, 90_000);

    loop.off("toolCall", onToolCall);

    const usage = loop.sessionUsage;
    const passed = task.check(workspaceDir);
    const ms = Date.now() - startMs;

    return {
      name: task.name,
      passed,
      steps,
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      costUsd: usage.costUsd,
      ms,
    };
  } catch (err) {
    const ms = Date.now() - startMs;
    return {
      name: task.name,
      passed: false,
      steps,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      ms,
    };
  } finally {
    try {
      fs.removeSync(workspaceDir);
    } catch {
      // Best-effort cleanup.
    }
  }
}

/** Print a fixed-width metrics table to stdout. */
function printMetricsTable(metrics: TaskMetric[]): void {
  const COL = {
    name: 22,
    passed: 7,
    steps: 6,
    tokensIn: 10,
    tokensOut: 11,
    costUsd: 10,
    ms: 7,
  };

  const pad = (s: string, w: number): string => s.padEnd(w);
  const rpad = (s: string, w: number): string => s.padStart(w);

  const header =
    pad("task", COL.name) +
    rpad("pass?", COL.passed) +
    rpad("steps", COL.steps) +
    rpad("tokensIn", COL.tokensIn) +
    rpad("tokensOut", COL.tokensOut) +
    rpad("costUsd", COL.costUsd) +
    rpad("ms", COL.ms);

  const divider = "-".repeat(header.length);

  console.log("\n" + divider);
  console.log(header);
  console.log(divider);

  for (const m of metrics) {
    const row =
      pad(m.name, COL.name) +
      rpad(m.passed ? "✓" : "✗", COL.passed) +
      rpad(String(m.steps), COL.steps) +
      rpad(String(m.tokensIn), COL.tokensIn) +
      rpad(String(m.tokensOut), COL.tokensOut) +
      rpad(m.costUsd.toFixed(4), COL.costUsd) +
      rpad(String(m.ms), COL.ms);
    console.log(row);
  }

  console.log(divider + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isSelftest = args.includes("--selftest");
  const isJson = args.includes("--json");

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
  const metrics: TaskMetric[] = [];

  try {
    for (const task of EVAL_TASKS) {
      // In selftest, create a fresh ScriptedProvider per task so the call
      // counter resets cleanly.
      const taskProvider = isSelftest ? new ScriptedProvider() : provider;
      const metric = await runTask(task, taskProvider);
      metrics.push(metric);
      if (metric.passed) {
        passed += 1;
        console.log(`  ✓ ${metric.name}`);
      } else {
        console.log(`  ✗ ${metric.name}`);
      }
    }
  } finally {
    // Restore reflection setting if we changed it.
    if (isSelftest && originalReflection !== undefined) {
      saveConfig({ enableReflection: originalReflection });
    }
  }

  // Print the metrics summary table.
  printMetricsTable(metrics);

  // Optionally write JSON results file.
  if (isJson) {
    const outPath = path.join(process.cwd(), "eval-results.json");
    fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2) + "\n", "utf8");
    console.log("Wrote eval-results.json");
  }

  // Keep this exact format last — external tooling greps for it.
  console.log(`EVAL: ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

void main();
