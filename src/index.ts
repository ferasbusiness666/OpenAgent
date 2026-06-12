import { createElement } from "react";
import { render } from "ink";
import { Command } from "commander";
import path from "node:path";
import chalk from "chalk";
import {
  getConfig,
  isConfigComplete,
  setActiveWorkspace,
  getActiveWorkspace,
  type Config,
} from "./config/index.js";
import { migrateLegacyData } from "./paths.js";
import { pruneOldTraces } from "./trace.js";
import { runSetup } from "./setup.js";
import { runStartupFlow } from "./startup.js";
import { AgentMemory } from "./memory/agent-md.js";
import { SessionMemory } from "./memory/session.js";
import {
  getProjectByPath,
  createProject,
  touchProject,
  type Project,
} from "./memory/projects.js";
import {
  newSessionFilePath,
  listSessionFiles,
  pruneOldSessions,
} from "./memory/session-store.js";
import { getProvider } from "./providers/index.js";
import { AgentLoop } from "./agent/loop.js";
import { executeRun, launchBackgroundRun } from "./agent/runner.js";
import { Planner } from "./agent/plan.js";
import { SessionManager, type AgentState } from "./memory/session-manager.js";
import { Scheduler } from "./scheduler/scheduler.js";
import {
  closeBrowser,
  closeResearch,
  closeWorkerPool,
  closeAllServers,
  isBrowserAvailable,
  BROWSER_UNAVAILABLE_MESSAGE,
} from "./tools/index.js";
import { TelegramBridge } from "./telegram/bridge.js";
import { App } from "./ui/App.js";

interface CliOptions {
  task?: string;
  resume?: string;
  background?: string;
  runDetached?: string;
  budget?: string;
  maxIterations?: string;
  healthCheck?: boolean;
}

/** Attach plain-text console listeners to the loop (headless / fallback mode). */
function attachConsoleListeners(loop: AgentLoop): void {
  loop.on("thought", (t) => console.log(chalk.gray.italic(`  thinking: ${t}`)));
  loop.on("toolCall", ({ tool, params }) =>
    console.log(chalk.cyan(`🔧 ${tool} ${JSON.stringify(params)}`)),
  );
  loop.on("toolResult", ({ tool, result, success }) => {
    const head = result.split(/\r?\n/).slice(0, 3).join("\n");
    console.log((success ? chalk.green : chalk.red)(`${success ? "✓" : "✗"} ${tool}: ${head}`));
  });
  loop.on("message", (m) => console.log(chalk.white(`Agent: ${m}`)));
  loop.on("done", (m) => console.log(chalk.green.bold(`\n✓ Done: ${m}`)));
  loop.on("stuck", (m) => console.log(chalk.yellow.bold(`\n⚠ Needs input: ${m}`)));
  loop.on("error", (m) => console.log(chalk.red.bold(`\n✗ Error: ${m}`)));
}

/** Bind a session for `project`, optionally reloading its most recent file. */
function bindSession(session: SessionMemory, project: Project, loadLast: boolean): void {
  if (loadLast) {
    const latest = listSessionFiles(project.id)[0];
    if (latest) {
      session.bindPersistence(latest, { load: true, projectId: project.id });
      return;
    }
  }
  session.bindPersistence(newSessionFilePath(project.id), { projectId: project.id });
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("openagent")
    .description("Open Agent — an autonomous local AI agent")
    .option("-t, --task <task>", "run a single task non-interactively, then exit")
    .option("-r, --resume <sessionId>", "resume a previously saved session by id")
    .option("-b, --background <task>", "run a task in a detached background process, then exit")
    .option(
      "--run-detached <runId>",
      "internal: execute a registered background run (used by --background)",
    )
    .option(
      "--budget <usd>",
      "stop the agent before the estimated session cost exceeds this many USD (this run only)",
    )
    .option(
      "--max-iterations <n>",
      "override the dynamic per-task step limit (default: 20 + 5 per planned phase)",
    )
    .option(
      "--health-check",
      "verify provider, workspace, browser, and Telegram are working, then exit",
    )
    .allowExcessArguments(true);
  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  // Session-only budget override: routed through the environment so getConfig()
  // stays the single source of truth without persisting the flag to config.json.
  if (options.budget !== undefined) {
    const budget = Number(options.budget);
    if (Number.isFinite(budget) && budget >= 0) {
      process.env.OPENAGENT_BUDGET_USD = String(budget);
    } else {
      console.error(chalk.red(`Invalid --budget value: "${options.budget}" (expected a number of USD).`));
      process.exit(1);
    }
  }

  // Session-only iteration-cap override (IMP-04), same env-routed pattern.
  if (options.maxIterations !== undefined) {
    const n = Number(options.maxIterations);
    if (Number.isInteger(n) && n > 0) {
      process.env.OPENAGENT_MAX_ITERATIONS = String(n);
    } else {
      console.error(
        chalk.red(`Invalid --max-iterations value: "${options.maxIterations}" (expected a positive integer).`),
      );
      process.exit(1);
    }
  }

  // Move any legacy data into ~/.openagent/ up front. Pruning of stale sessions
  // is deferred until AFTER the resume target is loaded (below), so resuming an
  // old session never races the cleanup that would delete its state file.
  migrateLegacyData();
  // IMP-24: drop observability traces older than two weeks (best-effort).
  pruneOldTraces();

  // ---- Health check (IMP-25): verify components, print the report, exit. ----
  if (options.healthCheck === true) {
    const { runHealthCheck, formatHealthReport } = await import("./health.js");
    const report = await runHealthCheck();
    console.log(formatHealthReport(report));
    process.exit(report.ok ? 0 : 1);
  }

  // ---- Detached background worker: execute one registered run, then exit. ----
  // This is the headless body spawned by --background; handle it FIRST so it
  // never needs a TTY and never falls into the interactive setup flow.
  if (options.runDetached && options.runDetached.trim().length > 0) {
    await executeRun(options.runDetached.trim());
    process.exit(0);
  }

  let config: Config = getConfig();
  const browserOk = isBrowserAvailable();

  // One SessionManager drives the resumable AgentState files for this process.
  const sessionManager = new SessionManager();
  // Resolve the session id up front: resume id when provided, else a fresh one.
  const resumeId =
    typeof options.resume === "string" && options.resume.trim().length > 0
      ? options.resume.trim()
      : undefined;
  const resumedState: AgentState | null = resumeId ? sessionManager.load(resumeId) : null;
  if (resumeId && resumedState === null) {
    console.error(
      chalk.yellow(`Could not resume session "${resumeId}" — starting a fresh session.`),
    );
  }
  const sessionId = resumedState?.sessionId ?? resumeId ?? sessionManager.newSessionId();

  // Now that any resume target is safely loaded into memory, tidy stale
  // sessions — exempting the session being resumed so it is never deleted.
  pruneOldSessions(30, resumeId);

  // The scheduler's in-process poller (interactive mode only); torn down on exit.
  let scheduler: Scheduler | null = null;

  const cleanup = async (): Promise<void> => {
    if (scheduler) {
      scheduler.stop();
    }
    await closeBrowser();
    await closeResearch();
    await closeWorkerPool();
    await closeAllServers();
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });

  // ---- Detached background launch: register + spawn a worker, then exit. -----
  // Replicates Manus's "work in the background, notify when done": the task runs
  // in a separate process that outlives this terminal and notifies on completion.
  if (options.background && options.background.trim().length > 0) {
    if (!isConfigComplete(config)) {
      console.error(
        chalk.red(
          "No provider configured yet. Run setup once interactively, then use --background.",
        ),
      );
      process.exit(1);
    }
    const project =
      getProjectByPath(process.cwd()) ?? createProject(path.basename(process.cwd()) || "default");
    touchProject(project.id);
    const { runId } = launchBackgroundRun(options.background.trim(), project.path);
    console.log(
      chalk.green(`Started background run ${runId}.`) +
        chalk.gray(` Events: ~/.openagent/runs/${runId}.log — list with 'openagent' /runs.`),
    );
    process.exit(0);
  }

  // ---- Headless one-shot mode: run a single task and exit. -------------------
  if (options.task && options.task.trim().length > 0) {
    if (!isConfigComplete(config)) {
      console.error(
        chalk.red(
          "No provider is configured yet. Launch Open Agent interactively once to run setup, " +
            "then use --task.",
        ),
      );
      process.exit(1);
    }
    // The workspace is the current directory; reuse/create a project for it.
    const project = getProjectByPath(process.cwd()) ?? createProject(path.basename(process.cwd()) || "default");
    touchProject(project.id);
    setActiveWorkspace(project.path);

    const agentMemory = new AgentMemory();
    let provider;
    try {
      provider = getProvider(config);
    } catch (err) {
      console.error(chalk.red(`Failed to initialize provider: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
    const session = new SessionMemory();
    bindSession(session, project, false);
    if (resumedState) {
      session.replaceHistory(resumedState.history);
    }
    const loop = new AgentLoop(provider, session, agentMemory, {
      sessionManager,
      sessionId,
      goal: resumedState?.goal,
      phases: resumedState?.phases,
      workingMemory: resumedState?.metadata.workingMemory,
    });
    if (resumedState) {
      console.log(
        chalk.gray(
          `Resumed session ${resumedState.sessionId} — ${resumedState.history.length} messages, ${resumedState.phases.length} phases.`,
        ),
      );
    }

    console.log(chalk.magenta.bold("Open Agent") + chalk.gray(` — provider: ${provider.name}`));
    console.log(chalk.gray(`workspace: ${getActiveWorkspace()}`));
    if (!browserOk) {
      console.log(chalk.gray(BROWSER_UNAVAILABLE_MESSAGE));
    }
    console.log("");
    attachConsoleListeners(loop);
    await loop.run(options.task.trim());
    await cleanup();
    process.exit(0);
  }

  // ---- Interactive mode requires a TTY for the prompts + UI. -----------------
  if (!process.stdin.isTTY) {
    console.error(
      chalk.yellow(
        "Open Agent needs an interactive terminal. Run with --task \"...\" for a one-shot, " +
          "non-interactive task instead.",
      ),
    );
    process.exit(1);
  }

  // Steps A–C: trust prompt, then known-project detection / new-project setup.
  const startup = await runStartupFlow();
  if (startup === null) {
    process.exit(0);
  }
  const { project, loadLastSession } = startup;
  setActiveWorkspace(project.path);

  // Step D: provider wizard, only when no provider is configured yet.
  if (!isConfigComplete(config)) {
    config = await runSetup();
  }

  // AgentMemory is constructed AFTER the workspace is set so the project-level
  // AGENT.md resolves to the current directory.
  const agentMemory = new AgentMemory();

  let provider;
  try {
    provider = getProvider(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to initialize provider: ${message}`));
    process.exit(1);
  }

  const session = new SessionMemory();
  bindSession(session, project, loadLastSession);
  if (resumedState) {
    session.replaceHistory(resumedState.history);
  }

  const loop = new AgentLoop(provider, session, agentMemory, {
    sessionManager,
    sessionId,
    goal: resumedState?.goal,
    phases: resumedState?.phases,
    workingMemory: resumedState?.metadata.workingMemory,
  });
  if (resumedState) {
    console.log(
      chalk.gray(
        `Resumed session ${resumedState.sessionId} — ${resumedState.history.length} messages, ${resumedState.phases.length} phases.`,
      ),
    );
  }

  // Start the file-based scheduler (~/.openagent/schedules.json). When a
  // schedule is due and the agent is idle, run its task; the poll timer is
  // unref'd so it never keeps the process alive on its own.
  scheduler = new Scheduler();
  // A due schedule launches a DETACHED background run (it runs autonomously and
  // notifies on completion) instead of contending with the foreground loop.
  scheduler.on("due", (due) => {
    launchBackgroundRun(due.task, project.path);
  });
  scheduler.start();

  // Start the Telegram bridge if configured.
  if (config.telegramToken.trim().length > 0) {
    if (config.telegramChatId.trim().length > 0) {
      const bridge = new TelegramBridge(loop, config.telegramToken, config.telegramChatId);
      bridge.start();
    } else {
      console.error(
        chalk.yellow("Telegram token is set but telegramChatId is empty — skipping Telegram."),
      );
    }
  }

  // Render the Ink UI; fall back to plain console mode if Ink cannot render.
  try {
    const app = render(
      createElement(App, {
        agentLoop: loop,
        providerName: provider.name,
        workspacePath: getActiveWorkspace(),
        session,
        project,
        browserAvailable: browserOk,
        scheduler: scheduler ?? undefined,
      }),
    );
    await app.waitUntilExit();
  } catch (err) {
    console.error(
      chalk.yellow(
        `Falling back to plain console mode (the terminal UI could not render): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
    attachConsoleListeners(loop);
  }

  await cleanup();
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(chalk.red(`Fatal error: ${message}`));
  process.exit(1);
});
