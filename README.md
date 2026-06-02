# Open Agent

An open-source, self-hosted autonomous AI agent that runs locally — a lightweight alternative to Manus. Give it a task and it plans, executes end-to-end with real tools (shell, filesystem, headless browser), observes results, and self-corrects on failure. It only stops to ask when it is genuinely stuck.

The primary interface is a terminal UI styled like Claude Code / OpenCode. Telegram acts as a remote controller that mirrors the terminal session.

## Features

- **Autonomous loop** — ReAct-style plan → act → observe → correct until the task is done.
- **Real tools** — shell (sandboxed to the workspace), filesystem (traversal-blocked), and a reusable headless Chromium browser.
- **Provider-agnostic** — drive it with a local AI CLI (`gemini`, `claude`, `codex`, `aider`, `goose`, `ollama`) or a hosted API (OpenAI, Anthropic, Google).
- **Projects & saved sessions** — pick or create a project at launch; every message is saved to a per-project session file on disk.
- **Hot provider/model switching** — change provider or model mid-conversation (`/provider`, `/model`) without losing any history.
- **Slash commands** — `/settings`, `/tools`, `/model`, `/provider`, `/history`, `/clear`, `/help` run inline from the chat.
- **Persistent memory** — `AGENT.md` carries durable facts across sessions.
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

On first launch a short setup wizard detects installed AI CLIs and asks only how you want to connect (CLI or API key) and where the workspace lives. Answers are saved to `config.json` (gitignored). Everything else — including Telegram — is configured later from inside the app via `/settings`.

After setup, Open Agent shows a **project selector**: choose an existing project or create a new one. Each project keeps its own folder of saved sessions. Once a project is open you land in the chat; type a task, or type `/` to see the command menu.

### Slash commands

| Command | What it does |
|---|---|
| `/settings` | View and edit every config field (workspace, provider, model, Telegram), saved immediately. |
| `/tools` | List the agent's available tools. |
| `/model` | Switch the active model — the conversation is preserved. |
| `/provider` | Switch the active provider (CLI ↔ API) — the conversation is preserved. |
| `/history` | Show the current session's message history. |
| `/clear` | Clear the conversation (stays in the same project). |
| `/help` | Show the command list. |

Switching provider or model never resets the conversation: the same on-disk session history is carried straight into the new provider's context.

## Configuration

All settings live in `config.json` at the project root. It is **gitignored** and never committed, so your API keys and Telegram token stay out of the repo. Use [`config.example.json`](./config.example.json) as a reference (copy it to `config.json`, or just run the wizard).

| Field | Meaning |
|---|---|
| `workspacePath` | Folder the agent is sandboxed to (default `./workspace`). |
| `providerMode` | `"cli"` or `"api"`. |
| `activeCliName` | Detected CLI to drive (cli mode). |
| `apiKey` / `apiProvider` | API key and `"openai" \| "anthropic" \| "google"` (api mode). |
| `activeModel` | Model name/id to use (e.g. `gpt-4o`, `gemini-2.0-flash`, `llama3`); blank = provider default. |
| `telegramToken` / `telegramChatId` | Optional remote control via Telegram (set here, in `/settings`, or via env vars). |

You can edit all of these live from inside the app with `/settings` — changes are written to `config.json` immediately, and provider/model/workspace changes take effect at once.

### Connecting Telegram later (recommended: environment variables)

You can set the Telegram token and chat ID at any time from `/settings` inside the app (saved to `config.json`). If you'd rather keep the secret out of any file, the token and chat ID are also read from the environment when present and **take precedence** over the file:

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
  ui/        Ink terminal UI: App, ChatView, StatusBar, ToolOutput,
             ProjectSelector, CommandMenu, SettingsScreen, ModelPicker,
             ProviderPicker, commands
  agent/     loop (hot-swappable provider), planner, corrector
  tools/     shell, filesystem, browser, registry
  providers/ detector, cli, api, factory
  memory/    session (in-memory + optional disk persistence),
             session-store (session file paths/serialization),
             projects (projects.json registry), agent-md (durable)
  telegram/  remote-control bridge
  config/    zod-validated config
  setup.ts   first-run wizard
  index.ts   entry point
```

## License

MIT
