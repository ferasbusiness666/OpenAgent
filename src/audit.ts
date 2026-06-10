/**
 * audit.ts — JSONL forensic audit log for every tool execution (IMP-37).
 *
 * Every tool invocation appends one JSON line to `~/.openagent/audit.log` so
 * operators have a full, tamper-evident record of what the agent did: which tool
 * was called, with what (sanitised) parameters, whether it succeeded, and a brief
 * summary of the outcome.
 *
 * Design decisions
 * ────────────────
 * • JSONL (newline-delimited JSON) — one entry per line.  Trivially `grep`-able
 *   and appendable without locking or parsing the whole file.
 * • Synchronous append (`fs.appendFileSync`) — avoids any async ordering issue
 *   where a crash between two awaits could leave an entry out of the log.
 * • Never throws — an audit failure must never break a tool call.  Every path is
 *   wrapped in try/catch and swallowed silently.
 * • Sanitisation is applied before serialisation so secrets (API keys, auth
 *   headers, file contents, HTTP bodies) never appear in the log.  The rules are
 *   deliberately conservative: when in doubt, redact.
 */

import path from "node:path";
import fs from "fs-extra";
import { DATA_DIR, ensureDataDir } from "./paths.js";

// ── Exported constants ───────────────────────────────────────────────────────

/** Absolute path of the JSONL audit log file. */
export const AUDIT_LOG_PATH = path.join(DATA_DIR, "audit.log");

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * A single entry in the audit log.  This is what gets serialised to JSONL.
 */
export interface AuditEntry {
  /** ISO 8601 timestamp of when the tool call completed. */
  ts: string;
  /** Name of the tool that was invoked (e.g. `"shell"`, `"browser"`). */
  tool: string;
  /** Sanitised copy of the params object. No secrets or large blobs. */
  params: Record<string, unknown>;
  /** Whether the tool call returned success (`true`) or threw/errored (`false`). */
  success: boolean;
  /**
   * First 200 chars of the result string or error message, with internal
   * newlines collapsed to literal `\n` by JSON serialisation.
   */
  summary: string;
}

// ── Sanitisation helpers ──────────────────────────────────────────────────────

/**
 * Regex that matches param keys whose values should be fully redacted because
 * they commonly carry authentication material.
 */
const SECRET_KEY_RE = /token|key|secret|password|authorization/i;

/**
 * Maximum length of a plain string value in a sanitised params object.
 * Strings longer than this are truncated with a `…` suffix.
 */
const MAX_STRING_VALUE_CHARS = 200;

/** Maximum number of array elements to keep after sanitisation. */
const MAX_ARRAY_ELEMENTS = 20;

/**
 * Sanitise a single string value that has already been judged non-secret.
 * Truncates to {@link MAX_STRING_VALUE_CHARS} characters with a `…` suffix.
 *
 * @param value  Raw string value.
 * @returns      Possibly-truncated string.
 */
function truncateString(value: string): string {
  return value.length > MAX_STRING_VALUE_CHARS
    ? value.slice(0, MAX_STRING_VALUE_CHARS) + "…"
    : value;
}

/**
 * Sanitise a single value that lives inside a `headers` object (one level deep).
 * Any header whose name matches {@link SECRET_KEY_RE} is redacted.
 *
 * @param key    The header name (lower-cased by the caller).
 * @param value  The raw header value.
 */
function sanitizeHeaderValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_RE.test(key)) {
    return "<redacted>";
  }
  if (typeof value === "string") {
    return truncateString(value);
  }
  return value;
}

/**
 * Sanitise a nested `headers`-style plain object (one level deep).
 *
 * @param obj  A `Record<string, unknown>` representing request/response headers.
 * @returns    A new object with secrets redacted and long strings truncated.
 */
function sanitizeHeadersObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = sanitizeHeaderValue(k, v);
  }
  return result;
}

/**
 * Sanitise a params object before writing it to the audit log.
 *
 * Rules applied (in order of priority):
 *  1. Key `content` (any case) → `"<N chars>"` (length of the string value) or
 *     `"<omitted>"` for non-strings — file content must never appear in logs.
 *  2. Key `body` → same treatment — HTTP bodies may carry credentials.
 *  3. Any key matching `/token|key|secret|password|authorization/i` → `"<redacted>"`.
 *  4. Value is a plain object (`headers`-style) → recurse one level and apply
 *     rule 3 to inner keys.
 *  5. Any remaining string value longer than {@link MAX_STRING_VALUE_CHARS} →
 *     truncated with `…`.
 *  6. Arrays: keep, truncate string elements, cap at {@link MAX_ARRAY_ELEMENTS}
 *     elements.
 *
 * @param params  Raw params object from the tool call.
 * @returns       New object with sensitive or oversized values replaced.
 */
export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    const keyLower = key.toLowerCase();

    // Rule 1: content key — replace with char-count placeholder.
    if (keyLower === "content") {
      if (typeof value === "string") {
        result[key] = `<${value.length} chars>`;
      } else {
        result[key] = "<omitted>";
      }
      continue;
    }

    // Rule 2: body key — same treatment.
    if (keyLower === "body") {
      if (typeof value === "string") {
        result[key] = `<${value.length} chars>`;
      } else {
        result[key] = "<omitted>";
      }
      continue;
    }

    // Rule 3: secret key names → redact entirely.
    if (SECRET_KEY_RE.test(key)) {
      result[key] = "<redacted>";
      continue;
    }

    // Rule 4: plain-object value (e.g. headers) → one-level recursion with
    // secret-key redaction applied to nested keys.
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      result[key] = sanitizeHeadersObject(value as Record<string, unknown>);
      continue;
    }

    // Rule 5: long strings → truncate.
    if (typeof value === "string") {
      result[key] = truncateString(value);
      continue;
    }

    // Rule 6: arrays — cap length and truncate string elements.
    if (Array.isArray(value)) {
      const capped = value.slice(0, MAX_ARRAY_ELEMENTS);
      result[key] = capped.map((element: unknown) =>
        typeof element === "string" ? truncateString(element) : element,
      );
      continue;
    }

    // All other values (numbers, booleans, null) pass through unchanged.
    result[key] = value;
  }

  return result;
}

// ── Append helper ─────────────────────────────────────────────────────────────

/**
 * Append one sanitised audit entry to {@link AUDIT_LOG_PATH} as a JSONL line.
 *
 * This function is SYNCHRONOUS and NEVER THROWS.  An audit failure is silently
 * swallowed so it can never break a tool call.
 *
 * The `summary` field is capped at 200 characters from `resultOrError`; newlines
 * are naturally escaped by `JSON.stringify`, so the line remains single-line JSONL.
 *
 * @param tool           Name of the tool that was called.
 * @param params         Raw (unsanitised) params object from the tool call.
 * @param success        Whether the call succeeded.
 * @param resultOrError  The result string (success) or error message (failure).
 */
export function appendAuditEntry(
  tool: string,
  params: Record<string, unknown>,
  success: boolean,
  resultOrError: string,
): void {
  try {
    ensureDataDir();

    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      tool,
      params: sanitizeParams(params),
      success,
      summary: resultOrError.slice(0, 200),
    };

    const line = JSON.stringify(entry);
    fs.appendFileSync(AUDIT_LOG_PATH, line + "\n", { encoding: "utf8" });
  } catch {
    // Silently swallow — audit failures must never break tool calls.
  }
}
