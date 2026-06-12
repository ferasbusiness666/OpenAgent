import { spawn } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";
import { getConfig, resolveWorkspacePath } from "../config/index.js";
import { isInsidePath } from "../util/sandbox.js";

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
      if (!isInsidePath(normalizedWorkspace, resolved)) {
        return true;
      }
    }
  }

  // Windows absolute paths: drive letter followed by ":\" or ":/".
  const winAbsolute = command.match(/[A-Za-z]:[\\/][^\s"')]*/g);
  if (winAbsolute) {
    for (const candidate of winAbsolute) {
      const resolved = path.resolve(candidate);
      if (!isInsidePath(normalizedWorkspace, resolved)) {
        return true;
      }
    }
  }

  return false;
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
   * IMP-15: when `onChunk` is provided, stdout/stderr text is forwarded to it
   * incrementally as the command produces it (the UI shows a live preview);
   * the returned result is unchanged either way.
   *
   * @returns stdout/stderr/exitCode. Blocked commands return exitCode -1 with
   * an explanatory stderr rather than executing.
   */
  async run(command: string, onChunk?: (chunk: string) => void): Promise<ShellResult> {
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

    // spawn (not exec) so output can STREAM — exec buffers until exit. The
    // command still runs through the OS shell, exactly as before.
    return await new Promise<ShellResult>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let truncated = false;

      const finish = (result: ShellResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(trimmed, {
          cwd: workspace,
          windowsHide: true,
          shell: pickShell(),
        });
      } catch (err) {
        finish({
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        });
        return;
      }

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead — fine.
        }
        finish({
          stdout,
          stderr:
            `${stderr}${stderr ? "\n" : ""}[ETIMEDOUT] Command timed out after ${TIMEOUT_MS / 1000}s and was terminated.`,
          exitCode: 1,
        });
      }, TIMEOUT_MS);

      const append = (target: "out" | "err", chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        const current = target === "out" ? stdout : stderr;
        if (current.length + text.length > MAX_BUFFER) {
          if (!truncated) {
            truncated = true;
            const room = Math.max(0, MAX_BUFFER - current.length);
            const slice = text.slice(0, room) + "\n... (output truncated at 10 MB)";
            if (target === "out") stdout += slice;
            else stderr += slice;
          }
          return;
        }
        if (target === "out") stdout += text;
        else stderr += text;
        if (onChunk) {
          try {
            onChunk(text);
          } catch {
            // A streaming listener must never break the command itself.
          }
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        finish({ stdout, stderr: stderr || err.message, exitCode: 1 });
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        finish({ stdout, stderr, exitCode: typeof code === "number" ? code : 0 });
      });
    });
  }
}
