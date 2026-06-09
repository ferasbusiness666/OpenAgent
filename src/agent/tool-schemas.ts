/**
 * tool-schemas.ts — the tools offered to the model via native function-calling.
 *
 * The planner attaches these to each main-loop request (`GenerateRequest.tools`)
 * so API providers expose them as real functions and return a STRUCTURED tool
 * call — eliminating the JSON-parse-from-text failure class. The names line up
 * 1:1 with the loop's actions: the real tools (shell/filesystem/browser/github/
 * research/code/memory/serve) plus the control actions (done/stuck/update_plan).
 *
 * `parameters` is plain JSON Schema; each provider maps it to its own shape
 * (Anthropic input_schema, OpenAI function.parameters, Gemini functionDeclarations).
 */

import type { ToolSchema } from "../providers/messages.js";

/** Convenience for a JSON-Schema object with the given properties. */
function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = (description: string): Record<string, unknown> => ({ type: "string", description });
const num = (description: string): Record<string, unknown> => ({ type: "number", description });
const bool = (description: string): Record<string, unknown> => ({ type: "boolean", description });

export const AGENT_TOOLS: readonly ToolSchema[] = [
  {
    name: "shell",
    description: "Run a shell command in the workspace directory. Requires user approval when enabled.",
    parameters: obj({ command: str("the command line to run") }, ["command"]),
  },
  {
    name: "filesystem",
    description: "Read/write/list/delete/mkdir files, relative to the workspace.",
    parameters: obj(
      {
        operation: { type: "string", enum: ["read", "write", "list", "delete", "mkdir"] },
        path: str("workspace-relative path"),
        content: str("file contents (write only)"),
      },
      ["operation", "path"],
    ),
  },
  {
    name: "browser",
    description: "Drive a headless Chromium browser for web tasks.",
    parameters: obj(
      {
        operation: {
          type: "string",
          enum: ["navigate", "click", "type", "screenshot", "extractText", "readText", "getHtml", "waitFor", "scroll", "press"],
        },
        url: str("URL (navigate)"),
        selector: str("CSS selector (click/type/waitFor)"),
        text: str("text to type (type)"),
        key: str("key to press, e.g. Enter (press)"),
        target: str("bottom|top|down|up (scroll)"),
        timeout: num("timeout in ms (waitFor)"),
      },
      ["operation"],
    ),
  },
  {
    name: "github",
    description: "GitHub access (needs GITHUB_TOKEN): repos, files, issues, and pull requests.",
    parameters: obj(
      {
        operation: {
          type: "string",
          enum: ["listRepos", "readFile", "listIssues", "createIssue", "commentIssue", "closeIssue", "listPullRequests", "getPullRequest", "createPullRequest"],
        },
        repo: str("owner/name"),
        path: str("file path (readFile)"),
        title: str("title (createIssue/createPullRequest)"),
        body: str("body text"),
        number: num("issue or PR number"),
        head: str("source branch (createPullRequest)"),
        base: str("target branch (createPullRequest)"),
        state: str("open|closed|all (listPullRequests)"),
      },
      ["operation"],
    ),
  },
  {
    name: "research",
    description: "Search the web (Tavily) and return a digest of the top results.",
    parameters: obj(
      {
        query: str("the search query"),
        maxResults: num("how many results (default 5)"),
        fetchPages: bool("also fetch the top pages' text"),
      },
      ["query"],
    ),
  },
  {
    name: "code",
    description: "Run code in a sandboxed worker. js runs in an isolated vm; python/node/bash/powershell run via the local interpreter (approval-gated).",
    parameters: obj(
      {
        language: { type: "string", enum: ["js", "python", "node", "bash", "powershell"] },
        code: str("the source to run"),
        tasks: { type: "array", items: { type: "string" }, description: "several JS snippets to run in parallel" },
        timeoutMs: num("timeout in ms"),
      },
      [],
    ),
  },
  {
    name: "memory",
    description: "Durable long-term memory: store a note or recall by keyword (BM25).",
    parameters: obj(
      {
        operation: { type: "string", enum: ["remember", "recall"] },
        content: str("text to store (remember)"),
        tags: { type: "array", items: { type: "string" } },
        query: str("search text (recall)"),
        topK: num("max hits (recall)"),
      },
      ["operation"],
    ),
  },
  {
    name: "serve",
    description: "Serve a workspace directory over HTTP on localhost and return the URL (local preview/deploy).",
    parameters: obj(
      {
        dir: str("workspace-relative directory to serve (default the workspace root)"),
        port: num("preferred port (a free one is chosen if omitted/taken)"),
      },
      [],
    ),
  },
  {
    name: "update_plan",
    description: "Report progress on the current plan: mark a phase in_progress/completed/failed with a short finding.",
    parameters: obj(
      {
        phase: num("the phase id"),
        status: { type: "string", enum: ["in_progress", "completed", "failed"] },
        finding: str("a short note about what happened"),
      },
      ["phase", "status"],
    ),
  },
  {
    name: "done",
    description: "The task is fully complete. Put the final answer to the user in 'message'.",
    parameters: obj({ message: str("the final answer to the user") }, []),
  },
  {
    name: "stuck",
    description: "You cannot proceed without the user. Explain what you need in 'message'.",
    parameters: obj({ message: str("what you need from the user") }, []),
  },
];
