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
import { loadPlugins, renderPluginList } from "../plugins/index.js";

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
    description:
      "Drive a headless Chromium browser: navigation/clicking/typing, cookies (login sessions), JS injection, session-aware downloads, and a recent-network log.",
    parameters: obj(
      {
        operation: {
          type: "string",
          enum: [
            "navigate", "click", "type", "screenshot", "extractText", "readText", "getHtml",
            "waitFor", "scroll", "press", "setCookies", "getCookies", "injectJs", "download", "network",
          ],
        },
        url: str("URL (navigate/download)"),
        selector: str("CSS selector (click/type/waitFor)"),
        text: str("text to type (type)"),
        key: str("key to press, e.g. Enter (press)"),
        target: str("bottom|top|down|up (scroll)"),
        timeout: num("timeout in ms (waitFor)"),
        cookies: str("JSON array of cookie objects (setCookies)"),
        script: str("JavaScript to evaluate in the page; its value is returned (injectJs)"),
        path: str("workspace-relative save path (download)"),
        filter: str("URL substring/regex filter (network)"),
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
    description:
      "Run code in a sandboxed worker (js = isolated vm; python/node/bash/powershell via local interpreters, approval-gated), install dependencies (operation installDeps), or run a test suite (operation runTests — pytest/jest/mocha/vitest/go).",
    parameters: obj(
      {
        operation: { type: "string", enum: ["run", "installDeps", "runTests"], description: "default run" },
        language: { type: "string", enum: ["js", "python", "node", "bash", "powershell"] },
        code: str("the source to run (run)"),
        tasks: { type: "array", items: { type: "string" }, description: "several JS snippets to run in parallel" },
        packageManager: { type: "string", enum: ["npm", "pip"], description: "installDeps" },
        packages: { type: "array", items: { type: "string" }, description: "package names (installDeps)" },
        framework: { type: "string", enum: ["pytest", "jest", "mocha", "vitest", "go"], description: "runTests" },
        path: str("test file/dir (runTests, optional)"),
        timeoutMs: num("timeout in ms"),
      },
      [],
    ),
  },
  {
    name: "plugin",
    description:
      "Run an installed user plugin inside the JS sandbox (pure compute — no filesystem/network). Installed plugins:\n" +
      renderPluginList(loadPlugins().plugins),
    parameters: obj(
      {
        name: str("the plugin's name"),
        params: { type: "object", description: "arguments matching the plugin's schema" },
      },
      ["name"],
    ),
  },
  {
    name: "memory",
    description:
      "Durable long-term memory: store a note or recall by MEANING (semantic + keyword hybrid search).",
    parameters: obj(
      {
        operation: { type: "string", enum: ["remember", "recall"] },
        content: str("text to store (remember)"),
        tags: { type: "array", items: { type: "string" } },
        importance: num("how important this note is, 1-10 (remember; default 5)"),
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
    name: "note",
    description:
      "Record durable task state in working memory (shown back to you every turn): facts discovered, constraints that must hold, or named variables resolved (ids, paths, URLs). Use it for things you must not forget mid-task.",
    parameters: obj(
      {
        facts: { type: "array", items: { type: "string" }, description: "facts discovered" },
        constraints: { type: "array", items: { type: "string" }, description: "constraints that must hold" },
        variables: {
          type: "object",
          description: "named values resolved, e.g. {\"port\": \"3000\"}",
          additionalProperties: { type: "string" },
        },
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
