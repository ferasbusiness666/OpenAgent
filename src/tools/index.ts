import { ShellTool } from "./shell.js";
import type { ShellResult } from "./shell.js";
import { FilesystemTool } from "./filesystem.js";
import type { FilesystemOperation } from "./filesystem.js";
import { BrowserTool, isBrowserAvailable, BROWSER_UNAVAILABLE_MESSAGE } from "./browser.js";
import { getConnector } from "../connectors/index.js";

export { ShellTool } from "./shell.js";
export type { ShellResult } from "./shell.js";
export { FilesystemTool, PathTraversalError } from "./filesystem.js";
export type { FilesystemOperation } from "./filesystem.js";
export { BrowserTool, isBrowserAvailable, BROWSER_UNAVAILABLE_MESSAGE } from "./browser.js";

/** Validated parameter shape for the shell tool. */
export interface ShellParams {
  command: string;
}

/** Validated parameter shape for the filesystem tool. */
export interface FilesystemParams {
  operation: FilesystemOperation;
  path: string;
  content?: string;
}

/** Browser operations the registry can dispatch. */
export type BrowserOperation =
  | "navigate"
  | "click"
  | "type"
  | "screenshot"
  | "extractText"
  | "getHtml";

/** Validated parameter shape for the browser tool. */
export interface BrowserParams {
  operation: BrowserOperation;
  url?: string;
  selector?: string;
  text?: string;
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
}

const registry = new ToolRegistry();

/** GitHub operations the registry can dispatch. */
export type GitHubOperation = "listRepos" | "readFile" | "listIssues";

/** Validated parameter shape for the github tool. */
export interface GitHubParams {
  operation: GitHubOperation;
  repo?: string;
  path?: string;
}

/** Allowed tool names. */
const TOOL_NAMES = ["shell", "filesystem", "browser", "github"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

// ---- Param narrowing helpers (no `any`) ------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
];

function parseFilesystemParams(
  params: Record<string, unknown>,
): FilesystemParams | string {
  const operation = asString(params.operation);
  if (operation === null || !(FILESYSTEM_OPS as readonly string[]).includes(operation)) {
    return `filesystem requires "operation" to be one of: ${FILESYSTEM_OPS.join(", ")}.`;
  }
  const op = operation as FilesystemOperation;

  // "list" tolerates a missing/empty path (defaults to workspace root).
  const rawPath = asString(params.path);
  if (op !== "list" && (rawPath === null || rawPath.trim().length === 0)) {
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

  return { operation: op, path: fsPath };
}

const BROWSER_OPS: readonly BrowserOperation[] = [
  "navigate",
  "click",
  "type",
  "screenshot",
  "extractText",
  "getHtml",
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

  if (op === "navigate" && result.url === undefined) {
    return 'browser "navigate" requires a string "url" parameter.';
  }
  if ((op === "click" || op === "type") && result.selector === undefined) {
    return `browser "${op}" requires a string "selector" parameter.`;
  }
  if (op === "type" && result.text === undefined) {
    return 'browser "type" requires a string "text" parameter.';
  }
  return result;
}

const GITHUB_OPS: readonly GitHubOperation[] = [
  "listRepos",
  "readFile",
  "listIssues",
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

  if (op === "readFile") {
    if (repo === undefined || repo.trim().length === 0) {
      return 'github "readFile" requires a non-empty string "repo" parameter (format: owner/name).';
    }
    if (path === undefined || path.trim().length === 0) {
      return 'github "readFile" requires a non-empty string "path" parameter.';
    }
  }

  if (op === "listIssues") {
    if (repo === undefined || repo.trim().length === 0) {
      return 'github "listIssues" requires a non-empty string "repo" parameter (format: owner/name).';
    }
  }

  return { operation: op, repo, path };
}

// ---- Dispatch --------------------------------------------------------------

function formatShellResult(r: ShellResult): string {
  const lines: string[] = [`exitCode: ${r.exitCode}`];
  lines.push(`stdout:\n${r.stdout.length > 0 ? r.stdout : "(empty)"}`);
  lines.push(`stderr:\n${r.stderr.length > 0 ? r.stderr : "(empty)"}`);
  return lines.join("\n");
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
  }
}

/**
 * Execute a tool by name with arbitrary (untrusted) params. Validates and
 * narrows the params, dispatches to the matching tool, and translates any
 * thrown error into a structured failure result. Never throws.
 */
export async function executeTool(
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
      });
      let serialized = JSON.stringify(raw, null, 2);
      // Cap very long output to ~4000 chars to keep context manageable.
      if (serialized.length > 4000) {
        serialized = serialized.slice(0, 4000) + "\n... (output truncated)";
      }
      return { success: true, result: serialized };
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
