import { spawn, spawnSync } from "node:child_process";
import type { Provider } from "./index.js";

/** Hard ceiling on a single CLI invocation, in milliseconds. */
const CALL_TIMEOUT_MS = 60_000;

/**
 * Discover the first installed ollama model by parsing `ollama list`. The
 * command prints a header row followed by one row per model; the model name is
 * the first whitespace-delimited token of the first data row. Falls back to
 * "llama3" if listing fails or no model is installed.
 */
function detectOllamaModel(): string {
  try {
    const result = spawnSync("ollama", ["list"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return "llama3";
    }
    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Drop the header row (starts with "NAME") if present.
    const dataLines = lines.filter((line) => !/^NAME\b/i.test(line));
    const first = dataLines[0];
    if (!first) {
      return "llama3";
    }
    const name = first.split(/\s+/)[0];
    return name && name.length > 0 ? name : "llama3";
  } catch {
    return "llama3";
  }
}

/**
 * Build the argv for a given CLI. The full prompt is passed as a discrete
 * argument (never interpolated into a shell string) so quoting and shell
 * metacharacters in the prompt cannot break the invocation or inject commands.
 */
function buildArgs(cli: string, prompt: string): string[] {
  switch (cli) {
    case "gemini":
      return ["-p", prompt];
    case "claude":
      return ["-p", prompt];
    case "codex":
      return [prompt];
    case "aider":
      return ["--message", prompt, "--no-auto-commits"];
    case "goose":
      return ["run", "--text", prompt];
    case "ollama":
      return ["run", detectOllamaModel(), prompt];
    default:
      // Unknown CLIs receive the prompt as a single positional argument — the
      // most common convention — rather than failing outright.
      return [prompt];
  }
}

/**
 * Drives a locally-installed AI CLI as a child process. Each turn the agent
 * loop hands over one fully-assembled prompt string and gets back the CLI's
 * stdout. Errors (nonzero exit, timeout, spawn failure) are returned as text
 * so the agent can read and reason about them rather than crashing the loop.
 */
export class CLIProvider implements Provider {
  private readonly cliName: string;

  constructor(cliName: string) {
    this.cliName = cliName;
  }

  get name(): string {
    return this.cliName;
  }

  complete(prompt: string): Promise<string> {
    const cli = this.cliName;
    const args = buildArgs(cli, prompt);

    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = (value: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      // `shell: true` on Windows so .cmd/.bat shims (how npm-installed CLIs are
      // exposed there) resolve correctly. Args remain a separate array.
      const child = spawn(cli, args, {
        shell: process.platform === "win32",
      });

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          `Error: "${cli}" timed out after ${CALL_TIMEOUT_MS / 1000}s.` +
            (stdout ? `\nPartial stdout:\n${stdout.trim()}` : "") +
            (stderr ? `\nPartial stderr:\n${stderr.trim()}` : "")
        );
      }, CALL_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        finish(`Error: failed to spawn "${cli}": ${err.message}`);
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) {
          finish(stdout.trim());
          return;
        }
        // Nonzero exit: surface everything the CLI emitted so the agent can
        // diagnose the failure instead of guessing.
        const combined = [
          `Error: "${cli}" exited with code ${code ?? "null"}.`,
          stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
          stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n");
        finish(combined);
      });
    });
  }
}
