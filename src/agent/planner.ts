import { z } from "zod";
import type { Message } from "../memory/session.js";
import type { Phase } from "./plan.js";
import { renderPlan } from "./plan.js";

/**
 * The strict JSON contract every provider turn must satisfy. The planner builds
 * the system prompt that enforces this, and the loop parses provider output
 * against `AgentResponseSchema`.
 */
export const AgentResponseSchema = z.object({
  thought: z.string(),
  action: z.enum(["shell", "filesystem", "browser", "github", "done", "stuck"]),
  params: z.record(z.unknown()).default({}),
  message: z.string().optional(),
  // Optional plan-progress signal. When present the loop updates the matching
  // phase's status and records the finding. Never required, so existing
  // responses that omit it stay valid.
  progress: z
    .object({
      phase: z.number(),
      status: z.enum(["in_progress", "completed", "failed"]),
      finding: z.string().optional(),
    })
    .optional(),
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/** Human-readable description of every tool and its exact params. */
const TOOL_REFERENCE = `Available tools and their EXACT params:

1. shell — run a shell command inside the workspace.
   params: { "command": "string" }

2. filesystem — read/write/list/delete/mkdir files (paths are relative to the workspace).
   params: { "operation": "read" | "write" | "list" | "delete" | "mkdir", "path": "string", "content": "string (only for write)" }

3. browser — drive a headless Chromium browser.
   params: { "operation": "navigate" | "click" | "type" | "screenshot" | "extractText" | "getHtml", "url": "string (for navigate)", "selector": "string (for click/type)", "text": "string (for type)" }

4. github — read-only GitHub access (requires the GITHUB_TOKEN environment variable).
   params: { "operation": "listRepos" | "readFile" | "listIssues", "repo": "owner/name (for readFile and listIssues)", "path": "file path within the repo (for readFile)" }

5. done — the task is fully complete. Put the final answer to the user in "message".
   params: { }

6. stuck — you cannot proceed without the user. Explain what you need in "message".
   params: { }`;

export interface SystemPromptOptions {
  agentMd: string;
  workspacePath: string;
  now: Date;
  /** When present, the current multi-phase plan is injected and enforced. */
  phases?: Phase[];
}

/** Build the system prompt injected at the top of every provider call. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const hasPlan = opts.phases !== undefined && opts.phases.length > 0;
  const planSection = hasPlan
    ? `

# Current plan
${renderPlan(opts.phases ?? [])}`
    : "";
  const planRule = hasPlan
    ? `
- Work through the plan phase by phase. When you start a phase set progress.status='in_progress' for that phase id; when you finish one set 'completed' (or 'failed') and include a short 'finding'. Use action 'done' only when ALL phases are complete.`
    : "";

  return `You are Open Agent, an autonomous AI agent that executes tasks end-to-end on the user's machine.
You plan, act with real tools (shell, filesystem, browser, github), observe the results, and self-correct on failure.
You work until the task is fully done. You do NOT stop to ask questions unless you are completely stuck.

# Persistent memory (AGENT.md)
${opts.agentMd}

# Environment
- Workspace path (all file and shell operations happen here): ${opts.workspacePath}
- Current date and time: ${opts.now.toString()}

# Tools
${TOOL_REFERENCE}${planSection}

# Response format — THIS IS MANDATORY
You must ALWAYS respond with a SINGLE valid JSON object matching this exact shape and nothing else:
{
  "thought": "your internal reasoning for this step",
  "action": "shell | filesystem | browser | github | done | stuck",
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
- When the task is finished, use action "done" and put the final answer in "message".${planRule}`;
}

/** Render the running conversation/tool history into the prompt body. */
export function renderHistory(messages: Message[]): string {
  if (messages.length === 0) {
    return "(no history yet)";
  }
  return messages
    .map((m) => {
      if (m.role === "user") return `USER:\n${m.content}`;
      if (m.role === "assistant") return `ASSISTANT (your previous JSON response):\n${m.content}`;
      if (m.role === "system") return `SYSTEM NOTE:\n${m.content}`;
      return `TOOL RESULT:\n${m.content}`;
    })
    .join("\n\n");
}

export interface PromptOptions {
  agentMd: string;
  workspacePath: string;
  history: Message[];
  now?: Date;
  /** Current multi-phase plan, forwarded to the system prompt. */
  phases?: Phase[];
}

/**
 * Assemble the full single-string prompt sent to the provider each turn:
 * system prompt + rendered history + a final instruction to emit the next action.
 */
export function buildPrompt(opts: PromptOptions): string {
  const system = buildSystemPrompt({
    agentMd: opts.agentMd,
    workspacePath: opts.workspacePath,
    now: opts.now ?? new Date(),
    phases: opts.phases,
  });
  const history = renderHistory(opts.history);
  return `${system}

# Conversation and tool history so far
${history}

# Your turn
Respond now with the SINGLE JSON object for your next action. Output only the JSON.`;
}
