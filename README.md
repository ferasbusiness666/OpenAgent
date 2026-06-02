# Open Agent

An open-source, self-hosted autonomous AI agent that runs locally — a lightweight alternative to Manus. Give it a task and it plans, executes end-to-end with real tools (shell, filesystem, headless browser), observes results, and self-corrects on failure. It only stops to ask when it is genuinely stuck.

The primary interface is a terminal UI styled like Claude Code / OpenCode. Telegram acts as a remote controller that mirrors the terminal session.

## Features

- **Autonomous loop** — ReAct-style plan → act → observe → correct until the task is done.
- **Real tools** — shell (sandboxed to the workspace), filesystem (traversal-blocked), and a reusable headless Chromium browser.
- **Provider-agnostic** — drive it with a local AI CLI (`gemini`, `claude`, `codex`, `aider`, `goose`, `ollama`) or a hosted API (OpenAI, Anthropic, Google).
- **Persistent memory** — `AGENT.md` carries durable facts across sessions; session history is in-memory only.
- **Remote control** — optional Telegram bridge mirrors every step and accepts new tasks.

## Requirements

- Node.js 18+ (developed on Node 22).
- For the browser tool: `npx playwright install chromium` (run once).

## Install

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm start
```

On first launch a setup wizard detects installed AI CLIs and asks how you want to connect (CLI or API key), where the workspace lives, and (optionally) Telegram credentials. Answers are saved to `config.json` (gitignored).

## Configuration

All settings live in `config.json` at the project root. It is **gitignored** and never committed, so your API keys and Telegram token stay out of the repo. Use [`config.example.json`](./config.example.json) as a reference (copy it to `config.json`, or just run the wizard).

| Field | Meaning |
|---|---|
| `workspacePath` | Folder the agent is sandboxed to (default `./workspace`). |
| `providerMode` | `"cli"` or `"api"`. |
| `activeCliName` | Detected CLI to drive (cli mode). |
| `apiKey` / `apiProvider` | API key and `"openai" \| "anthropic" \| "google"` (api mode). |
| `telegramToken` / `telegramChatId` | Optional remote control via Telegram. |

### Connecting Telegram later (recommended: environment variables)

You don't have to put the Telegram token in `config.json`. The token and chat ID are read from the environment when present and **take precedence** over the file, so the secret never has to touch a saved file:

```bash
# PowerShell
$env:TELEGRAM_BOT_TOKEN = "123456:your-bot-token"
$env:TELEGRAM_CHAT_ID  = "your-chat-id"
npm start

# bash
TELEGRAM_BOT_TOKEN="123456:your-bot-token" TELEGRAM_CHAT_ID="your-chat-id" npm start
```

This is the simplest way to connect the bot after cloning — no code or committed-file changes required.

### One-shot / non-interactive

Run a single task and exit (useful for scripts and non-TTY environments):

```bash
npm start -- --task "create a file called hello.txt with the content Hello World"
```

## How it works

Every turn the agent receives a system prompt (its identity + `AGENT.md` + the tool reference + the workspace path + the current time) followed by the running history, and must reply with a single JSON object:

```json
{
  "thought": "internal reasoning",
  "action": "shell | filesystem | browser | done | stuck",
  "params": {},
  "message": "optional text for the user"
}
```

The loop executes the chosen tool, feeds the result back, and repeats. A failing step is retried with the error in context; after 3 identical failures the agent reports `stuck`.

## Security

- Shell and filesystem operations are confined to the workspace folder; path traversal (`..`, absolute paths, `~`) is blocked.
- Dangerous shell commands (`rm -rf /`, `format`, `mkfs`, fork bombs, …) are refused.
- `config.json` is gitignored; API keys and Telegram tokens are never logged.
- The Telegram bridge only accepts commands from the configured chat ID.

## Project layout

```
src/
  ui/        Ink terminal UI (App, ChatView, StatusBar, ToolOutput)
  agent/     loop, planner, corrector
  tools/     shell, filesystem, browser, registry
  providers/ detector, cli, api, factory
  memory/    session (in-memory), agent-md (durable)
  telegram/  remote-control bridge
  config/    zod-validated config
  setup.ts   first-run wizard
  index.ts   entry point
```

## License

MIT
