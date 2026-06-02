import { z } from "zod";
import type { Message } from "../memory/session.js";

/**
 * The strict JSON contract every provider turn must satisfy. The planner builds
 * the system prompt that enforces this, and the loop parses provider output
 * against `AgentResponseSchema`.
 */
export const AgentResponseSchema = z.object({
  thought: z.string(),
  action: z.enum(["shell", "filesystem", "browser", "done", "stuck"]),
  params: z.record(z.unknown()).default({}),
  message: z.string().optional(),
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

4. done — the task is fully complete. Put the final answer to the user in "message".
   params: { }

5. stuck — you cannot proceed without the user. Explain what you need in "message".
   params: { }`;

export interface SystemPromptOptions {
  agentMd: string;
  workspacePath: string;
  now: Date;
}

/** Build the system prompt injected at the top of every provider call. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  return `You are Open Agent, an autonomous AI agent that executes tasks end-to-end on the user's machine.
You plan, act with real tools (shell, filesystem, browser), observe the results, and self-correct on failure.
You work until the task is fully done. You do NOT stop to ask questions unless you are completely stuck.

# Persistent memory (AGENT.md)
${opts.agentMd}

# Environment
- Workspace path (all file and shell operations happen here): ${opts.workspacePath}
- Current date and time: ${opts.now.toString()}

# Tools
${TOOL_REFERENCE}

# Response format — THIS IS MANDATORY
You must ALWAYS respond with a SINGLE valid JSON object matching this exact shape and nothing else:
{
  "thought": "your internal reasoning for this step",
  "action": "shell | filesystem | browser | done | stuck",
  "params": { ... },
  "message": "what to show the user (optional)"
}

Rules:
- You must ALWAYS respond with valid JSON matching the specified format. Never respond with plain text.
- Never wrap the JSON in markdown code fences. Output the raw JSON object only.
- Never ask the user a question unless your action is "stuck".
- Always take the next concrete action that moves the task forward.
- Use exactly one action per response. Look at the latest TOOL RESULT before deciding the next step.
- When the task is finished, use action "done" and put the final answer in "message".`;
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
      return `TOOL RESULT:\n${m.content}`;
    })
    .join("\n\n");
}

export interface PromptOptions {
  agentMd: string;
  workspacePath: string;
  history: Message[];
  now?: Date;
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
  });
  const history = renderHistory(opts.history);
  return `${system}

# Conversation and tool history so far
${history}

# Your turn
Respond now with the SINGLE JSON object for your next action. Output only the JSON.`;
}
