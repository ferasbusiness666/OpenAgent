import { z } from "zod";
import type { Message } from "../memory/session.js";
import type { Phase } from "./plan.js";
import { renderPlan } from "./plan.js";
import type { GenerateRequest, ChatMessage, ImageData } from "../providers/messages.js";

/**
 * The strict JSON contract every provider turn must satisfy. The planner builds
 * the system prompt that enforces this, and the loop parses provider output
 * against `AgentResponseSchema`.
 */
export const AgentResponseSchema = z.object({
  thought: z.string(),
  action: z.enum([
    "shell",
    "filesystem",
    "browser",
    "github",
    "research",
    "code",
    "memory",
    "done",
    "stuck",
  ]),
  params: z.record(z.unknown()).default({}),
  message: z.string().optional(),
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
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/** Human-readable description of every tool and its exact params. */
const TOOL_REFERENCE = `Available tools and their EXACT params:

1. shell — run a shell command inside the workspace.
   params: { "command": "string" }

2. filesystem — read/write/list/delete/mkdir files (paths are relative to the workspace).
   params: { "operation": "read" | "write" | "list" | "delete" | "mkdir", "path": "string", "content": "string (only for write)" }

3. browser — drive a headless Chromium browser.
   params: { "operation": "navigate" | "click" | "type" | "screenshot" | "extractText" | "readText" | "getHtml" | "waitFor" | "scroll" | "press",
             "url": "(navigate)", "selector": "(click/type/waitFor)", "text": "(type)", "key": "(press, e.g. Enter)", "target": "bottom|top|down|up (scroll)", "timeout": number (waitFor, ms) }
   "readText" returns clean main/article text; "waitFor" waits for a selector; "scroll" loads lazy content; "press" sends a key.
   After a "screenshot", the image is shown back to you on your next turn (with a vision-capable model) so you can SEE the page and reason about it visually.

4. github — GitHub access (requires the GITHUB_TOKEN environment variable). Read AND write operations.
   params: { "operation": "listRepos" | "readFile" | "listIssues" | "createIssue" | "commentIssue" | "closeIssue" | "listPullRequests" | "getPullRequest" | "createPullRequest",
             "repo": "owner/name", "path": "file path (readFile)", "title": "(createIssue/createPullRequest)",
             "body": "(createIssue/commentIssue/createPullRequest)", "number": "issue or PR number (commentIssue/closeIssue/getPullRequest)",
             "head": "source branch (createPullRequest)", "base": "target branch (createPullRequest)", "state": "open|closed|all (listPullRequests)" }

5. research — research the web for a query (headless browser, no API key). Returns a digest of top results.
   params: { "query": "string", "maxResults": number (optional, default 5), "fetchPages": boolean (optional — also fetch the top pages' text) }

6. code — run a code snippet in a resource-limited worker thread and return its output.
   params: { "language": "js" | "python" | "node" | "bash" | "powershell" (default "js"), "code": "string (source)", "timeoutMs": number (optional) }
            OR { "tasks": ["js source", ...] } to run several JS snippets in parallel.
   "js" runs in an isolated in-process sandbox (safe, no filesystem/network). The other languages run via the local interpreter (if installed) in the workspace, with full system access — those require the user's approval, like shell.

7. memory — durable long-term memory, searchable with keyword (BM25) ranking.
   params: { "operation": "remember" | "recall", "content": "text to store (remember)", "tags": ["optional","tags"], "query": "search text (recall)", "topK": number (optional) }

8. done — the task is fully complete. Put the final answer to the user in "message".
   params: { }

9. stuck — you cannot proceed without the user. Explain what you need in "message".
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
You plan, act with real tools (shell, filesystem, browser, github, research, code, memory), observe the results, and self-correct on failure.
You work until the task is fully done. You do NOT stop to ask questions unless you are completely stuck.

# Persistent memory (AGENT.md)
${opts.agentMd}

# Environment
- Workspace path (all file and shell operations happen here): ${opts.workspacePath}

# Tools
${TOOL_REFERENCE}

# Response format — THIS IS MANDATORY
You must ALWAYS respond with a SINGLE valid JSON object matching this exact shape and nothing else:
{
  "thought": "your internal reasoning for this step",
  "action": "shell | filesystem | browser | github | research | code | memory | done | stuck",
  "params": { ... },
  "message": "what to show the user (optional)",
  "progress": { "phase": 1, "status": "in_progress | completed | failed", "finding": "optional short note" }
}
The "progress" field is optional; include it only to report plan progress.

Rules:
- You must ALWAYS respond with valid JSON matching the specified format. Never respond with plain text.
- Never wrap the JSON in markdown code fences. Output the raw JSON object only.
- Never ask the user a question unless your action is "stuck".
- Always take the next concrete action that moves the task forward.
- Use exactly one action per response. Look at the latest TOOL RESULT before deciding the next step.
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
  const finalTurn =
    `# Current context\nCurrent date and time: ${now.toString()}${planBlock}\n\n` +
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

  return { system, messages };
}
