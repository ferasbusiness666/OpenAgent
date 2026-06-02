import { createElement } from "react";
import { render } from "ink";
import { Command } from "commander";
import chalk from "chalk";
import {
  getConfig,
  isConfigComplete,
  resolveWorkspacePath,
  type Config,
} from "./config/index.js";
import { runSetup } from "./setup.js";
import { AgentMemory } from "./memory/agent-md.js";
import { SessionMemory } from "./memory/session.js";
import { getProvider } from "./providers/index.js";
import { AgentLoop } from "./agent/loop.js";
import { closeBrowser } from "./tools/index.js";
import { TelegramBridge } from "./telegram/bridge.js";
import { App } from "./ui/App.js";

interface CliOptions {
  task?: string;
}

/** Attach plain-text console listeners to the loop (used in headless mode). */
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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("open-agent")
    .description("Open Agent — an autonomous local AI agent")
    .option("-t, --task <task>", "run a single task non-interactively, then exit")
    .allowExcessArguments(true);
  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  // 1. Load config.
  let config: Config = getConfig();

  // 2. Run the setup wizard if config is empty or incomplete.
  if (!isConfigComplete(config)) {
    config = await runSetup();
  }

  // 3. Load AGENT.md (created from the default template if missing).
  const agentMemory = new AgentMemory();

  // 4. Initialize the provider.
  let provider;
  try {
    provider = getProvider(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to initialize provider: ${message}`));
    process.exit(1);
  }

  // 5. Tool registry is a module-level singleton (see ./tools/index.ts).
  // 6. Session memory.
  const session = new SessionMemory();

  // 7. Agent loop.
  const loop = new AgentLoop(provider, session, agentMemory);

  const workspacePath = resolveWorkspacePath(config);

  // Ensure the browser is always cleaned up on exit.
  const cleanup = async (): Promise<void> => {
    await closeBrowser();
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });

  // Headless one-shot mode: run a single task and exit.
  if (options.task && options.task.trim().length > 0) {
    console.log(chalk.magenta.bold("Open Agent") + chalk.gray(` — provider: ${provider.name}`));
    console.log(chalk.gray(`workspace: ${workspacePath}\n`));
    attachConsoleListeners(loop);
    await loop.run(options.task.trim());
    await cleanup();
    process.exit(0);
  }

  // 8. Start the Telegram bridge if configured (interactive mode).
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

  // 9. Render the terminal UI. Requires an interactive TTY for keyboard input.
  if (!process.stdin.isTTY) {
    console.error(
      chalk.yellow(
        "Interactive UI needs a TTY. Run with --task \"...\" for a one-shot, " +
          "non-interactive task instead.",
      ),
    );
    process.exit(1);
  }

  const app = render(
    createElement(App, {
      agentLoop: loop,
      providerName: provider.name,
      workspacePath,
    }),
  );

  await app.waitUntilExit();
  await cleanup();
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(chalk.red(`Fatal error: ${message}`));
  process.exit(1);
});
