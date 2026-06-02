import { spawn, spawnSync } from "node:child_process";
import type { Provider } from "./index.js";

/** Hard ceiling on a single CLI invocation, in milliseconds. */
const CALL_TIMEOUT_MS = 60_000;

// Matches ANSI/VT100 escape sequences (colors, cursor moves, etc.) so CLI
// output can be parsed as plain text/JSON. Control chars are intentional.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * The agent loop expects the model's reply to contain a JSON object matching
 * { thought, action, params, message }. Some CLIs (e.g. gemini) ignore that
 * instruction and print plain prose. If the cleaned output contains no JSON
 * object at all, wrap the whole text as a terminal "done" response so the loop
 * can surface it to the user instead of failing to parse. If it looks like it
 * contains JSON (has a "{" and a "}"), pass it through untouched and let the
 * loop's balanced-brace extractor handle it.
 */
function ensureJsonResponse(cleaned: string): string {
  if (cleaned.includes("{") && cleaned.includes("}")) {
    return cleaned;
  }
  const message = cleaned.length > 0 ? cleaned : "(the CLI returned no output)";
  return JSON.stringify({ thought: "", action: "done", params: {}, message });
}

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
 * When `model` is non-empty the per-CLI model flag is injected; otherwise the
 * CLI's own default model is used (ollama auto-detects an installed model).
 */
function buildArgs(cli: string, prompt: string, model: string): string[] {
  switch (cli) {
    case "gemini":
      return model ? ["-m", model, "-p", prompt] : ["-p", prompt];
    case "claude":
      return model ? ["--model", model, "-p", prompt] : ["-p", prompt];
    case "codex":
      // No stable model-selection flag — pass the prompt positionally.
      return [prompt];
    case "aider":
      return model
        ? ["--model", model, "--message", prompt, "--no-auto-commits"]
        : ["--message", prompt, "--no-auto-commits"];
    case "goose":
      return ["run", "--text", prompt];
    case "ollama":
      // An explicit model overrides the auto-detected first installed model.
      return ["run", model.trim() || detectOllamaModel(), prompt];
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
  private readonly model: string;

  constructor(cliName: string, model = "") {
    this.cliName = cliName;
    this.model = model;
  }

  get name(): string {
    return this.model ? `${this.cliName} (${this.model})` : this.cliName;
  }

  complete(prompt: string): Promise<string> {
    const cli = this.cliName;
    const args = buildArgs(cli, prompt, this.model);

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
        const outText = stripAnsi(stdout).trim();
        const errText = stripAnsi(stderr).trim();
        finish(
          `Error: "${cli}" timed out after ${CALL_TIMEOUT_MS / 1000}s.` +
            (outText ? `\nPartial stdout:\n${outText}` : "") +
            (errText ? `\nPartial stderr:\n${errText}` : "")
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
          // Clean ANSI escape codes (CLIs like gemini colorize output) before
          // parsing, then wrap plain prose so the agent loop never crashes on
          // a non-JSON reply.
          const cleaned = stripAnsi(stdout).trim();
          finish(ensureJsonResponse(cleaned));
          return;
        }
        // Nonzero exit: surface everything the CLI emitted (ANSI-stripped so it
        // is readable) so the agent's corrector can diagnose and retry instead
        // of guessing. Left as raw error text — not wrapped as a "done".
        const errText = stripAnsi(stderr).trim();
        const outText = stripAnsi(stdout).trim();
        const combined = [
          `Error: "${cli}" exited with code ${code ?? "null"}.`,
          errText ? `stderr:\n${errText}` : "",
          outText ? `stdout:\n${outText}` : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n");
        finish(combined);
      });
    });
  }
}
