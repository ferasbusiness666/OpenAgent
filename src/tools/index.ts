import { ShellTool } from "./shell.js";
import type { ShellResult } from "./shell.js";
import { FilesystemTool } from "./filesystem.js";
import type { FilesystemOperation } from "./filesystem.js";
import { BrowserTool, isBrowserAvailable, BROWSER_UNAVAILABLE_MESSAGE } from "./browser.js";
import { CodeTool, SUPPORTED_LANGUAGES, type CodeLanguage } from "./code.js";
import { ServeTool } from "./serve.js";
import { HttpTool, type HttpMethod, type HttpRequestOptions } from "./http.js";
import { ResearchTool } from "./research.js";
import { LongTermMemory, type RecallHit } from "../memory/longterm.js";
import { getConnector } from "../connectors/index.js";
import { appendAuditEntry } from "../audit.js";

export { ShellTool } from "./shell.js";
export type { ShellResult } from "./shell.js";
export { FilesystemTool, PathTraversalError } from "./filesystem.js";
export type { FilesystemOperation } from "./filesystem.js";
export { BrowserTool, isBrowserAvailable, BROWSER_UNAVAILABLE_MESSAGE } from "./browser.js";
// Re-exported so the entry point can tear the worker pool down on exit.
export { closeWorkerPool } from "../workers/pool.js";
// Re-exported so the entry point can shut down any local preview servers.
export { closeAllServers } from "./serve.js";

/** Validated parameter shape for the shell tool. */
export interface ShellParams {
  command: string;
}

/** Validated parameter shape for the filesystem tool. */
export interface FilesystemParams {
  operation: FilesystemOperation;
  path: string;
  content?: string;
  /** grep: content regex; find: file-name glob (e.g. "*.ts"). */
  pattern?: string;
  /** diff: the second file to compare against. */
  pathB?: string;
  /** grep/find: descend into subdirectories (default true). */
  recursive?: boolean;
  /** grep: case-insensitive matching (default false). */
  caseInsensitive?: boolean;
}

/** Browser operations the registry can dispatch. */
export type BrowserOperation =
  | "navigate"
  | "click"
  | "type"
  | "screenshot"
  | "extractText"
  | "getHtml"
  | "waitFor"
  | "scroll"
  | "readText"
  | "press";

/** Validated parameter shape for the browser tool. */
export interface BrowserParams {
  operation: BrowserOperation;
  url?: string;
  selector?: string;
  text?: string;
  /** Key name for the "press" operation (e.g. "Enter", "Escape", "ArrowDown"). */
  key?: string;
  /** Scroll target for the "scroll" operation: "bottom" | "top" | "down" | "up". */
  target?: string;
  /** Timeout in milliseconds for the "waitFor" operation. */
  timeout?: number;
}

/** Uniform result returned for every tool invocation. */
export interface ToolResult {
  success: boolean;
  result: string;
  error?: string;
}

/**
 * Singleton tool instances, shared across the whole session so that (in
 * particular) the browser keeps one live Chromium instance.
 */
class ToolRegistry {
  readonly shell = new ShellTool();
  readonly filesystem = new FilesystemTool();
  readonly browser = new BrowserTool();
  readonly code = new CodeTool();
  readonly serve = new ServeTool();
  readonly http = new HttpTool();
  readonly research = new ResearchTool();
  readonly memory = new LongTermMemory();
}

const registry = new ToolRegistry();

/** GitHub operations the registry can dispatch. */
export type GitHubOperation =
  | "listRepos"
  | "readFile"
  | "listIssues"
  | "createIssue"
  | "commentIssue"
  | "closeIssue"
  | "listPullRequests"
  | "getPullRequest"
  | "createPullRequest";

/** Validated parameter shape for the github tool. */
export interface GitHubParams {
  operation: GitHubOperation;
  repo?: string;
  path?: string;
  title?: string;
  body?: string;
  number?: number;
  head?: string;
  base?: string;
  state?: string;
}

/** Allowed tool names. */
const TOOL_NAMES = [
  "shell",
  "filesystem",
  "browser",
  "github",
  "research",
  "code",
  "memory",
  "serve",
  "http",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

// ---- Param narrowing helpers (no `any`) ------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Coerce a number or numeric string to a finite number, else null. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

/** Coerce a value to a boolean, tolerating "true"/"false" strings. */
function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** Read a string array (e.g. tags) from an unknown value. */
function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : null;
}

function parseShellParams(params: Record<string, unknown>): ShellParams | string {
  const command = asString(params.command);
  if (command === null) {
    return 'shell requires a string "command" parameter.';
  }
  return { command };
}

const FILESYSTEM_OPS: readonly FilesystemOperation[] = [
  "read",
  "write",
  "list",
  "delete",
  "mkdir",
  "grep",
  "find",
  "diff",
];

/** Operations that tolerate a missing/empty path (default: workspace root). */
const FILESYSTEM_OPS_OPTIONAL_PATH: readonly FilesystemOperation[] = [
  "list",
  "grep",
  "find",
];

function parseFilesystemParams(
  params: Record<string, unknown>,
): FilesystemParams | string {
  const operation = asString(params.operation);
  if (operation === null || !(FILESYSTEM_OPS as readonly string[]).includes(operation)) {
    return `filesystem requires "operation" to be one of: ${FILESYSTEM_OPS.join(", ")}.`;
  }
  const op = operation as FilesystemOperation;

  const rawPath = asString(params.path);
  if (
    !(FILESYSTEM_OPS_OPTIONAL_PATH as readonly string[]).includes(op) &&
    (rawPath === null || rawPath.trim().length === 0)
  ) {
    return `filesystem "${op}" requires a non-empty string "path" parameter.`;
  }
  const fsPath = rawPath ?? "";

  if (op === "write") {
    const content = asString(params.content);
    if (content === null) {
      return 'filesystem "write" requires a string "content" parameter.';
    }
    return { operation: op, path: fsPath, content };
  }

  if (op === "grep" || op === "find") {
    const pattern = asString(params.pattern);
    if (pattern === null || pattern.trim().length === 0) {
      return op === "grep"
        ? 'filesystem "grep" requires a non-empty string "pattern" parameter (a regex to search file contents for).'
        : 'filesystem "find" requires a non-empty string "pattern" parameter (a file-name glob like "*.ts").';
    }
    const out: FilesystemParams = { operation: op, path: fsPath, pattern };
    const recursive = asBoolean(params.recursive);
    if (recursive !== null) out.recursive = recursive;
    const caseInsensitive = asBoolean(params.caseInsensitive);
    if (caseInsensitive !== null) out.caseInsensitive = caseInsensitive;
    return out;
  }

  if (op === "diff") {
    const pathB = asString(params.pathB);
    if (pathB === null || pathB.trim().length === 0) {
      return 'filesystem "diff" requires a non-empty string "pathB" parameter (the second file to compare).';
    }
    return { operation: op, path: fsPath, pathB };
  }

  return { operation: op, path: fsPath };
}

const BROWSER_OPS: readonly BrowserOperation[] = [
  "navigate",
  "click",
  "type",
  "screenshot",
  "extractText",
  "getHtml",
  "waitFor",
  "scroll",
  "readText",
  "press",
];

function parseBrowserParams(
  params: Record<string, unknown>,
): BrowserParams | string {
  const operation = asString(params.operation);
  if (operation === null || !(BROWSER_OPS as readonly string[]).includes(operation)) {
    return `browser requires "operation" to be one of: ${BROWSER_OPS.join(", ")}.`;
  }
  const op = operation as BrowserOperation;
  const result: BrowserParams = { operation: op };

  const url = asString(params.url);
  if (url !== null) result.url = url;
  const selector = asString(params.selector);
  if (selector !== null) result.selector = selector;
  const text = asString(params.text);
  if (text !== null) result.text = text;
  const key = asString(params.key);
  if (key !== null) result.key = key;
  const target = asString(params.target);
  if (target !== null) result.target = target;
  const timeout = asNumber(params.timeout);
  if (timeout !== null) result.timeout = timeout;

  if (op === "navigate" && result.url === undefined) {
    return 'browser "navigate" requires a string "url" parameter.';
  }
  if ((op === "click" || op === "type") && result.selector === undefined) {
    return `browser "${op}" requires a string "selector" parameter.`;
  }
  if (op === "type" && result.text === undefined) {
    return 'browser "type" requires a string "text" parameter.';
  }
  if (op === "waitFor" && result.selector === undefined) {
    return 'browser "waitFor" requires a string "selector" parameter.';
  }
  if (op === "press" && (result.key === undefined || result.key.trim().length === 0)) {
    return 'browser "press" requires a non-empty string "key" parameter.';
  }
  // "scroll" defaults target to "bottom" if omitted or unrecognised.
  if (op === "scroll") {
    const validScrollTargets = ["bottom", "top", "down", "up"] as const;
    if (
      result.target === undefined ||
      !(validScrollTargets as readonly string[]).includes(result.target)
    ) {
      result.target = "bottom";
    }
  }
  return result;
}

const GITHUB_OPS: readonly GitHubOperation[] = [
  "listRepos",
  "readFile",
  "listIssues",
  "createIssue",
  "commentIssue",
  "closeIssue",
  "listPullRequests",
  "getPullRequest",
  "createPullRequest",
];

/** Operations that need a non-empty owner/name "repo". */
const GITHUB_OPS_NEEDING_REPO: readonly GitHubOperation[] = [
  "readFile",
  "listIssues",
  "createIssue",
  "commentIssue",
  "closeIssue",
  "listPullRequests",
  "getPullRequest",
  "createPullRequest",
];

function parseGithubParams(
  params: Record<string, unknown>,
): GitHubParams | string {
  const operation = asString(params.operation);
  if (
    operation === null ||
    !(GITHUB_OPS as readonly string[]).includes(operation)
  ) {
    return `github requires "operation" to be one of: ${GITHUB_OPS.join(", ")}.`;
  }
  const op = operation as GitHubOperation;

  const repo = asString(params.repo) ?? undefined;
  const path = asString(params.path) ?? undefined;
  const title = asString(params.title) ?? undefined;
  const body = asString(params.body) ?? undefined;
  const head = asString(params.head) ?? undefined;
  const base = asString(params.base) ?? undefined;
  const state = asString(params.state) ?? undefined;
  const number = asNumber(params.number) ?? undefined;

  if (
    (GITHUB_OPS_NEEDING_REPO as readonly string[]).includes(op) &&
    (repo === undefined || repo.trim().length === 0)
  ) {
    return `github "${op}" requires a non-empty string "repo" parameter (format: owner/name).`;
  }

  if (op === "readFile" && (path === undefined || path.trim().length === 0)) {
    return 'github "readFile" requires a non-empty string "path" parameter.';
  }
  if (op === "createIssue" && (title === undefined || title.trim().length === 0)) {
    return 'github "createIssue" requires a non-empty string "title" parameter.';
  }
  if (op === "commentIssue") {
    if (number === undefined) {
      return 'github "commentIssue" requires a numeric "number" parameter (the issue number).';
    }
    if (body === undefined || body.trim().length === 0) {
      return 'github "commentIssue" requires a non-empty string "body" parameter.';
    }
  }
  if ((op === "closeIssue" || op === "getPullRequest") && number === undefined) {
    return `github "${op}" requires a numeric "number" parameter.`;
  }
  if (op === "createPullRequest") {
    if (title === undefined || title.trim().length === 0) {
      return 'github "createPullRequest" requires a non-empty string "title" parameter.';
    }
    if (head === undefined || head.trim().length === 0) {
      return 'github "createPullRequest" requires a non-empty string "head" parameter (the source branch).';
    }
    if (base === undefined || base.trim().length === 0) {
      return 'github "createPullRequest" requires a non-empty string "base" parameter (the target branch).';
    }
  }

  return { operation: op, repo, path, title, body, number, head, base, state };
}

// ---- research / code / memory params ---------------------------------------

/** Validated parameter shape for the research tool. */
export interface ResearchParams {
  query: string;
  maxResults?: number;
  fetchPages?: boolean;
}

function parseResearchParams(
  params: Record<string, unknown>,
): ResearchParams | string {
  const query = asString(params.query);
  if (query === null || query.trim().length === 0) {
    return 'research requires a non-empty string "query" parameter.';
  }
  const out: ResearchParams = { query };
  const maxResults = asNumber(params.maxResults);
  if (maxResults !== null) out.maxResults = Math.max(1, Math.min(10, Math.round(maxResults)));
  const fetchPages = asBoolean(params.fetchPages);
  if (fetchPages !== null) out.fetchPages = fetchPages;
  return out;
}

/** Validated parameter shape for the code tool. */
export interface CodeParams {
  language: CodeLanguage;
  code?: string;
  tasks?: string[];
  timeoutMs?: number;
}

function parseCodeParams(params: Record<string, unknown>): CodeParams | string {
  const code = asString(params.code) ?? undefined;
  const tasks = asStringArray(params.tasks) ?? undefined;
  if (code === undefined && tasks === undefined) {
    return 'code requires a string "code" parameter, or a "tasks" array of JS snippets to run in parallel.';
  }
  const rawLang = asString(params.language);
  if (rawLang !== null && !(SUPPORTED_LANGUAGES as readonly string[]).includes(rawLang)) {
    return `code "language" must be one of: ${SUPPORTED_LANGUAGES.join(", ")}.`;
  }
  const language = (rawLang ?? "js") as CodeLanguage;
  const out: CodeParams = { language };
  if (code !== undefined) out.code = code;
  if (tasks !== undefined) out.tasks = tasks;
  const timeoutMs = asNumber(params.timeoutMs);
  if (timeoutMs !== null) out.timeoutMs = Math.max(50, Math.round(timeoutMs));
  return out;
}

/** Validated parameter shape for the serve tool. */
export interface ServeParams {
  dir?: string;
  port?: number;
}

function parseServeParams(params: Record<string, unknown>): ServeParams | string {
  const out: ServeParams = {};
  const dir = asString(params.dir);
  if (dir !== null && dir.trim().length > 0) out.dir = dir;
  const port = asNumber(params.port);
  if (port !== null) out.port = Math.max(1, Math.min(65535, Math.round(port)));
  return out;
}

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/** Read a string→string header map from an unknown value (non-strings dropped). */
function asHeaderMap(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseHttpParams(params: Record<string, unknown>): HttpRequestOptions | string {
  const url = asString(params.url);
  if (url === null || url.trim().length === 0) {
    return 'http requires a non-empty string "url" parameter.';
  }
  const out: HttpRequestOptions = { url: url.trim() };

  const rawMethod = asString(params.method);
  if (rawMethod !== null) {
    const method = rawMethod.toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      return `http "method" must be one of: ${HTTP_METHODS.join(", ")}.`;
    }
    out.method = method as HttpMethod;
  }
  const headers = asHeaderMap(params.headers);
  if (headers !== null) out.headers = headers;
  const body = asString(params.body);
  if (body !== null) out.body = body;
  const timeoutMs = asNumber(params.timeoutMs);
  if (timeoutMs !== null) out.timeoutMs = timeoutMs;
  return out;
}

/** Validated parameter shape for the memory tool. */
export interface MemoryParams {
  operation: "remember" | "recall";
  content?: string;
  query?: string;
  tags?: string[];
  topK?: number;
}

function parseMemoryParams(params: Record<string, unknown>): MemoryParams | string {
  const operation = asString(params.operation);
  if (operation !== "remember" && operation !== "recall") {
    return 'memory requires "operation" to be "remember" or "recall".';
  }
  if (operation === "remember") {
    const content = asString(params.content);
    if (content === null || content.trim().length === 0) {
      return 'memory "remember" requires a non-empty string "content" parameter.';
    }
    const out: MemoryParams = { operation, content };
    const tags = asStringArray(params.tags);
    if (tags !== null) out.tags = tags;
    return out;
  }
  const query = asString(params.query);
  if (query === null || query.trim().length === 0) {
    return 'memory "recall" requires a non-empty string "query" parameter.';
  }
  const out: MemoryParams = { operation, query };
  const topK = asNumber(params.topK);
  if (topK !== null) out.topK = Math.max(1, Math.min(20, Math.round(topK)));
  return out;
}

// ---- Dispatch --------------------------------------------------------------

function formatShellResult(r: ShellResult): string {
  const lines: string[] = [`exitCode: ${r.exitCode}`];
  lines.push(`stdout:\n${r.stdout.length > 0 ? r.stdout : "(empty)"}`);
  lines.push(`stderr:\n${r.stderr.length > 0 ? r.stderr : "(empty)"}`);
  return lines.join("\n");
}

/** Render BM25 recall hits into a compact, model-readable summary. */
function formatRecallHits(query: string, hits: RecallHit[]): string {
  if (hits.length === 0) {
    return `No stored memories matched "${query}".`;
  }
  const lines = hits.map(
    (h, i) =>
      `${i + 1}. (score ${h.score.toFixed(2)}${h.tags.length > 0 ? `, tags: ${h.tags.join(", ")}` : ""}) ${h.excerpt}`,
  );
  return [`Top ${hits.length} memory match(es) for "${query}":`, ...lines].join("\n");
}

async function dispatchBrowser(p: BrowserParams): Promise<string> {
  const b = registry.browser;
  switch (p.operation) {
    case "navigate":
      // url presence guaranteed by parseBrowserParams.
      return await b.navigate(p.url as string);
    case "click":
      return await b.click(p.selector as string);
    case "type":
      return await b.type(p.selector as string, p.text as string);
    case "screenshot":
      return await b.screenshot();
    case "extractText":
      return await b.extractText();
    case "getHtml":
      return await b.getHtml();
    case "waitFor":
      // selector presence guaranteed by parseBrowserParams.
      return await b.waitFor(p.selector as string, p.timeout);
    case "scroll":
      // target is always set (defaulted to "bottom") by parseBrowserParams.
      return await b.scroll(p.target as string);
    case "readText":
      return await b.readText();
    case "press":
      // key presence guaranteed by parseBrowserParams.
      return await b.press(p.key as string);
  }
}

async function dispatchFilesystem(p: FilesystemParams): Promise<string> {
  const f = registry.filesystem;
  switch (p.operation) {
    case "read":
      return await f.read(p.path);
    case "write":
      return await f.write(p.path, p.content ?? "");
    case "list":
      return await f.list(p.path);
    case "delete":
      return await f.delete(p.path);
    case "mkdir":
      return await f.mkdir(p.path);
    case "grep":
      // pattern presence guaranteed by parseFilesystemParams.
      return await f.grep(p.pattern ?? "", p.path, p.recursive ?? true, p.caseInsensitive ?? false);
    case "find":
      return await f.find(p.pattern ?? "", p.path, p.recursive ?? true);
    case "diff":
      // pathB presence guaranteed by parseFilesystemParams.
      return await f.diff(p.path, p.pathB ?? "");
  }
}

/**
 * Execute a tool by name with arbitrary (untrusted) params. Validates and
 * narrows the params, dispatches to the matching tool, and translates any
 * thrown error into a structured failure result. Never throws.
 *
 * Every invocation is appended to the persistent audit log (~/.openagent/
 * audit.log, JSONL) with sanitized params — operation type and path/command
 * only, never file contents or secrets — so the user can review exactly what
 * the agent did after any run.
 */
export async function executeTool(
  name: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const safeParams = params !== null && typeof params === "object" ? params : {};
  const result = await executeToolInner(name, safeParams);
  appendAuditEntry(
    name,
    safeParams,
    result.success,
    result.success ? result.result : result.error ?? "Unknown error",
  );
  return result;
}

async function executeToolInner(
  name: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if (!isToolName(name)) {
      return {
        success: false,
        result: "",
        error: `Unknown tool "${name}". Valid tools: ${TOOL_NAMES.join(", ")}.`,
      };
    }

    const safeParams =
      params !== null && typeof params === "object" ? params : {};

    if (name === "shell") {
      const parsed = parseShellParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      const r = await registry.shell.run(parsed.command);
      return { success: true, result: formatShellResult(r) };
    }

    if (name === "filesystem") {
      const parsed = parseFilesystemParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      const result = await dispatchFilesystem(parsed);
      return { success: true, result };
    }

    if (name === "github") {
      const parsed = parseGithubParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      const connector = getConnector("github");
      if (connector === undefined) {
        return {
          success: false,
          result: "",
          error: 'GitHub connector is not registered.',
        };
      }
      const raw = await connector.executeAction(parsed.operation, {
        repo: parsed.repo,
        path: parsed.path,
        title: parsed.title,
        body: parsed.body,
        number: parsed.number,
        head: parsed.head,
        base: parsed.base,
        state: parsed.state,
      });
      let serialized = JSON.stringify(raw, null, 2);
      // Cap very long output to ~4000 chars to keep context manageable.
      if (serialized.length > 4000) {
        serialized = serialized.slice(0, 4000) + "\n... (output truncated)";
      }
      return { success: true, result: serialized };
    }

    if (name === "research") {
      const parsed = parseResearchParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      const options: { maxResults?: number; fetchPages?: boolean } = {};
      if (parsed.maxResults !== undefined) options.maxResults = parsed.maxResults;
      if (parsed.fetchPages !== undefined) options.fetchPages = parsed.fetchPages;
      const result = await registry.research.research(parsed.query, options);
      return { success: true, result };
    }

    if (name === "code") {
      const parsed = parseCodeParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      const result =
        parsed.tasks !== undefined && parsed.tasks.length > 0
          ? await registry.code.runMany(parsed.tasks, parsed.timeoutMs)
          : await registry.code.run(parsed.language, parsed.code ?? "", parsed.timeoutMs);
      return { success: true, result };
    }

    if (name === "serve") {
      const parsed = parseServeParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      const result = await registry.serve.serve(parsed.dir, parsed.port);
      return { success: true, result };
    }

    if (name === "http") {
      const parsed = parseHttpParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      const result = await registry.http.request(parsed);
      return { success: true, result };
    }

    if (name === "memory") {
      const parsed = parseMemoryParams(safeParams);
      if (typeof parsed === "string") {
        return { success: false, result: "", error: parsed };
      }
      if (parsed.operation === "remember") {
        const saved = registry.memory.remember(parsed.content ?? "", parsed.tags);
        return { success: true, result: `Remembered (id ${saved.id}).` };
      }
      const hits = registry.memory.recall(parsed.query ?? "", parsed.topK);
      return { success: true, result: formatRecallHits(parsed.query ?? "", hits) };
    }

    // name === "browser"
    if (!isBrowserAvailable()) {
      return { success: false, result: "", error: BROWSER_UNAVAILABLE_MESSAGE };
    }
    const parsed = parseBrowserParams(safeParams);
    if (typeof parsed === "string") {
      return { success: false, result: "", error: parsed };
    }
    const result = await dispatchBrowser(parsed);
    return { success: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, result: "", error: message };
  }
}

export { executeTool as executetool };

/** Cleanly shut down the shared browser instance. */
export async function closeBrowser(): Promise<void> {
  await registry.browser.close();
}

/** Cleanly shut down the research tool's browser instance. */
export async function closeResearch(): Promise<void> {
  await registry.research.close();
}
