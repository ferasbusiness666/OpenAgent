import { spawnSync } from "node:child_process";
import { getWorkerPool } from "../workers/pool.js";
import { getActiveWorkspace } from "../config/index.js";

/** Languages the CodeTool can execute. "js" uses the in-thread vm sandbox. */
export type CodeLanguage = "js" | "python" | "node" | "bash" | "powershell";

/** All languages the tool supports, in a stable order. */
export const SUPPORTED_LANGUAGES: readonly CodeLanguage[] = [
  "js",
  "python",
  "node",
  "bash",
  "powershell",
];

/** Availability of a single language's interpreter on the host. */
export interface RuntimeInfo {
  language: CodeLanguage;
  command: string;
  available: boolean;
}

/**
 * CodeTool — a multi-language code-execution tool backed by the {@link WorkerPool}.
 *
 * JavaScript snippets run inside worker threads (isolated-vm when explicitly
 * opted in, Node's `vm` as the default), keeping evaluation off the main thread
 * and bounded by per-job memory + time limits. Python/Node/Bash/PowerShell run
 * through the same pool via a local interpreter ("exec" jobs), inheriting the
 * pool's timeout + force-kill + parallelism, with the working directory set to
 * the agent's workspace. `runMany` fans JS snippets out across the pool in
 * parallel to exercise the multi-worker engine from a single call.
 */
export class CodeTool {
  /**
   * Run a code snippet in the given language. "js" delegates to the in-thread
   * vm sandbox via {@link runJs}; every other language runs through the worker
   * pool as an "exec" job (local interpreter, workspace cwd, pool timeout).
   * @throws if execution fails, so the agent loop can self-correct.
   * @returns the combined stdout+stderr, or "(no output)" when nothing printed.
   */
  async run(
    language: CodeLanguage,
    code: string,
    timeoutMs?: number,
  ): Promise<string> {
    if (language === "js") {
      return this.runJs(code, timeoutMs);
    }
    const r = await getWorkerPool().run({
      kind: "exec",
      language,
      source: code,
      cwd: getActiveWorkspace(),
      timeoutMs,
    });
    if (!r.success) {
      throw new Error(r.error ?? `${language} execution failed`);
    }
    return r.output.trim().length > 0 ? r.output : "(no output)";
  }

  /**
   * Evaluate a single JavaScript snippet in a sandboxed worker.
   * @throws if execution fails (so callers / the agent loop can self-correct).
   * @returns `[engine] output`, or `[engine] (no output)` when nothing printed.
   */
  async runJs(code: string, timeoutMs?: number): Promise<string> {
    const r = await getWorkerPool().run({ kind: "js", source: code, timeoutMs });
    if (!r.success) {
      throw new Error(r.error ?? "code execution failed");
    }
    const engine = r.engine ?? "vm";
    const output = r.output.trim();
    return `[${engine}] ${output.length > 0 ? output : "(no output)"}`;
  }

  /**
   * Evaluate several JavaScript snippets in parallel across the worker pool,
   * returning a numbered summary (one line per snippet). Never throws — each
   * snippet's success/failure is reported inline so a partial batch still
   * produces a useful result.
   */
  async runMany(snippets: string[], timeoutMs?: number): Promise<string> {
    if (snippets.length === 0) return "(no snippets)";

    const pool = getWorkerPool();
    const results = await Promise.all(
      snippets.map((s) => pool.run({ kind: "js", source: s, timeoutMs })),
    );

    const lines = results.map((r, i) => {
      const n = i + 1;
      if (r.success) {
        const first = firstLine(r.output) || "(no output)";
        return `${n}. ✓ [${r.engine ?? "vm"}] ${first}`;
      }
      const first = firstLine(r.error ?? r.output) || "execution failed";
      return `${n}. ✗ [${r.engine ?? "vm"}] ${first}`;
    });

    return lines.join("\n");
  }

  /**
   * Probe each supported language's primary interpreter on this host. "js" is
   * always available (it runs in-process via the vm sandbox; command "vm").
   * Each non-js language is probed with a quick, side-effect-free version check
   * matching the same primary command the worker's interpreter map picks per
   * platform. Synchronous and never throws — each probe is individually guarded.
   */
  detectRuntimes(): RuntimeInfo[] {
    const isWin = process.platform === "win32";
    return SUPPORTED_LANGUAGES.map((language): RuntimeInfo => {
      if (language === "js") {
        return { language, command: "vm", available: true };
      }

      let command: string;
      let probeArgs: string[];
      switch (language) {
        case "python":
          command = isWin ? "python" : "python3";
          probeArgs = ["--version"];
          break;
        case "node":
          command = "node";
          probeArgs = ["--version"];
          break;
        case "bash":
          command = "bash";
          probeArgs = ["--version"];
          break;
        case "powershell":
          command = isWin ? "powershell" : "pwsh";
          probeArgs = ["-NoProfile", "-Command", "$PSVersionTable"];
          break;
      }

      let available = false;
      try {
        const probe = spawnSync(command, probeArgs, {
          stdio: "ignore",
          windowsHide: true,
          timeout: 4000,
        });
        available = probe.status === 0;
      } catch {
        available = false;
      }
      return { language, command, available };
    });
  }
}

/** First non-empty line of a string, trimmed. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return text.trim();
}
