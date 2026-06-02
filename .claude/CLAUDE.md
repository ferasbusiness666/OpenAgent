# CLAUDE.md — Open Agent Build Instructions

## What You Are Building

Open Agent is an open-source autonomous AI agent that runs locally — a self-hosted alternative to Manus. It takes a task, plans it, executes it end-to-end using real tools (browser, shell, file system), self-corrects on failure, and never stops to ask questions unless completely stuck. The primary interface is a terminal UI styled like Claude Code / OpenCode. Telegram is a remote controller that mirrors the terminal session.

---

## Your Behavior Rules

- Never stop mid-build to ask a question. Make the decision yourself and move on.
- Never write TODO, FIXME, or placeholder functions. Every function must be fully implemented before moving to the next file.
- Complete each component entirely before starting the next one.
- After finishing each component, run it and verify it works.
- If a package fails to install, find the best alternative and keep going.
- If you hit a design decision not covered here, pick the better option and document it in a comment.
- Keep going until every component in the build order is complete.
- TypeScript strict mode — no `any` types anywhere.

---

## Tech Stack

| Purpose | Package |
|---|---|
| Terminal UI | `ink` + `react` |
| Browser automation | `playwright` (chromium only) |
| Telegram | `node-telegram-bot-api` |
| CLI args | `commander` |
| File operations | `fs-extra` |
| Config validation | `zod` |
| Styling | `chalk` + `ora` |
| TypeScript runner | `tsx` |
| Types | `@types/node` + `@types/react` |

---

## Folder Structure

```
open-agent/
├── src/
│   ├── ui/
│   │   ├── App.tsx
│   │   ├── ChatView.tsx
│   │   ├── StatusBar.tsx
│   │   └── ToolOutput.tsx
│   ├── agent/
│   │   ├── loop.ts
│   │   ├── planner.ts
│   │   └── corrector.ts
│   ├── tools/
│   │   ├── index.ts
│   │   ├── shell.ts
│   │   ├── filesystem.ts
│   │   └── browser.ts
│   ├── providers/
│   │   ├── index.ts
│   │   ├── detector.ts
│   │   ├── cli.ts
│   │   └── api.ts
│   ├── memory/
│   │   ├── session.ts
│   │   └── agent-md.ts
│   ├── telegram/
│   │   └── bridge.ts
│   ├── config/
│   │   └── index.ts
│   └── index.ts
├── workspace/
├── AGENT.md
├── config.json        ← gitignored
├── package.json
├── tsconfig.json
└── README.md
```

---

## Build Order

Build in this exact sequence. Do not skip ahead.

---

### Step 1 — Project Setup

- Initialize `package.json` with all dependencies listed in the tech stack table above.
- Set up `tsconfig.json`: strict mode, ESNext target, Node module resolution, JSX react.
- Create the full folder structure above (empty files are fine at this stage).
- Add scripts to `package.json`:
  - `"start": "tsx src/index.ts"`
  - `"build": "tsc"`
  - `"dev": "tsx watch src/index.ts"`
- Run `npm install`.
- Verify install completes with no errors before continuing.

---

### Step 2 — Config System

**File:** `src/config/index.ts`

Config schema (use zod):
```ts
{
  workspacePath: string       // default: "./workspace"
  providerMode: "cli" | "api"
  activeCliName: string       // name of the detected CLI in use
  apiKey: string
  apiProvider: "openai" | "anthropic" | "google"
  telegramToken: string
  telegramChatId: string
}
```

- Read config from `config.json` in project root on every load.
- Write config back after any changes.
- If `config.json` does not exist, create it with empty defaults.
- On startup, make sure the workspace folder exists. Create it if it does not.
- Export `getConfig()` and `saveConfig(partial)` functions.

---

### Step 3 — First Run Setup Wizard

**File:** `src/setup.ts`

This runs on first launch when config is empty or incomplete.

Steps:
1. Detect installed CLIs (see Step 4 provider detector).
2. Show the user a list of detected CLIs + an "Enter API key instead" option.
3. If user picks a CLI → save `providerMode: "cli"` and `activeCliName`.
4. If user picks API key → ask for key and provider name → save to config.
5. Ask for workspace path (show default, Enter to accept).
6. Ask for Telegram bot token (optional — pressing Enter skips it).
7. If Telegram token provided, ask for chat ID.
8. Save everything to `config.json`.
9. Print "Setup complete. Starting Open Agent..." and continue.

Use readline from Node.js for prompts (not Ink — setup runs before UI).

---

## Subagent Strategy

After completing Steps 1, 2, and 3 (setup, config, wizard), spawn 3 parallel subagents:

- **Subagent A**: Build Step 4 — the full provider system (src/providers/)
- **Subagent B**: Build Step 5 — the full tool system (src/tools/)
- **Subagent C**: Build Step 7 — the full memory system (src/memory/)

Each subagent works in its own folder. They do not touch each other's files.

Wait for all 3 to finish before continuing.

Then the main agent continues sequentially: Step 6 (agent loop) → Step 8 (UI) → Step 9 (entry point) → Step 10 (Telegram).



### Step 4 — Provider System

**Files:** `src/providers/`

**`detector.ts`**
- Scan PATH for these CLIs: `gemini`, `claude`, `codex`, `aider`, `goose`, `ollama`.
- For each, check if it exists using `which` (unix) or `where` (windows).
- Return an array of found CLI names.

**`cli.ts`** — CLIProvider class
- Spawns the active CLI as a child process.
- Sends the full conversation history + system prompt as a single prompt string.
- Captures stdout until the process exits.
- Each CLI has a different invocation format — handle each explicitly:
  - `gemini`: `gemini -p "<prompt>"`
  - `claude`: `claude -p "<prompt>"`
  - `codex`: `codex "<prompt>"`
  - `aider`: `aider --message "<prompt>" --no-auto-commits`
  - `ollama`: `ollama run <model> "<prompt>"`
- Returns the raw text output.
- Timeout: 60 seconds per call.

**`api.ts`** — APIProvider class
- Takes `apiKey` and `apiProvider` from config.
- For `anthropic`: POST to `https://api.anthropic.com/v1/messages` with model `claude-sonnet-4-20250514`.
- For `openai`: POST to `https://api.openai.com/v1/chat/completions` with model `gpt-4o`.
- For `google`: POST to Google Gemini API with model `gemini-2.0-flash`.
- Returns response text.

**`index.ts`** — Provider factory
- Reads config and returns either a CLIProvider or APIProvider instance.
- Export `getProvider()` function.

---

### Step 5 — Tool System

**Files:** `src/tools/`

**`shell.ts`** — ShellTool
- Runs shell commands using `child_process.exec`.
- Working directory is ALWAYS the workspace folder from config. Never run outside it.
- Timeout: 30 seconds.
- Returns `{ stdout, stderr, exitCode }`.
- Block dangerous commands: `rm -rf /`, `format`, `mkfs`, anything targeting paths outside workspace.

**`filesystem.ts`** — FilesystemTool
- Operations: `read(path)`, `write(path, content)`, `list(path)`, `delete(path)`, `mkdir(path)`.
- All paths are relative to workspace folder.
- Block path traversal: reject any path containing `..` or starting with `/` or `~`.
- Use `fs-extra` for all operations.
- Returns operation result as a string.

**`browser.ts`** — BrowserTool
- Uses Playwright chromium, headless mode.
- Operations:
  - `navigate(url)` → navigates to URL, returns page title
  - `click(selector)` → clicks element
  - `type(selector, text)` → types into element
  - `screenshot()` → takes screenshot, saves to workspace, returns file path
  - `extractText()` → returns all visible text from current page
  - `getHtml()` → returns page HTML
- Keep one browser instance alive per session. Reuse it across calls.
- On any Playwright error, close and reopen the browser and retry once.

**`index.ts`** — ToolRegistry
- Maps tool names to instances: `"shell"`, `"filesystem"`, `"browser"`.
- Export `executetool(name, params)` async function.
- Returns `{ success: boolean, result: string, error?: string }`.

---

### Step 6 — Agent Loop

**Files:** `src/agent/`

This is the core of the entire project. Build it with care.

**The loop (`loop.ts`)**

The AgentLoop class has one main method: `run(task: string)`.

It works like this:

```
1. Load AGENT.md content
2. Build system prompt (see planner.ts)
3. Add user task to session memory
4. Send to provider → get JSON response
5. Parse the response
6. If action is a tool → execute it → add result to session memory → go to step 4
7. If action is "done" → emit done event with final message → stop
8. If action is "stuck" → emit stuck event with message → wait for user input → continue
9. On tool failure → retry up to 3 times with error appended to context
10. After 3 failures on same step → treat as "stuck"
```

The provider MUST always return a response in this exact JSON format. Build the system prompt to enforce this strictly:

```json
{
  "thought": "my internal reasoning for this step",
  "action": "shell | filesystem | browser | done | stuck",
  "params": {},
  "message": "what to show the user (optional)"
}
```

Tool params per action:
- `shell`: `{ "command": "string" }`
- `filesystem`: `{ "operation": "read|write|list|delete|mkdir", "path": "string", "content": "string (for write)" }`
- `browser`: `{ "operation": "navigate|click|type|screenshot|extractText|getHtml", "url": "string", "selector": "string", "text": "string" }`
- `done`: `{ }` — message is the final answer to the user
- `stuck`: `{ }` — message explains what the agent needs from the user

AgentLoop emits these events (use Node.js EventEmitter):
- `thought` — agent's internal reasoning string
- `toolCall` — `{ tool, params }`
- `toolResult` — `{ tool, result, success }`
- `message` — agent message to show user
- `done` — final answer string
- `stuck` — question for user
- `error` — unrecoverable error

**`planner.ts`** — builds the system prompt

System prompt must include:
- What the agent is: autonomous agent that executes tasks end-to-end
- AGENT.md content injected directly
- List of available tools with their exact params
- Workspace path
- Current date and time
- This instruction: "You must ALWAYS respond with valid JSON matching the specified format. Never respond with plain text. Never ask the user a question unless your action is 'stuck'. Always take the next concrete action."

**`corrector.ts`** — retry logic

- Tracks failure count per step.
- On failure, appends error message to context before next provider call.
- After 3 failures on the same tool call, switches action to "stuck".

---

### Step 7 — Memory System

**Files:** `src/memory/`

**`session.ts`** — SessionMemory
- Stores message history array for current session in memory only.
- Message type: `{ role: "user" | "assistant" | "tool_result", content: string, timestamp: Date }`
- Methods: `add(message)`, `getHistory()`, `clear()`, `getLast(n)`.
- Gone when session ends. Never persisted to disk.

**`agent-md.ts`** — AgentMemory
- Reads `AGENT.md` from project root on startup.
- If `AGENT.md` does not exist, create it with a default template.
- Provides `getContent()` for the planner to inject into system prompt.
- Provides `update(newContent)` to append or rewrite sections when the agent learns new persistent info about the user.
- Default AGENT.md template:
```markdown
# Agent Memory

## About the User
(nothing yet)

## Preferences
(nothing yet)

## Notes
(nothing yet)
```

---

### Step 8 — Terminal UI

**Files:** `src/ui/`

Style reference: Claude Code, OpenCode. Dark background, clean typography, clear visual hierarchy. Each message type has its own distinct style.

**`App.tsx`** — root Ink component
- Manages global state: messages array, current status, active provider name.
- Subscribes to AgentLoop events and updates state.
- Renders `<ChatView>` and `<StatusBar>`.
- Handles user input from Ink's `useInput` or a text input component.

**`ChatView.tsx`** — message list
- Scrollable list of messages.
- Message types and their styles:
  - User input → white, right-aligned label "You"
  - Agent thought → dim gray, italic, label "thinking"
  - Tool call → cyan, shows tool name + params summary
  - Tool result → green (success) or red (failure), shows result preview
  - Agent message → white, label "Agent"
  - Done → bold white + green checkmark
  - Stuck → yellow, label "needs input"
  - Error → red, label "error"

**`StatusBar.tsx`** — bottom bar (always visible)
- Shows: current status (idle / thinking / running: toolname / done) | active provider | workspace path.
- Color-coded by status: gray for idle, blue for thinking, yellow for running, green for done.

**`ToolOutput.tsx`** — compact tool display component
- Shows tool name as a badge.
- Params as a one-line summary (truncate if too long).
- Result preview (first 3 lines).
- Expandable on request is a future feature — for now just show the preview.

---

### Step 9 — Entry Point

**File:** `src/index.ts`

On startup:
1. Load config with `getConfig()`.
2. If config is empty or incomplete → run setup wizard from `src/setup.ts`.
3. Load `AGENT.md` with AgentMemory.
4. Initialize provider with `getProvider()`.
5. Initialize ToolRegistry.
6. Initialize SessionMemory.
7. Initialize AgentLoop (pass provider, tools, session memory, agent memory).
8. If `telegramToken` is set in config → start TelegramBridge.
9. Render the Ink App, passing agentLoop instance.

---

### Step 10 — Telegram Bridge

**File:** `src/telegram/bridge.ts`

- Only starts if `telegramToken` is set in config.
- TelegramBridge class using `node-telegram-bot-api`.
- On bot message received → call `agentLoop.run(messageText)`.
- Subscribe to all AgentLoop events → format and forward to Telegram chat:
  - `thought` → send as italic gray text
  - `toolCall` → send as `🔧 tool: params`
  - `toolResult` → send as `✅ result` or `❌ error`
  - `message` → send as plain message
  - `done` → send as `✅ Done: final answer`
  - `stuck` → send as `⚠️ Agent needs input: question`
- On startup, send: `"✅ Open Agent is running. Send me a task."`
- One active task at a time — if a task is running, queue incoming messages.

---

## Security Rules

These are non-negotiable:

- Shell tool: never execute outside workspace folder.
- Filesystem tool: never read or write outside workspace folder. Block `..` in all paths.
- No credentials in logs or terminal output.
- `config.json` must be in `.gitignore`.
- Never log API keys or Telegram tokens.

---

## Final Verification

After all steps are done:

1. Run `npm start` — terminal UI must launch cleanly.
2. Run a simple task: `"create a file called hello.txt with the content Hello World"` — agent must complete it autonomously.
3. Run `npx tsc --noEmit` — must compile with zero errors.
4. If Telegram token is in config, verify the bot sends the startup message.
5. Check that `workspace/` folder was created.
6. Check that `AGENT.md` was created.

If any of these fail, fix them before stopping.
