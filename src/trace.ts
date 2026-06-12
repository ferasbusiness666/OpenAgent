/**
 * trace.ts — structured, per-session observability spans (IMP-24).
 *
 * Answers the following post-run analysis questions:
 *   • Latency per provider call — which model invocations were slow?
 *   • Tokens per step — where did the token budget go across a multi-step plan?
 *   • Tool dominance — which tool (shell / browser / filesystem) consumed the
 *     most wall-clock time across a run?
 *   • State transitions — how long did the agent spend in each reasoning phase
 *     ("state.thinking", "state.planning", "state.correcting")?
 *   • Error hotspots — which spans ended with error:true most often?
 *
 * File format
 * ───────────
 * ~/.openagent/traces/<sessionId>.jsonl
 * One JSON object (TraceSpan) per line, appended synchronously.
 * JSONL is trivially grep-able, appendable without locking, and parseable by
 * standard tools (jq, Python json.loads, etc.).
 *
 * Performance contract
 * ─────────────────────
 * When OPENAGENT_NO_TRACE=1 the tracer becomes a no-op: startSpan returns a
 * dummy Span whose end() is a single boolean check, and event() returns
 * immediately.  No Date.now() calls, no allocations beyond the stack frame.
 *
 * Never throws
 * ────────────
 * Every file-I/O path is wrapped in try/catch.  An unwritable trace file must
 * never crash or stall an agent run.
 */

import fs from "fs-extra";
import path from "node:path";
import { TRACES_DIR, ensureDataDir } from "./paths.js";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * One completed span as written to the trace file.
 *
 * Fields are deliberately narrow (no nested objects) so the JSONL lines remain
 * trivially `jq`-filterable without a schema.
 */
export interface TraceSpan {
  /** ISO 8601 start timestamp, e.g. "2025-06-12T14:03:00.123Z". */
  ts: string;
  /**
   * Hierarchical dot-separated span name.
   * Conventions in this codebase:
   *   "provider.generate"  — one LLM round-trip
   *   "tool.shell"         — shell tool execution
   *   "tool.browser"       — browser tool operation
   *   "tool.filesystem"    — filesystem read/write/list
   *   "state.thinking"     — agent reasoning phase
   *   "state.planning"     — planner building system prompt
   *   "state.correcting"   — corrector retrying a failed step
   *   "session.total"      — whole-session wrapper
   */
  name: string;
  /** Wall-clock elapsed milliseconds, rounded to the nearest integer. */
  durMs: number;
  /**
   * Flat key→value attributes.  Suggested keys per span family:
   *   provider.*  → model (string), promptTokens (number), completionTokens (number)
   *   tool.*      → command/operation (string), exitCode (number), success (boolean)
   *   state.*     → stepIndex (number), retryCount (number)
   */
  attrs: Record<string, string | number | boolean>;
}

/**
 * A live (in-flight) span.  Call end() when the measured operation completes.
 * Safe to end() twice — the second call is a no-op.
 */
export interface Span {
  /**
   * Finalise the span and write it to the trace file.
   *
   * @param attrs  Extra attributes to merge in.  Keys provided here override
   *               keys given at startSpan() on conflict, allowing the caller to
   *               fill in information only available at completion time (e.g.
   *               exitCode, completionTokens, error).
   */
  end(attrs?: Record<string, string | number | boolean>): void;
}

// ── Internal constants ────────────────────────────────────────────────────────

/** Maximum length of any single string attribute value stored in a span. */
const MAX_ATTR_STRING_CHARS = 300;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Global on/off switch.  Returns false when the environment variable
 * OPENAGENT_NO_TRACE is set to the string "1", disabling all tracing.
 *
 * @returns  true if tracing is active (default), false if suppressed.
 */
export function tracingEnabled(): boolean {
  return process.env["OPENAGENT_NO_TRACE"] !== "1";
}

/**
 * Sanitise a raw session identifier so it is safe to use as a filename.
 *
 * Strips every character that is not alphanumeric, a dot, hyphen, or
 * underscore.  Falls back to the literal string "session" if the result is
 * empty, ensuring a valid filename is always produced.
 *
 * @param raw  Arbitrary session identifier (UUID, timestamp string, etc.).
 * @returns    Filename-safe string, never empty.
 */
function sanitizeSessionId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "session";
}

/**
 * Sanitise a flat attributes record before writing it to the trace file.
 *
 * Rules:
 *  1. Only string, number, and boolean values are kept; all others are dropped.
 *  2. String values longer than {@link MAX_ATTR_STRING_CHARS} are truncated
 *     with a `…` suffix (traces hold operation names/paths/counts — large
 *     payloads belong in the session file, not here).
 *
 * @param raw  Arbitrary flat record from the caller.
 * @returns    New record containing only sanitised scalar values.
 */
function sanitizeAttrs(
  raw: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (raw == null) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      out[k] =
        v.length > MAX_ATTR_STRING_CHARS ? v.slice(0, MAX_ATTR_STRING_CHARS) + "…" : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
    // All other types (object, null, undefined, symbol, bigint) are silently dropped.
  }
  return out;
}

// ── Tracer ────────────────────────────────────────────────────────────────────

/**
 * Per-session span logger.  One Tracer instance corresponds to one JSONL file
 * at `~/.openagent/traces/<sessionId>.jsonl`.
 *
 * Typical usage:
 * ```ts
 * const tracer = new Tracer(sessionId);
 *
 * // Wrap a provider call:
 * const span = tracer.startSpan("provider.generate", { model: "claude-sonnet-4-20250514" });
 * const result = await provider.generate(prompt);
 * span.end({ promptTokens: result.usage.input, completionTokens: result.usage.output });
 *
 * // Record an instantaneous event:
 * tracer.event("state.thinking", { stepIndex: 3 });
 * ```
 */
export class Tracer {
  private readonly _filePath: string;
  /** Tracks whether ensureDataDir() has been called at least once for this instance. */
  private _dirEnsured = false;

  constructor(sessionId: string) {
    const safeId = sanitizeSessionId(sessionId);
    this._filePath = path.join(TRACES_DIR, `${safeId}.jsonl`);
  }

  /** Absolute path of this tracer's JSONL file. */
  get filePath(): string {
    return this._filePath;
  }

  /**
   * Start timing a new span.
   *
   * @param name   Dot-separated span name (e.g. "tool.shell", "provider.generate").
   * @param attrs  Attributes known at span start.  May be supplemented or
   *               overridden when end() is called.
   * @returns      A {@link Span} whose end() method finalises the span.
   */
  startSpan(
    name: string,
    attrs?: Record<string, string | number | boolean>,
  ): Span {
    if (!tracingEnabled()) {
      // No-op span — allocates nothing measurable beyond this stack frame.
      return { end: () => undefined };
    }

    const startMs = Date.now();
    const startTs = new Date().toISOString();
    const startAttrs = sanitizeAttrs(attrs);
    let ended = false;

    const writeSpan = (endAttrs?: Record<string, string | number | boolean>): void => {
      const durMs = Math.round(Date.now() - startMs);
      const mergedAttrs: Record<string, string | number | boolean> = {
        ...startAttrs,
        ...sanitizeAttrs(endAttrs),
      };
      const span: TraceSpan = {
        ts: startTs,
        name,
        durMs,
        attrs: mergedAttrs,
      };
      this._append(span);
    };

    return {
      end(endAttrs?: Record<string, string | number | boolean>): void {
        if (ended) return; // idempotent — second call is a no-op
        ended = true;
        writeSpan(endAttrs);
      },
    };
  }

  /**
   * Write an instantaneous event span (durMs === 0).
   *
   * Useful for recording discrete state transitions or checkpoints that have no
   * meaningful duration (e.g. "agent received 'done' action", "session started").
   *
   * @param name   Span name.
   * @param attrs  Attributes to record with the event.
   */
  event(name: string, attrs?: Record<string, string | number | boolean>): void {
    if (!tracingEnabled()) return;

    const span: TraceSpan = {
      ts: new Date().toISOString(),
      name,
      durMs: 0,
      attrs: sanitizeAttrs(attrs),
    };
    this._append(span);
  }

  /**
   * Append one {@link TraceSpan} to the JSONL file.
   *
   * Ensures the traces directory exists on the first write, then appends
   * synchronously.  NEVER THROWS — any I/O failure is silently swallowed so a
   * bad trace file can never crash an agent run.
   */
  private _append(span: TraceSpan): void {
    try {
      if (!this._dirEnsured) {
        ensureDataDir();
        this._dirEnsured = true;
      }
      const line = JSON.stringify(span) + "\n";
      fs.appendFileSync(this._filePath, line, { encoding: "utf8" });
    } catch {
      // Silently swallow — a broken trace must never interrupt a run.
    }
  }
}

// ── Maintenance ───────────────────────────────────────────────────────────────

/**
 * Delete trace files older than `maxAgeDays` days from {@link TRACES_DIR}.
 *
 * Best-effort: any individual deletion failure is swallowed so a permissions
 * issue on one file cannot prevent the others from being pruned.  The function
 * itself never throws.
 *
 * Intended to be called once at agent startup (wired in by another module) to
 * prevent unbounded growth of the traces directory.
 *
 * @param maxAgeDays  Files whose mtime is older than this many days are deleted.
 *                    Defaults to 14.
 */
export function pruneOldTraces(maxAgeDays = 14): void {
  try {
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = fs.readdirSync(TRACES_DIR);
    } catch {
      // Traces directory may not yet exist — nothing to prune.
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(TRACES_DIR, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Best-effort: skip files we cannot stat or delete.
      }
    }
  } catch {
    // Top-level guard: pruneOldTraces must never throw under any circumstance.
  }
}
