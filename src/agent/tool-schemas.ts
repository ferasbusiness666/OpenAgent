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
    description:
      "File operations relative to the workspace: read/write/list/delete/mkdir, plus grep (search file contents by regex), find (locate files by name glob), and diff (compare two files).",
    parameters: obj(
      {
        operation: {
          type: "string",
          enum: ["read", "write", "list", "delete", "mkdir", "grep", "find", "diff"],
        },
        path: str("workspace-relative path (grep/find: the directory or file to search, default the workspace root; diff: the FIRST file)"),
        content: str("file contents (write only)"),
        pattern: str("grep: the regex to search for; find: the file-name glob, e.g. *.ts"),
        pathB: str("diff: the SECOND file to compare against"),
        recursive: bool("grep/find: search subdirectories (default true)"),
        caseInsensitive: bool("grep: case-insensitive match (default false)"),
      },
      ["operation"],
    ),
  },
  {
    name: "http",
    description:
      "Make an HTTP request and return status + headers + body (JSON pretty-printed). Use this instead of curl. Private/internal network addresses are blocked.",
    parameters: obj(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        url: str("the absolute http(s) URL to request"),
        headers: { type: "object", description: "request headers", additionalProperties: { type: "string" } },
        body: str("request body (POST/PUT/PATCH); objects should be JSON-encoded"),
        timeoutMs: num("timeout in ms (default 30000)"),
      },
      ["url"],
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

/** The verdict "tool" used only by the verification pass before "done" (IMP-05). */
export const VERDICT_TOOL: ToolSchema = {
  name: "verdict",
  description:
    "Deliver your verification verdict: is the original goal genuinely, fully accomplished?",
  parameters: obj(
    {
      complete: bool("true only when the goal is fully accomplished"),
      reason: str("one short sentence justifying the verdict"),
      nextStep: str("if not complete: the single most important next action"),
    },
    ["complete", "reason"],
  ),
};

/**
 * Tools offered during the verification pass: the filesystem tool (the loop
 * permits only its read-only operations — read/list/grep/find/diff) plus the
 * verdict. Inspect, never mutate.
 */
export const VERIFY_TOOLS: readonly ToolSchema[] = [
  ...AGENT_TOOLS.filter((t) => t.name === "filesystem"),
  VERDICT_TOOL,
];
