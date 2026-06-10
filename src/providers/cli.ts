import { spawn, spawnSync } from "node:child_process";
import type { Provider } from "./index.js";
import type { GenerateRequest, GenerateResult, ChatMessage } from "./messages.js";
import { extractJsonObject } from "../util/json.js";

/** Hard ceiling on a single CLI invocation, in milliseconds. */
const CALL_TIMEOUT_MS = 60_000;

// ANSI/VT100 escape sequences (colors, cursor moves, etc.). Built from an
// escape-sequence string so the source file contains no literal control bytes.
const ANSI_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g",
);

// Stray C0/C1 control characters to drop, keeping tab/newline/carriage-return
// and dropping DEL. Built from a string literal so the source stays pure ASCII.
const CONTROL_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g",
);

/**
 * Strip ANSI escape sequences AND stray control characters (keeping tab,
 * newline, carriage return) so noisy terminal output parses cleanly as text/JSON.
 */
function cleanOutput(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/** Patterns that indicate the CLI needs the user to authenticate / log in. */
const AUTH_PATTERNS: RegExp[] = [
  /not logged in/i,
  /please (log[ -]?in|login|sign in|authenticate)/i,
  /requires? (authentication|login|sign[ -]?in)/i,
  /\bunauthorized\b/i,
  /\b401\b/,
  /invalid api key/i,
  /no api key/i,
  /api key (is )?(not set|missing|required)/i,
  /set [A-Z0-9_]*_API_KEY/i,
  /run .{0,40}(login|auth)/i,
  /authentication (failed|required|error)/i,
];

function looksLikeAuthError(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

/** Wrap arbitrary text as a terminal "done" response the agent loop can read. */
function wrapDone(message: string): string {
  return JSON.stringify({ thought: "", action: "done", params: {}, message });
}

/** Wrap a problem as a "stuck" response so the loop surfaces it and stops cleanly. */
function wrapStuck(message: string): string {
  return JSON.stringify({ thought: "", action: "stuck", params: {}, message });
}

/**
 * Discover the first installed ollama model by parsing `ollama list`. Falls back
 * to "llama3" if listing fails or no model is installed.
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

/** How to invoke one supported CLI non-interactively. */
interface CliInvocation {
  /** Build the argv for this CLI given the full prompt and (trimmed) model string.
   *  `model` is "" when none is configured; implementations must handle both cases.
   *  The prompt is always a discrete argv element — never shell-interpolated. */
  args: (prompt: string, model: string) => string[];
}

/**
 * Table-driven registry of known CLI invocations. Adding support for a new CLI
 * requires only a new record here — no branching logic elsewhere.
 */
const CLI_INVOCATIONS: Readonly<Record<string, CliInvocation>> = {
  gemini: {
    args: (prompt, model) => (model ? ["-p", prompt, "-m", model] : ["-p", prompt]),
  },
  claude: {
    args: (prompt, model) => (model ? ["-p", prompt, "--model", model] : ["-p", prompt]),
  },
  codex: {
    // Run non-interactively / unattended.
    args: (prompt, _model) => ["--full-auto", prompt],
  },
  aider: {
    args: (prompt, model) =>
      model
        ? ["--model", model, "--message", prompt, "--yes", "--no-auto-commits"]
        : ["--message", prompt, "--yes", "--no-auto-commits"],
  },
  goose: {
    args: (prompt, _model) => ["run", "--text", prompt],
  },
  ollama: {
    // An explicit model overrides the auto-detected first installed model.
    args: (prompt, model) => ["run", model || detectOllamaModel(), prompt],
  },
};

/**
 * Build the argv for a given CLI. The full prompt is passed as a discrete
 * argument (never interpolated into a shell string) so quoting and shell
 * metacharacters in the prompt cannot break the invocation or inject commands.
 * When `model` is non-empty the per-CLI model flag is injected.
 * Unknown CLIs receive the prompt as a single positional argument.
 */
function buildArgs(cli: string, prompt: string, model: string): string[] {
  const m = model.trim();
  return CLI_INVOCATIONS[cli]?.args(prompt, m) ?? [prompt];
}

/**
 * Drives a locally-installed AI CLI as a child process. Each turn the agent loop
 * hands over one fully-assembled prompt string and gets back a response the loop
 * can always parse: a JSON object extracted from the CLI's output, plain prose
 * wrapped as "done", or a "stuck" response describing a timeout/crash/auth issue.
 * Nothing here throws — every failure mode is converted into a readable result.
 */
export class CLIProvider implements Provider {
  readonly supportsVision = false;
  private readonly cliName: string;
  private readonly model: string;

  constructor(cliName: string, model = "") {
    this.cliName = cliName;
    this.model = model;
  }

  get name(): string {
    return this.model ? `${this.cliName} (${this.model})` : this.cliName;
  }

  private flatten(request: GenerateRequest): string {
    const parts: string[] = [request.system];
    for (const m of request.messages) {
      const label = m.role === "assistant" ? "ASSISTANT" : "USER";
      let content = m.content;
      if (Array.isArray(m.images) && m.images.length > 0) {
        content += "\n[screenshot attached — not visible in text-CLI mode]";
      }
      parts.push(`${label}:\n${content}`);
    }
    return parts.join("\n\n");
  }

  /**
   * CLI providers are text-only (no native function-calling): run the CLI and
   * return its text. The loop's text path parses the JSON action protocol from
   * it, exactly as before — so `toolCalls` is always empty here.
   */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const text = await this.runRaw(request);
    return { text, toolCalls: [] };
  }

  private runRaw(request: GenerateRequest): Promise<string> {
    const prompt = this.flatten(request);
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
        // Hard timeout: kill the process and return a clean "stuck" result rather
        // than letting a hung CLI block the loop.
        child.kill("SIGKILL");
        const partial = cleanOutput(stdout).trim();
        finish(
          wrapStuck(
            `The CLI "${cli}" timed out after ${CALL_TIMEOUT_MS / 1000}s and was terminated.` +
              (partial ? ` Partial output: ${partial.slice(0, 500)}` : ""),
          ),
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
        finish(
          wrapStuck(
            `Failed to start the CLI "${cli}": ${err.message}. ` +
              `Make sure it is installed and available on your PATH.`,
          ),
        );
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const out = cleanOutput(stdout).trim();
        const err = cleanOutput(stderr).trim();
        const combined = `${out}\n${err}`.trim();

        // Authentication problems can't be fixed mid-loop — tell the user how.
        if (looksLikeAuthError(combined)) {
          finish(
            wrapStuck(
              `This CLI requires authentication. Run ${cli} once manually to log in, ` +
                `then restart Open Agent.`,
            ),
          );
          return;
        }

        // If the output contains a JSON object anywhere, extract and use it.
        const json = extractJsonObject(out) ?? extractJsonObject(combined);
        if (json) {
          finish(json);
          return;
        }

        if (code === 0) {
          // Clean exit but plain prose — wrap it so the loop never crashes.
          finish(wrapDone(out.length > 0 ? out : "(the CLI returned no output)"));
          return;
        }

        // Non-zero exit with no output at all → treat as a crash.
        if (out.length === 0 && err.length === 0) {
          finish(
            wrapStuck(
              `The CLI "${cli}" exited with code ${code ?? "null"} and produced no output. ` +
                `It may have crashed — check that "${cli}" runs correctly.`,
            ),
          );
          return;
        }

        // Non-zero exit WITH output (but no JSON): surface it as readable error
        // text so the agent's corrector can diagnose and retry.
        finish(
          [
            `Error: "${cli}" exited with code ${code ?? "null"}.`,
            err ? `stderr:\n${err}` : "",
            out ? `stdout:\n${out}` : "",
          ]
            .filter((part) => part.length > 0)
            .join("\n"),
        );
      });
    });
  }
}
