/**
 * runner.ts — the detached background-run executor (Phase B: async / long-running).
 *
 * Manus's "work in the background, notify when done" maps locally to a DETACHED
 * child process that outlives the TUI/terminal. That child can't share the
 * in-memory EventEmitter with an attached UI, so it streams every AgentLoop
 * lifecycle event to disk via the RunStore (one JSONL line per event), keeps the
 * run's status record current, and notifies the user (desktop + optional
 * Telegram) the moment it reaches a terminal state.
 *
 * Two entry points:
 *   - {@link executeRun} runs a registered run to completion IN THIS PROCESS.
 *     The detached child invokes it via the `--run-detached <runId>` flag. It
 *     NEVER throws — a background worker must die only when its work is done.
 *   - {@link launchBackgroundRun} registers a run and SPAWNS the detached child
 *     that will call executeRun. It returns immediately with the run id + pid.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { RunStore } from "./run-store.js";
import { AgentLoop } from "./loop.js";
import { getProvider, type Provider } from "../providers/index.js";
import { getConfig, isConfigComplete, setActiveWorkspace } from "../config/index.js";
import { getProjectByPath, createProject, touchProject } from "../memory/projects.js";
import { newSessionFilePath } from "../memory/session-store.js";
import { SessionMemory } from "../memory/session.js";
import { AgentMemory } from "../memory/agent-md.js";
import { SessionManager } from "../memory/session-manager.js";
import { notify, sendTelegram } from "../notify.js";

/** Optional injected collaborators (used by tests to bypass real I/O). */
interface ExecuteRunDeps {
  /** Pre-built provider, bypassing getProvider(config). */
  provider?: Provider;
  /** Pre-built RunStore, bypassing the default (env-honoring) one. */
  runStore?: RunStore;
}

/**
 * Run a previously-registered background run to completion in THIS process.
 *
 * Drives a fresh AgentLoop for the run's task, mirroring every loop event to the
 * run's on-disk event log and keeping its status record current, then notifies
 * the user on completion. This is the body the detached child executes.
 *
 * NEVER throws: every failure path records an "error" status + event and returns
 * normally, so the worker process always exits cleanly.
 *
 * @param runId The id of the run to execute (must already exist in the store).
 * @param deps Optional injected provider / store (for tests).
 */
export async function executeRun(runId: string, deps?: ExecuteRunDeps): Promise<void> {
  const store = deps?.runStore ?? new RunStore();
  const rec = store.get(runId);
  if (!rec) {
    return;
  }

  // -- Self-test hook ---------------------------------------------------------
  // Lets the detached lifecycle (spawn → execute → terminal status + event log)
  // be verified end-to-end without an LLM or any provider configuration.
  if (process.env.OPENAGENT_RUN_SELFTEST === "1") {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "done", data: "selftest" });
    store.update(runId, {
      status: "done",
      endedAt: new Date().toISOString(),
      finalMessage: "selftest",
    });
    return;
  }

  // The detached child inherits no active-workspace state, so anchor tools at
  // the run's recorded project directory before reading config/building things.
  setActiveWorkspace(rec.projectPath);

  const config = getConfig();
  if (!isConfigComplete(config)) {
    const msg = "No provider configured.";
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "error", data: msg });
    store.update(runId, {
      status: "error",
      endedAt: new Date().toISOString(),
      finalMessage: msg,
    });
    await notify("OpenAgent — error", msg);
    return;
  }

  // Resolve (or lazily create) the project anchored to this run's directory.
  const project =
    getProjectByPath(rec.projectPath) ?? createProject(path.basename(rec.projectPath) || "default");
  touchProject(project.id);

  // Build the provider. getProvider can throw (e.g. cli mode without a name) —
  // treat that as a terminal error rather than letting it escape.
  let provider: Provider;
  try {
    provider = deps?.provider ?? getProvider(config);
  } catch (err) {
    const msg = `Failed to initialize provider: ${errMessage(err)}`;
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "error", data: msg });
    store.update(runId, {
      status: "error",
      endedAt: new Date().toISOString(),
      finalMessage: msg,
    });
    await notify("OpenAgent — error", msg);
    return;
  }

  const agentMemory = new AgentMemory();
  const session = new SessionMemory();
  session.bindPersistence(newSessionFilePath(project.id), { projectId: project.id });
  const sessionManager = new SessionManager();
  // No approval handler is set: background runs are autonomous (the headless-safe
  // path) — there is no one at the terminal to approve/deny risky actions.
  const loop = new AgentLoop(provider, session, agentMemory, {
    sessionManager,
    sessionId: rec.sessionId,
  });

  // -- Mirror every loop event to the run's on-disk log; drive status + notify
  //    on terminal events. The per-event `data` payload matches each AgentLoop
  //    event's argument shape (see AgentEvents in loop.ts).
  loop.on("thought", (thought) => {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "thought", data: thought });
  });
  loop.on("toolCall", ({ tool, params }) => {
    store.appendEvent(runId, {
      ts: new Date().toISOString(),
      type: "toolCall",
      data: { tool, params },
    });
  });
  loop.on("toolResult", ({ tool, result, success }) => {
    store.appendEvent(runId, {
      ts: new Date().toISOString(),
      type: "toolResult",
      data: { tool, result, success },
    });
  });
  loop.on("message", (message) => {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "message", data: message });
  });
  loop.on("plan", (phases) => {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "plan", data: phases });
  });
  loop.on("phaseUpdate", (phases) => {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "phaseUpdate", data: phases });
  });
  loop.on("done", (finalMessage) => {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "done", data: finalMessage });
    store.update(runId, {
      status: "done",
      endedAt: new Date().toISOString(),
      finalMessage,
    });
    void notify("OpenAgent — done", finalMessage);
    if (config.telegramToken.trim().length > 0 && config.telegramChatId.trim().length > 0) {
      void sendTelegram(
        config.telegramToken,
        config.telegramChatId,
        `✅ Done: ${finalMessage}`,
      );
    }
  });
  loop.on("stuck", (question) => {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "stuck", data: question });
    store.update(runId, {
      status: "stuck",
      endedAt: new Date().toISOString(),
      finalMessage: question,
    });
    void notify("OpenAgent — needs input", question);
    if (config.telegramToken.trim().length > 0 && config.telegramChatId.trim().length > 0) {
      void sendTelegram(
        config.telegramToken,
        config.telegramChatId,
        `⚠️ Needs input: ${question}`,
      );
    }
  });
  loop.on("error", (message) => {
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "error", data: message });
    store.update(runId, {
      status: "error",
      endedAt: new Date().toISOString(),
      finalMessage: message,
    });
    void notify("OpenAgent — error", message);
    if (config.telegramToken.trim().length > 0 && config.telegramChatId.trim().length > 0) {
      void sendTelegram(
        config.telegramToken,
        config.telegramChatId,
        `❌ Error: ${message}`,
      );
    }
  });

  // -- Drive the loop. loop.run() catches its own internal errors and emits an
  //    "error"/"stuck" event, but a thrown rejection (defensive) is handled too.
  try {
    await loop.run(rec.task);
  } catch (err) {
    const msg = `Background run crashed: ${errMessage(err)}`;
    store.appendEvent(runId, { ts: new Date().toISOString(), type: "error", data: msg });
    store.update(runId, {
      status: "error",
      endedAt: new Date().toISOString(),
      finalMessage: msg,
    });
    await notify("OpenAgent — error", msg);
    return;
  }

  // If the loop returned without emitting a terminal event (no done/stuck/error
  // fired), the record is still "running" — settle it to "done" so the run never
  // appears stuck-forever in the registry.
  if (store.get(runId)?.status === "running") {
    store.update(runId, { status: "done", endedAt: new Date().toISOString() });
  }
}

/**
 * Register a new run and spawn a DETACHED child process to execute it. Returns
 * immediately — the child runs independently and outlives the caller (and the
 * TUI). The caller follows progress by tailing the run's event log via RunStore.
 *
 * The child re-enters this same CLI with `--run-detached <runId>`, which routes
 * to {@link executeRun}. The entry script + tsx loader are resolved robustly so
 * this works both from the real app and from a test harness.
 *
 * @param task The task prompt for the background run.
 * @param projectPath The workspace directory the run operates in.
 * @returns The new run id and (when known) the spawned child's pid.
 */
export function launchBackgroundRun(
  task: string,
  projectPath: string,
): { runId: string; pid?: number } {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const store = new RunStore();
  store.create({ runId, task, projectPath, sessionId });

  // Resolve the CLI entry point relative to THIS module so it is correct no
  // matter the cwd. runner.ts lives in src/agent/, so ".." → src/, then index.ts.
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

  // Re-enter the SAME CLI in a child to run `executeRun` via --run-detached.
  // The TypeScript runtime (tsx) registers itself through process.execArgv
  // (e.g. `--require .../preflight.cjs --import .../loader.mjs`), which a freshly
  // spawned `node <entry>` would NOT inherit — so we forward execArgv before the
  // entry to keep the loader active. When the app is run from compiled JS,
  // execArgv is empty and this is simply `node <entry>`. argv[1] (the launching
  // script) is NOT a separate loader binary under this tsx version, so we don't
  // rely on it.
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry, "--run-detached", runId],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  // Let the child outlive us: don't keep our event loop alive waiting on it.
  child.unref();
  if (child.pid !== undefined) {
    store.update(runId, { pid: child.pid });
  }

  return { runId, pid: child.pid };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
