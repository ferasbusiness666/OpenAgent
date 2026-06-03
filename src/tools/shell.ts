import { exec } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";
import { getConfig, resolveWorkspacePath } from "../config/index.js";

/** Result of running a shell command. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/**
 * Pick the shell binary to run commands through, by OS:
 *   Windows → %ComSpec% (cmd.exe).
 *   macOS/Linux → /bin/bash when present, otherwise /bin/sh.
 * Returning an explicit path keeps behavior predictable across platforms rather
 * than relying on exec's implicit default.
 */
function pickShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec && process.env.ComSpec.trim().length > 0
      ? process.env.ComSpec
      : "cmd.exe";
  }
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Fall through to the next candidate.
    }
  }
  return "/bin/sh";
}

/**
 * Patterns for catastrophic / system-destroying commands that must never run,
 * regardless of cwd. Matched case-insensitively against the raw command.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(?:\s|$|\*)/i, // rm -rf /  or  rm -rf /*
  /\brm\s+-fr\s+\/(?:\s|$|\*)/i, // rm -fr /  variant
  /\bformat\b/i, // format (windows disk format)
  /\bmkfs\b/i, // mkfs filesystem creation
  /:\s*\(\s*\)\s*\{/, // :(){  fork bomb
  /\bdd\s+if=/i, // raw disk writes
  />\s*\/dev\/sd[a-z]/i, // writing to raw block devices
];

/**
 * Detects whether a command references an absolute path or a parent-escape
 * that would target a location outside the workspace folder.
 *
 * We are deliberately conservative: any `..` token, any unix absolute path
 * (e.g. /etc, /usr), or any windows drive-letter absolute path (C:\ ...)
 * that does not resolve inside the workspace is rejected. This is a
 * defense-in-depth check on top of always running with cwd = workspace.
 */
function escapesWorkspace(command: string, workspace: string): boolean {
  // Any parent-directory traversal is rejected outright.
  if (/(^|[\s"'(/\\])\.\.([\s"'/\\)]|$)/.test(command)) {
    return true;
  }

  const normalizedWorkspace = path.resolve(workspace);

  // Unix absolute paths: a "/" not preceded by a word char (avoid matching
  // things like "https://" or "a/b"). We treat a leading-slash token as an
  // absolute path reference and check whether it stays inside the workspace.
  const unixAbsolute = command.match(/(?:^|[\s"'(=])(\/[^\s"')]*)/g);
  if (unixAbsolute) {
    for (const raw of unixAbsolute) {
      const candidate = raw.replace(/^[\s"'(=]+/, "");
      // Skip obvious URL fragments (e.g. "//host" from "http://host").
      if (candidate.startsWith("//")) {
        continue;
      }
      const resolved = path.resolve(candidate);
      if (!isInside(normalizedWorkspace, resolved)) {
        return true;
      }
    }
  }

  // Windows absolute paths: drive letter followed by ":\" or ":/".
  const winAbsolute = command.match(/[A-Za-z]:[\\/][^\s"')]*/g);
  if (winAbsolute) {
    for (const candidate of winAbsolute) {
      const resolved = path.resolve(candidate);
      if (!isInside(normalizedWorkspace, resolved)) {
        return true;
      }
    }
  }

  return false;
}

/** True when `target` is the workspace root or a path nested inside it. */
function isInside(workspace: string, target: string): boolean {
  const rel = path.relative(workspace, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Runs shell commands. The working directory is ALWAYS the configured
 * workspace folder, and commands that target locations outside it (or that
 * match known-destructive patterns) are blocked before execution.
 */
export class ShellTool {
  /**
   * Execute a command inside the workspace.
   *
   * @returns stdout/stderr/exitCode. Blocked commands return exitCode -1 with
   * an explanatory stderr rather than executing.
   */
  async run(command: string): Promise<ShellResult> {
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return { stdout: "", stderr: "Empty command.", exitCode: -1 };
    }

    const workspace = resolveWorkspacePath(getConfig());

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          stdout: "",
          stderr: `Blocked: command matches a forbidden destructive pattern (${pattern}).`,
          exitCode: -1,
        };
      }
    }

    if (escapesWorkspace(trimmed, workspace)) {
      return {
        stdout: "",
        stderr:
          "Blocked: command references a path outside the workspace folder. " +
          "All shell activity must stay within the workspace.",
        exitCode: -1,
      };
    }

    return await new Promise<ShellResult>((resolve) => {
      exec(
        trimmed,
        {
          cwd: workspace,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          shell: pickShell(),
        },
        (error, stdout, stderr) => {
          if (error) {
            // `error.code` is the process exit code when the process ran and
            // failed; at runtime it can also be a string (e.g. "ETIMEDOUT")
            // when spawning failed or the command timed out. We read it as
            // `unknown` so both shapes are handled without an `any`.
            const code: unknown = (error as { code?: unknown }).code;
            let exitCode: number;
            if (typeof code === "number") {
              exitCode = code;
            } else {
              exitCode = 1;
            }
            const extra =
              typeof code === "string" && code.length > 0
                ? `${stderr}${stderr ? "\n" : ""}[${code}] ${error.message}`
                : stderr;
            resolve({
              stdout: stdout ?? "",
              stderr: extra ?? error.message,
              exitCode,
            });
            return;
          }
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 });
        },
      );
    });
  }
}
