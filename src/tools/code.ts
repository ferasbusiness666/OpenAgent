import { getWorkerPool } from "../workers/pool.js";

/**
 * CodeTool — a sandboxed code-execution tool backed by the {@link WorkerPool}.
 *
 * JavaScript snippets run inside worker threads (isolated-vm when available,
 * Node's `vm` as a fallback), keeping evaluation off the main thread and
 * bounded by per-job memory + time limits. `runMany` fans snippets out across
 * the pool in parallel to exercise the multi-worker engine from a single call.
 */
export class CodeTool {
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
}

/** First non-empty line of a string, trimmed. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return text.trim();
}
