# Open Agent

An open-source, self-hosted autonomous AI agent that runs locally — a lightweight alternative to Manus. Give it a task and it plans, executes end-to-end with real tools (shell, filesystem, headless browser), observes results, and self-corrects on failure. It only stops to ask when it is genuinely stuck.

The primary interface is a terminal UI styled like Claude Code / OpenCode. Telegram acts as a remote controller that mirrors the terminal session.

## Features

- **Autonomous loop** — ReAct-style plan → act → observe → correct until the task is done.
- **Multi-phase planning** — before touching a tool the agent decomposes the goal into an ordered plan of phases (pending / in_progress / completed / failed) and works through them, surfacing the live plan in the UI.
- **Resumable sessions** — full agent state (goal, plan, history) is saved as JSON under `~/.openagent/sessions/`; resume any session with `openagent --resume <sessionId>`.
- **Runs anywhere** — install it globally and launch `openagent` in any directory; that directory becomes the agent's working folder.
- **Real tools** — cross-platform shell (sandboxed to the launch directory), filesystem (traversal-blocked), and a reusable headless Chromium browser.
- **GitHub connector** — read-only GitHub access (list repos, read file contents, list issues) via the `github` tool, authenticated with the `GITHUB_TOKEN` environment variable.
- **Provider-agnostic** — drive it with a local AI CLI (`gemini`, `claude`, `codex`, `aider`, `goose`, `ollama`) or a hosted API (OpenAI, Anthropic, Google, OpenRouter). The CLI bridge is hardened against hangs, crashes, and noisy output.
- **Projects & saved sessions** — each directory you launch in is remembered as a project; every message is saved to a per-project session file on disk, and you can reopen a recent one with `/sessions`.
- **Hot provider/model switching** — change provider or model mid-conversation (`/provider`, `/model`) without losing any history.
- **Slash commands** — `/settings`, `/tools`, `/model`, `/provider`, `/history`, `/sessions`, `/clear`, `/help` run inline from the chat.
- **Two-level persistent memory** — a global `AGENT.md` plus a per-project `AGENT.md` carry durable facts across sessions.
- **Remote control** — optional Telegram bridge mirrors every step and accepts new tasks.

## Requirements

- Node.js 18+ (developed on Node 22).
- For the browser tool: `npx playwright install chromium` (run once). If Chromium is not installed the browser tool is disabled gracefully — the app still runs.

## Install

```bash
npm install
npx playwright install chromium
```

### Install globally

Install the `openagent` command once, then run it from any directory:

```bash
npm install -g .
openagent
```

`openagent` launches the agent in your current directory. The old `npm start` still works for local development from the project folder.

## Run

```bash
openagent          # anywhere, after installing globally
# or, for local dev from the repo:
npm start
```

When you launch in a directory, Open Agent walks through this sequence before the chat UI:

1. **Trust prompt** — `Do you trust the files in <cwd>? (y/N)`. Answering no exits. This is the gate that lets the agent operate in the directory.
2. **Known-project detection** — if a project is already registered for this directory, it asks `Welcome back to <name>. Continue? (Y/n)`. Yes loads that project and its last saved session straight into chat.
3. **New project setup** — otherwise it registers a new project for the current directory, asking for a project name (defaulting to the directory name).
4. **First-run provider wizard** — runs **only if no provider is configured yet**. It detects installed AI CLIs and asks only how you want to connect: pick a detected CLI or enter an API key. Nothing else (no Telegram, no workspace path) is asked here — those are configured later from `/settings`.
5. **Chat UI** — you land in the chat. Type a task, or type `/` to see the command menu.

### Slash commands

| Command | What it does |
|---|---|
| `/settings` | View and edit every config field (workspace override, provider, model, Telegram), validated before saving. |
| `/tools` | List the agent's available tools. |
| `/model` | Switch the active model — the conversation is preserved. |
| `/provider` | Switch the active provider (CLI ↔ API) — the conversation is preserved. |
| `/history` | Show the current session's message history. |
| `/sessions` | List and load a recent session for this project. |
| `/clear` | Clear the conversation (stays in the same project). |
| `/help` | Show the command list. |

Switching provider or model never resets the conversation: the same on-disk session history is carried straight into the new provider's context.

## Configuration

All persistent data lives under `~/.openagent/` in your home directory — never in the app folder:

```
~/.openagent/
  config.json        provider, API keys, settings
  AGENT.md           global persistent memory
  projects.json      registry of known projects
  sessions/<projectId>/<timestamp>.json
```

`config.json` lives at `~/.openagent/config.json` (not the project root) and is **never committed**, so your API keys and Telegram token stay out of any repo. Use [`config.example.json`](./config.example.json) as a reference for the field shape. If a legacy `config.json` or `projects.json` is found in the app folder, it is automatically migrated into `~/.openagent/` on startup.

| Field | Meaning |
|---|---|
| `workspacePath` | Optional override for the agent's working folder. Empty (`""`, the default) means use the directory `openagent` was launched in. |
| `providerMode` | `"cli"` or `"api"`. |
| `activeCliName` | Detected CLI to drive (cli mode). |
| `apiKey` / `apiProvider` | API key and `"openai" \| "anthropic" \| "google" \| "openrouter"` (api mode). OpenRouter uses the OpenAI-compatible API at `https://openrouter.ai/api/v1`. |
| `activeModel` | Model name/id to use (e.g. `gpt-4o`, `gemini-2.0-flash`, `llama3`, or an OpenRouter id like `openai/gpt-4o`); blank = provider default. |
| `telegramToken` / `telegramChatId` | Optional remote control via Telegram (set here, in `/settings`, or via env vars). |

You can edit all of these live from inside the app with `/settings`. Values are **validated before they are saved** — an invalid value is rejected and not written:

- **API key** — a real request is made to the provider; shows ✅ valid / ❌ invalid.
- **Telegram token** — checked with `getMe`; shows the bot's name on success.
- **Workspace path** — must exist and be writable.

### Connecting Telegram later (recommended: environment variables)

You can set the Telegram token and chat ID at any time from `/settings` inside the app (saved to `~/.openagent/config.json`). If you'd rather keep the secret out of any file, the token and chat ID are also read from the environment when present and **take precedence** over the file:

```bash
# PowerShell
$env:TELEGRAM_BOT_TOKEN = "123456:your-bot-token"
$env:TELEGRAM_CHAT_ID  = "your-chat-id"
openagent

# bash
TELEGRAM_BOT_TOKEN="123456:your-bot-token" TELEGRAM_CHAT_ID="your-chat-id" openagent
```

This is the simplest way to connect the bot — no code or committed-file changes required.

### One-shot / non-interactive

Run a single task and exit (useful for scripts and non-TTY environments):

```bash
openagent --task "create a file called hello.txt with the content Hello World"
```

In a non-TTY environment the UI falls back to plain console output.

## How it works

On startup the agent merges two memory files into its system prompt: `~/.openagent/AGENT.md` (global memory — preferences and general info about you) and `<cwd>/AGENT.md` (project-specific memory). Either is created from a template if it is missing.

Every turn the agent receives a system prompt (its identity + the merged `AGENT.md` memory + the tool reference + the working directory + the current time) followed by the running history, and must reply with a single JSON object:

```json
{
  "thought": "internal reasoning",
  "action": "shell | filesystem | browser | done | stuck",
  "params": {},
  "message": "optional text for the user"
}
```

The loop executes the chosen tool, feeds the result back, and repeats. A failing step is retried with the error in context; after 3 identical failures the agent reports `stuck`.

The CLI provider is hardened so the loop never crashes: it enforces a hard 60s timeout (killing a hung CLI), survives CLI crashes without throwing, strips ANSI and control characters, extracts the first JSON object from noisy output, and wraps any plain-text reply as a `done` response. If a CLI returns an authentication error, it surfaces a clear "run `<cli>` once to log in, then restart" message. Per-CLI invocation:

| CLI | Invocation |
|---|---|
| `gemini` | `gemini -p <prompt> -m <model>` |
| `claude` | `claude -p <prompt> --model <model>` |
| `codex` | `codex --full-auto <prompt>` |
| `ollama` | `ollama run <model> <prompt>` |
| `aider` | `aider --message <prompt> --yes --no-auto-commits` |

The shell tool picks the OS shell automatically: `cmd.exe` (via `%ComSpec%`) on Windows, `/bin/bash` or `/bin/sh` on macOS and Linux.

Sessions are capped at 500 messages. When the cap is reached the full transcript is archived, the oldest 250 messages are summarized into a single system note (no context is lost), and a fresh session file continues. Session files older than 30 days are auto-deleted on startup. Long tool outputs are truncated to 20 lines in the chat with a `... [truncated]` indicator, while the full output is still saved to the session file. The UI also survives terminal resize without crashing.

## Security

- The agent's working directory is the directory it was launched in. Shell and filesystem operations are confined to it; path traversal (`..`, absolute paths, `~`) is blocked. The trust prompt at launch is the gate for operating in that directory.
- Dangerous shell commands (`rm -rf /`, `format`, `mkfs`, fork bombs, …) are refused.
- `config.json` lives in `~/.openagent/` and is never committed; API keys and Telegram tokens are never logged.
- The Telegram bridge only accepts commands from the configured chat ID.

## Project layout

```
src/
  ui/        Ink terminal UI: App, ChatView, StatusBar, ToolOutput,
             CommandMenu, SettingsScreen, ModelPicker, ProviderPicker,
             SessionsPanel, commands
  agent/     loop (hot-swappable provider), planner, corrector
  tools/     shell (cross-platform), filesystem, browser, registry
  providers/ detector, cli, api, factory
  memory/    session (in-memory + disk persistence),
             session-store (session file paths/serialization),
             projects (projects.json registry), agent-md (durable)
  telegram/  remote-control bridge
  config/    zod-validated config, validate (live settings validation)
  util/      json (extract/parse JSON from noisy output)
  paths.ts   ~/.openagent locations + legacy migration
  startup.ts trust prompt → project detection → first-run wizard
  setup.ts   first-run provider wizard
  index.ts   entry point
bin/
  openagent.mjs  global `openagent` command launcher
```

Persistent state (config, memory, projects, sessions) lives under `~/.openagent/`, not in the source tree.

## License

MIT
