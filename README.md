# Open Agent

An open-source, self-hosted autonomous AI agent that runs locally — a lightweight alternative to Manus. Give it a task and it plans, executes end-to-end with real tools (shell, filesystem, headless browser, web research, sandboxed code, GitHub, long-term memory), observes results, and self-corrects on failure. It only stops to ask when it is genuinely stuck.

The primary interface is a terminal UI styled like Claude Code / OpenCode. Telegram acts as a remote controller that mirrors the terminal session.

## Features

- **Autonomous loop** — ReAct-style plan → act → observe → correct until the task is done.
- **Guided onboarding & permission control** — a first-run 7-step walkthrough explains what OpenAgent does, how it attaches to a workspace, and how much control you keep. You choose permissions (read files / suggest edits / require command approval); with command approval on, the agent **pauses for your y/n** before running a shell command, and turning off "suggest edits" blocks file writes. Replay it any time with `/onboarding`. (Headless `--task` runs stay fully autonomous.)
- **Multi-phase planning** — before touching a tool the agent decomposes the goal into an ordered plan of phases (pending / in_progress / completed / failed) and works through them, surfacing the live plan in the UI.
- **Resumable sessions** — full agent state (goal, plan, history) is saved as JSON under `~/.openagent/sessions/`; resume any session with `openagent --resume <sessionId>`.
- **Runs anywhere** — install it globally and launch `openagent` in any directory; that directory becomes the agent's working folder.
- **Real tools** — cross-platform shell (sandboxed to the launch directory), filesystem (traversal-blocked), and a reusable headless Chromium browser (navigate / click / type / `readText` / `waitFor` / `scroll` / `press` / screenshot).
- **Vision** — screenshots the agent takes are sent back to a vision-capable model on the next turn, so it can *see* the page and reason about it visually (on by default for API providers; toggle `enableVision` in `/settings`).
- **Parallel worker engine** — a `worker_threads` pool (resource-limited per worker) runs jobs concurrently; the live UI panel visualizes each worker's state.
- **Multi-language code execution** — the `code` tool runs **JavaScript, Python, Node, Bash, and PowerShell** in resource-limited worker threads (timeout + force-kill), confined to the workspace. JavaScript runs in an isolated in-process `vm` sandbox (safe, no FS/network; `isolated-vm` is an opt-in hardening hook via `OPENAGENT_SANDBOX=isolated-vm`); the other languages run via the local interpreter when installed and — having full system access like `shell` — are gated by the same approval prompt. JS snippets can also run several-at-once in parallel. (No Docker required; without it, isolation is process- and timeout-level, not a hardened VM.)
- **Web research** — the `research` tool searches the web via the [Tavily API](https://tavily.com) and digests the top results (set `TAVILY_API_KEY`, or add it in `/settings`).
- **Long-term memory** — the `memory` tool stores durable notes as Markdown files and recalls them with from-scratch BM25 keyword ranking (no vector DB).
- **Self-healing recovery** — failed steps are retried with exponential back-off and jitter before the agent gives up and reports `stuck`.
- **Background runs** — launch a task that runs to completion in a **detached process** which outlives the terminal (`/background <task>` or `openagent --background "…"`). It streams its lifecycle to `~/.openagent/runs/<id>.log`, persists its state, and notifies on completion (Telegram + a desktop ping). List runs with `/runs` and follow one live with `/attach <id>`.
- **Local scheduling** — recurring/one-shot tasks live in `~/.openagent/schedules.json`, fired by an in-process poller (`/schedule`); a due task launches as a background run so it never blocks the foreground agent.
- **GitHub connector** — read **and write** GitHub access via the `github` tool (list repos, read files, list issues, create/comment/close issues, list/get/create pull requests), authenticated with the `GITHUB_TOKEN` environment variable.
- **API-key first** — the primary way to run Open Agent is a hosted API key, no local tooling required: **OpenAI**, **Anthropic (Claude)**, **Google AI Studio (Gemini)**, **Groq**, and **OpenRouter**. The first-run wizard lists these providers, you paste a key, and a sensible default model is selected for you. Driving a local AI CLI (`gemini`, `claude`, `codex`, `aider`, `goose`, `ollama`) is still supported as an optional alternative; that bridge is hardened against hangs, crashes, and noisy output.
- **Projects & saved sessions** — each directory you launch in is remembered as a project; every message is saved to a per-project session file on disk, and you can reopen a recent one with `/sessions`.
- **Hot provider/model switching** — change provider or model mid-conversation (`/provider`, `/model`) without losing any history.
- **Slash commands** — `/settings`, `/tools`, `/model`, `/provider`, `/history`, `/sessions`, `/workers`, `/memory`, `/schedule`, `/clear`, `/help` run inline from the chat.
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
4. **First-run provider wizard** — runs **only if no provider is configured yet**. It lists the hosted API providers first (OpenAI, Anthropic, Google AI Studio, Groq, OpenRouter) — pick one, paste its key, and a default model is chosen for you. Any installed AI CLIs are offered after that as an optional local alternative. Nothing else (no Telegram, no workspace path) is asked here — those are configured later from `/settings`.
5. **First-run onboarding** — on a brand-new setup, a 7-step guided walkthrough runs (Welcome → understand the project → make changes safely → terminal/debugging help → choose workspace start mode → permissions & control → ready). It's keyboard-driven (Enter/→ next, ← back, `s` skip) and saves your permission choices. Once completed (or skipped) it doesn't reappear; replay it with `/onboarding` or by setting `onboardingCompleted` to false in `/settings`.
6. **Chat UI** — you land in the chat. Type a task, or type `/` to see the command menu.

### Slash commands

| Command | What it does |
|---|---|
| `/settings` | View and edit every config field (workspace override, provider, model, Telegram), validated before saving. |
| `/tools` | List the agent's available tools. |
| `/model` | Switch the active model — the conversation is preserved. |
| `/provider` | Switch the active provider (CLI ↔ API) — the conversation is preserved. |
| `/history` | Show the current session's message history. |
| `/sessions` | List and load a recent session for this project. |
| `/workers` | Show the parallel worker pool's live activity. |
| `/memory` | List long-term memory, or `/memory <query>` to BM25-search it. |
| `/schedule` | List schedules; `/schedule add <30s\|5m\|HH:MM\|ISO> <task>` to add, `/schedule remove <id>` to delete. |
| `/clear` | Clear the conversation (stays in the same project). |
| `/background` | Run a task in a detached background process — `/background <task>`. |
| `/runs` | List background runs and their status. |
| `/attach` | Follow a background run live — `/attach <runId>`. |
| `/onboarding` | Replay the first-run onboarding walkthrough. |
| `/help` | Show the command list. |

Switching provider or model never resets the conversation: the same on-disk session history is carried straight into the new provider's context.

## Configuration

All persistent data lives under `~/.openagent/` in your home directory — never in the app folder:

```
~/.openagent/
  config.json        provider, API keys, settings
  AGENT.md           global persistent memory
  projects.json      registry of known projects
  schedules.json     local scheduling store (polled in-process)
  runs/              background-run records + JSONL event logs
  memory/            long-term memory notes (one Markdown file each)
  sessions/<projectId>/<timestamp>.json
```

`config.json` lives at `~/.openagent/config.json` (not the project root) and is **never committed**, so your API keys and Telegram token stay out of any repo. Use [`config.example.json`](./config.example.json) as a reference for the field shape. If a legacy `config.json` or `projects.json` is found in the app folder, it is automatically migrated into `~/.openagent/` on startup.

| Field | Meaning |
|---|---|
| `workspacePath` | Optional override for the agent's working folder. Empty (`""`, the default) means use the directory `openagent` was launched in. |
| `providerMode` | `"cli"` or `"api"`. |
| `activeCliName` | Detected CLI to drive (cli mode). |
| `apiKey` / `apiProvider` | API key and `"openai" \| "anthropic" \| "google" \| "groq" \| "openrouter"` (api mode). `google` is Google AI Studio (Gemini, `x-goog-api-key` header). `groq` and `openrouter` are OpenAI-compatible (`https://api.groq.com/openai/v1`, `https://openrouter.ai/api/v1`). |
| `activeModel` | Model name/id to use (e.g. `gpt-4o`, `claude-sonnet-4-20250514`, `gemini-2.0-flash`, `llama-3.3-70b-versatile`, or an OpenRouter id like `openai/gpt-4o`); blank = the provider's default. |
| `telegramToken` / `telegramChatId` | Optional remote control via Telegram (set here, in `/settings`, or via env vars). |
| `requireCommandApproval` | When true (default), the agent pauses for your y/n approval before a shell command or real-interpreter `code` run in the TUI. |
| `enableVision` | When true (default), screenshots the agent takes are sent to a vision-capable model so it can see web pages. |
| `permSuggestEdits` / `permReadFiles` | Permission preferences from onboarding. `permSuggestEdits=false` blocks file writes/deletes; `permReadFiles` is informational (reads are always allowed). |
| `onboardingCompleted` | Whether the first-run walkthrough has been completed/skipped. Set false (or run `/onboarding`) to replay it. |
| `tavilyApiKey` | API key for the `research` tool's [Tavily](https://tavily.com) backend. Also read from the `TAVILY_API_KEY` env var, which takes precedence. |

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

Or run it in the background — the task executes in a detached process that keeps going after the command returns, and notifies on completion:

```bash
openagent --background "refactor the utils module and run the tests"
```

In a non-TTY environment the UI falls back to plain console output.

## How it works

On startup the agent merges two memory files into its system prompt: `~/.openagent/AGENT.md` (global memory — preferences and general info about you) and `<cwd>/AGENT.md` (project-specific memory). Either is created from a template if it is missing.

Each turn the agent is sent a **stable, cacheable system prefix** (its identity + the merged `AGENT.md` memory + the tool reference + the working directory + the response-format rules) plus the running history as a **role-tagged message array**. Volatile content — the current time and the recited plan — is appended to the most recent user message, never to the system prefix. Keeping that prefix byte-for-byte stable lets each backend reuse its **prompt cache** (Anthropic `cache_control`, OpenAI/Groq automatic prefix caching, Gemini `systemInstruction`), which cuts latency and cost on long runs; reciting the plan in the recent turn keeps the goal in attention. The agent replies with a single JSON object:

```json
{
  "thought": "internal reasoning",
  "action": "shell | filesystem | browser | github | research | code | memory | done | stuck",
  "params": {},
  "message": "optional text for the user",
  "progress": { "phase": 1, "status": "in_progress | completed | failed", "finding": "optional" }
}
```

The loop executes the chosen tool, feeds the result back (very large outputs are head/tail-compressed to keep the context lean), and repeats. A failing step is retried with the error in context and exponential back-off; after 3 identical failures the agent reports `stuck`.

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
  agent/     loop (hot-swappable provider), planner, plan (multi-phase),
             run-store + runner (detached background runs),
             corrector (self-healing exponential back-off)
  tools/     shell (cross-platform), filesystem, browser, research,
             code (sandboxed JS), registry
  workers/   worker_threads pool, worker-entry (isolated-vm/vm sandbox), types
  scheduler/ file-based scheduler + types
  connectors/ github (read + PR/issue write), registry, types
  providers/ detector, cli, api, factory, catalog (API provider metadata)
  memory/    session (in-memory + disk persistence),
             session-store (session file paths/serialization),
             session-manager (resumable AgentState), longterm (BM25 memory),
             projects (projects.json registry), agent-md (durable)
  ui/        + WorkerPanel (parallel-worker visualization), Onboarding (7-step first-run flow)
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
