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
import { Planner } from "./agent/plan.js";
import { SessionManager, type AgentState } from "./memory/session-manager.js";
import { Scheduler } from "./scheduler/scheduler.js";
import {
  closeBrowser,
  closeResearch,
  closeWorkerPool,
  isBrowserAvailable,
  BROWSER_UNAVAILABLE_MESSAGE,
} from "./tools/index.js";
import { TelegramBridge } from "./telegram/bridge.js";
import { App } from "./ui/App.js";

interface CliOptions {
  task?: string;
  resume?: string;
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
    .allowExcessArguments(true);
  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  // Move any legacy data into ~/.openagent/ and tidy stale sessions up front.
  migrateLegacyData();
  pruneOldSessions(30);

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

  // The scheduler's in-process poller (interactive mode only); torn down on exit.
  let scheduler: Scheduler | null = null;

  const cleanup = async (): Promise<void> => {
    if (scheduler) {
      scheduler.stop();
    }
    await closeBrowser();
    await closeResearch();
    await closeWorkerPool();
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });

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
  scheduler.on("due", (due) => {
    if (!loop.isRunning()) {
      void loop.run(due.task);
    }
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
