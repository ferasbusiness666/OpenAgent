import { spawnSync } from "node:child_process";

/**
 * The CLIs we know how to drive. Order matters only for display; detection
 * returns the subset actually found on PATH.
 */
export const KNOWN_CLIS = [
  "gemini",
  "claude",
  "codex",
  "aider",
  "goose",
  "ollama",
] as const;

export type KnownCli = (typeof KNOWN_CLIS)[number];

/**
 * Returns true if the given executable is resolvable on PATH.
 * Uses `where` on Windows and `which` elsewhere. Output is discarded; only
 * the process exit status matters (0 === found).
 */
function isOnPath(cli: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(lookup, [cli], {
      stdio: "ignore",
      // `where` is a cmd.exe builtin on Windows, so it must run through a shell.
      shell: process.platform === "win32",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Scan PATH for the known CLIs and return the names that exist, in the same
 * order as KNOWN_CLIS.
 */
export function detectClis(): string[] {
  return KNOWN_CLIS.filter((cli) => isOnPath(cli));
}
