import { z } from "zod";
import type { Message } from "../memory/session.js";
import type { Phase } from "./plan.js";
import { renderPlan } from "./plan.js";
import type { GenerateRequest, ChatMessage, ImageData } from "../providers/messages.js";
import { extractJsonObject } from "../util/json.js";
import { AGENT_TOOLS, VERIFY_TOOLS } from "./tool-schemas.js";
import { loadPlugins, renderPluginList } from "../plugins/index.js";

/**
 * The strict JSON contract every provider turn must satisfy. The planner builds
 * the system prompt that enforces this, and the loop parses provider output
 * against `AgentResponseSchema`.
 */
/** Every action the model can take: the real tools + the control actions. */
export const ACTION_NAMES = [
  "shell",
  "filesystem",
  "browser",
  "github",
  "research",
  "code",
  "memory",
  "serve",
  "http",
  "plugin",
  "note",
  "update_plan",
  "done",
  "stuck",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export function isActionName(value: string): value is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(value);
}

export const AgentResponseSchema = z
  .object({
    thought: z.string(),
    // Optional ONLY when an "actions" batch is present (see the refine below).
    action: z.enum(ACTION_NAMES).optional(),
    params: z.record(z.unknown()).default({}),
    message: z.string().optional(),
    // IMP-02: several INDEPENDENT actions in one turn, executed in parallel.
    // .catch(undefined) degrades a malformed batch to "no batch" so a bad
    // entry can't reject an otherwise-valid single-action response.
    actions: z
      .array(
        z.object({
          action: z.enum(ACTION_NAMES),
          params: z.record(z.unknown()).default({}),
          message: z.string().optional(),
        }),
      )
      .optional()
      .catch(undefined),
    // Optional plan-progress signal. When present the loop updates the matching
    // phase's status and records the finding. Never required, so existing
    // responses that omit it stay valid.
    // .catch(undefined) ensures a malformed or null progress value (e.g. the
    // model emits `"progress": null` or `"phase": "1"`) degrades to "no progress"
    // instead of causing safeParse to reject the entire response.
    progress: z
      .object({
        phase: z.coerce.number(),
        status: z.enum(["in_progress", "completed", "failed"]),
        finding: z.string().optional(),
      })
      .optional()
      .catch(undefined),
  })
  .refine((r) => r.action !== undefined || (r.actions !== undefined && r.actions.length > 0), {
    message: 'response must include an "action" (or a non-empty "actions" array)',
  });

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/** Human-readable description of every tool and its exact params. */
const TOOL_REFERENCE = `Available tools and their EXACT params:

1. shell — run a shell command inside the workspace.
   params: { "command": "string" }

2. filesystem — file operations (paths are relative to the workspace).
   params: { "operation": "read" | "write" | "list" | "delete" | "mkdir" | "grep" | "find" | "diff",
             "path": "string (grep/find: dir or file to search, default workspace root; diff: the FIRST file)",
             "content": "string (only for write)",
             "pattern": "grep: regex to search file contents; find: file-name glob like *.ts",
             "pathB": "diff: the SECOND file",
             "recursive": boolean (grep/find, default true), "caseInsensitive": boolean (grep, default false) }
   Use grep to search inside files, find to locate files by name, diff to compare two files — much cheaper than reading whole files.

3. browser — drive a headless Chromium browser.
   params: { "operation": "navigate" | "click" | "type" | "screenshot" | "extractText" | "readText" | "getHtml" | "waitFor" | "scroll" | "press" | "setCookies" | "getCookies" | "injectJs" | "download" | "network",
             "url": "(navigate/download)", "selector": "(click/type/waitFor)", "text": "(type)", "key": "(press, e.g. Enter)", "target": "bottom|top|down|up (scroll)", "timeout": number (waitFor, ms),
             "cookies": "JSON array of cookie objects (setCookies)", "script": "JS to evaluate; its value is returned (injectJs)", "path": "workspace-relative save path (download)", "filter": "URL filter (network)" }
   "readText" returns clean main/article text; "waitFor" waits for a selector; "scroll" loads lazy content; "press" sends a key.
   "setCookies"/"getCookies" manage login sessions; "injectJs" evaluates JS in the page; "download" saves a file using the page's cookies; "network" lists recent requests (method, url, status).
   After a "screenshot", the image is shown back to you on your next turn (with a vision-capable model) so you can SEE the page and reason about it visually.

4. github — GitHub access (requires the GITHUB_TOKEN environment variable). Read AND write operations.
   params: { "operation": "listRepos" | "readFile" | "listIssues" | "createIssue" | "commentIssue" | "closeIssue" | "listPullRequests" | "getPullRequest" | "createPullRequest",
             "repo": "owner/name", "path": "file path (readFile)", "title": "(createIssue/createPullRequest)",
             "body": "(createIssue/commentIssue/createPullRequest)", "number": "issue or PR number (commentIssue/closeIssue/getPullRequest)",
             "head": "source branch (createPullRequest)", "base": "target branch (createPullRequest)", "state": "open|closed|all (listPullRequests)" }

5. research — research the web for a query (headless browser, no API key). Returns a digest of top results.
   params: { "query": "string", "maxResults": number (optional, default 5), "fetchPages": boolean (optional — also fetch the top pages' text) }

6. code — run a code snippet in a resource-limited worker thread, install dependencies, or run a test suite.
   params: { "language": "js" | "python" | "node" | "bash" | "powershell" (default "js"), "code": "string (source)", "timeoutMs": number (optional) }
            OR { "tasks": ["js source", ...] } to run several JS snippets in parallel
            OR { "operation": "installDeps", "packageManager": "npm" | "pip", "packages": ["name", ...] }
            OR { "operation": "runTests", "framework": "pytest" | "jest" | "mocha" | "vitest" | "go", "path": "optional test path" } — returns "TESTS: N passed, M failed".
   "js" runs in an isolated in-process sandbox (safe, no filesystem/network). The other languages — and installDeps/runTests — run via local interpreters in the workspace, with full system access; those require the user's approval, like shell.

7. memory — durable long-term memory, searchable by MEANING (semantic + keyword hybrid).
   params: { "operation": "remember" | "recall", "content": "text to store (remember)", "tags": ["optional","tags"], "importance": number 1-10 (remember, optional), "query": "search text (recall)", "topK": number (optional) }

8. serve — host a workspace directory over HTTP on localhost and return the URL (local preview).
   params: { "dir": "workspace-relative dir (optional, default the workspace root)", "port": number (optional) }

9. http — make an HTTP request and read the response (use this instead of curl). Private/internal addresses are blocked.
   params: { "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" (default GET), "url": "absolute http(s) URL",
             "headers": { "name": "value" } (optional), "body": "string (POST/PUT/PATCH)", "timeoutMs": number (optional) }

10. plugin — run an installed user plugin in the JS sandbox (no filesystem/network access).
   params: { "name": "the plugin's name", "params": { ...arguments matching the plugin's schema } }
${renderPluginList(loadPlugins().plugins)
  .split("\n")
  .map((line) => `   ${line}`)
  .join("\n")}

11. note — record durable task state in working memory (shown back to you every turn): facts discovered, constraints, named variables. Use it for things you must not forget mid-task.
   params: { "facts": ["..."], "constraints": ["..."], "variables": { "name": "value" } } (all optional)

12. update_plan — report progress on a phase (alternative to the "progress" field).
   params: { "phase": number, "status": "in_progress" | "completed" | "failed", "finding": "short note (optional)" }

13. done — the task is fully complete. Put the final answer to the user in "message".
   params: { }

14. stuck — you cannot proceed without the user. Explain what you need in "message".
   params: { }`;

export interface SystemPromptOptions {
  agentMd: string;
  workspacePath: string;
}

/**
 * Build the STABLE system prefix sent (and cached) on every turn. It must stay
 * byte-for-byte identical across a session so each provider's prompt cache hits,
 * so volatile content — the current time and the live plan — is deliberately
 * NOT here. The loop puts those in the final user message (see
 * {@link buildGenerateRequest}), which keeps the cache prefix stable and keeps
 * the goal in recent attention (recitation).
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  return `You are Open Agent, an autonomous AI agent that executes tasks end-to-end on the user's machine.
You plan, act with real tools (shell, filesystem, browser, github, research, code, memory, http, serve), observe the results, and self-correct on failure.
You work until the task is fully done. You do NOT stop to ask questions unless you are completely stuck.

# Persistent memory (AGENT.md)
${opts.agentMd}

# Environment
- Workspace path (all file and shell operations happen here): ${opts.workspacePath}

# Tools
${TOOL_REFERENCE}

# How to act
If you have been given tools (function calling), CALL a tool — the tool name is the action and its arguments are the params. When several actions are INDEPENDENT of each other (e.g. reading three files, or two unrelated commands), you may call SEVERAL tools in the same turn and they will run in parallel; actions that depend on an earlier result must wait for their own turn. Otherwise, respond with the SINGLE JSON object described below.

# Response format (when not using tools) — THIS IS MANDATORY
You must ALWAYS respond with a SINGLE valid JSON object matching this exact shape and nothing else:
{
  "thought": "your internal reasoning for this step",
  "action": "shell | filesystem | browser | github | research | code | memory | serve | http | plugin | note | done | stuck",
  "params": { ... },
  "message": "what to show the user (optional)",
  "progress": { "phase": 1, "status": "in_progress | completed | failed", "finding": "optional short note" }
}
The "progress" field is optional; include it only to report plan progress.
To run several INDEPENDENT actions in parallel, replace "action"/"params" with an "actions" array:
  "actions": [ { "action": "filesystem", "params": { ... } }, { "action": "shell", "params": { ... } } ]

Rules:
- You must ALWAYS respond with valid JSON matching the specified format. Never respond with plain text.
- Never wrap the JSON in markdown code fences. Output the raw JSON object only.
- Never ask the user a question unless your action is "stuck".
- Always take the next concrete action that moves the task forward.
- Use one action per response — or an "actions" batch ONLY when the actions are independent of each other. Look at the latest TOOL RESULT before deciding the next step.
- When the task is finished, use action "done" and put the final answer in "message".
- When a plan is shown in the current turn, work through it phase by phase: report progress via the "progress" field (phase id + status + a short finding), and use action "done" only when ALL phases are complete.`;
}

/**
 * Map the session history into provider chat messages (user/assistant only).
 * We keep the JSON action protocol, so tool results and system notes are folded
 * into `user` messages — the model reads tool output as observations.
 */
function mapHistory(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content });
    } else if (m.role === "tool_result") {
      out.push({ role: "user", content: `TOOL RESULT:\n${m.content}` });
    } else if (m.role === "system") {
      out.push({ role: "user", content: `SYSTEM NOTE:\n${m.content}` });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

export interface PromptOptions {
  agentMd: string;
  workspacePath: string;
  history: Message[];
  now?: Date;
  /** Current multi-phase plan, recited in the final user turn. */
  phases?: Phase[];
  /** Images (e.g. a screenshot) to attach to the final user turn for vision. */
  images?: ImageData[];
  /** IMP-08: rendered working-memory block (facts/constraints/artifacts/
   *  variables), recited in the final user turn — never the cacheable system
   *  prefix. Omitted when empty. */
  workingMemory?: string;
}

/**
 * Assemble the provider request for one turn: a STABLE cacheable system prefix
 * plus the role-tagged history. Volatile content (the current time and the
 * recited plan) is appended to the final USER message — never to `system` — so
 * the cache prefix stays byte-stable and the goal stays in recent attention.
 */
export function buildGenerateRequest(opts: PromptOptions): GenerateRequest {
  const system = buildSystemPrompt({
    agentMd: opts.agentMd,
    workspacePath: opts.workspacePath,
  });
  const messages = mapHistory(opts.history);

  const now = opts.now ?? new Date();
  const hasPlan = opts.phases !== undefined && opts.phases.length > 0;
  const planBlock = hasPlan
    ? `\n\n# Current plan (work through it; keep it updated via "progress")\n${renderPlan(opts.phases ?? [])}`
    : "";
  const wmBlock =
    opts.workingMemory !== undefined && opts.workingMemory.trim().length > 0
      ? `\n\n# Working memory (your accumulated task state — keep it updated via "note")\n${opts.workingMemory}`
      : "";
  const finalTurn =
    `# Current context\nCurrent date and time: ${now.toString()}${planBlock}${wmBlock}\n\n` +
    `# Your turn\nRespond now with the SINGLE JSON object for your next action. Output only the JSON.`;

  // Append the volatile turn to the last user message (keeps roles alternating)
  // or as a fresh user message if the last turn was the assistant. Any vision
  // images ride on that same final user message.
  const images = opts.images && opts.images.length > 0 ? opts.images : undefined;
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = `${last.content}\n\n${finalTurn}`;
    if (images) last.images = images;
  } else {
    messages.push(images ? { role: "user", content: finalTurn, images } : { role: "user", content: finalTurn });
  }

  // Offer the action set as NATIVE tools. API providers use function-calling and
  // return a structured action; providers without tools (CLI) fall back to the
  // JSON action protocol described in the system prompt.
  return { system, messages, tools: [...AGENT_TOOLS] };
}

// ---- Reflection / self-critique --------------------------------------------

/** A self-check verdict on whether the goal was actually accomplished. */
export interface Reflection {
  complete: boolean;
  reason: string;
  nextStep?: string;
}

/**
 * Build the request asked of the model right before accepting "done": review
 * the full transcript against the goal and judge whether it is truly finished.
 *
 * IMP-05: the reviewer may VERIFY before judging — the request offers the
 * filesystem tool (read-only operations only; the loop enforces that) plus a
 * `verdict` tool, so the model can re-read generated files, grep for expected
 * content, or diff outputs instead of trusting the transcript. Observations
 * gathered by earlier verification steps are passed back via `observations`.
 */
export function buildReflectionRequest(opts: {
  agentMd: string;
  workspacePath: string;
  goal: string;
  history: Message[];
  /** Tool observations from earlier rounds of this verification pass. */
  observations?: string[];
}): GenerateRequest {
  const system = `You are the SELF-CHECK reviewer for Open Agent. Given the original goal and the full work transcript, judge whether the goal has been FULLY and correctly accomplished — not merely attempted. Be strict but fair: only say complete when a user would agree the task is genuinely done.

You are CHECKING, not doing. Before judging you may verify the actual results — re-read a generated file, grep for expected content, list a directory, diff two files — using the filesystem tool with operations read, list, grep, find, or diff ONLY (writes are not available to you). Verify at most a few key facts, then deliver the verdict.

To deliver the verdict, call the "verdict" tool — or respond with ONLY a single JSON object and nothing else:
{ "complete": true | false, "reason": "one short sentence", "nextStep": "if not complete, the single most important next action" }`;

  const messages = mapHistory(opts.history);
  const observationBlock =
    opts.observations && opts.observations.length > 0
      ? `\n\n# Your verification observations so far\n${opts.observations.join("\n\n")}`
      : "";
  const finalTurn =
    `# Original goal\n${opts.goal}${observationBlock}\n\n# Your turn\n` +
    `Review the transcript above against the goal. Verify a key fact with a read-only filesystem call if needed, ` +
    `or respond now with the SINGLE JSON verdict.`;
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = `${last.content}\n\n${finalTurn}`;
  } else {
    messages.push({ role: "user", content: finalTurn });
  }
  return { system, messages, tools: [...VERIFY_TOOLS] };
}

/**
 * Parse a self-check reply. Biased toward accepting "done": only an explicit
 * `"complete": false` blocks completion, so a malformed/uncertain verdict never
 * traps the agent in an endless "not done" loop.
 */
export function parseReflection(raw: string): Reflection {
  const json = extractJsonObject(raw);
  if (json === null) {
    return { complete: true, reason: "" };
  }
  try {
    const d = JSON.parse(json) as Record<string, unknown>;
    const complete = d.complete === false || d.complete === "false" ? false : true;
    const reason = typeof d.reason === "string" ? d.reason : "";
    const nextStep = typeof d.nextStep === "string" && d.nextStep.trim().length > 0 ? d.nextStep : undefined;
    return nextStep ? { complete, reason, nextStep } : { complete, reason };
  } catch {
    return { complete: true, reason: "" };
  }
}
