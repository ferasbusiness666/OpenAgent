/**
 * http.ts — HTTP client tool for Open Agent (IMP-14).
 *
 * Gives the agent the ability to make arbitrary outbound HTTP requests while
 * enforcing the project-wide SSRF guard so model-chosen URLs cannot be used to
 * scan internal networks or read cloud-instance metadata.
 *
 * Design decisions
 * ────────────────
 * • SSRF guard is applied BEFORE the fetch and again AFTER following redirects
 *   so a 301 → private-IP chain is caught even when the first URL looked public.
 * • Redirect following uses the native fetch default (`redirect: "follow"`).
 *   We inspect `response.url` (the final URL after all hops) for the post-fetch
 *   guard check.
 * • Response bodies are capped at 100 KB to prevent the agent from drowning the
 *   context window with a large HTML blob.
 * • JSON responses are pretty-printed when possible; parse failures fall back to
 *   raw text transparently.
 * • Non-2xx responses are NOT thrown — the status is a valid observation. Only
 *   guard blocks, invalid input, timeout, and network errors throw.
 * • Timeout is implemented with `AbortController`; the message explicitly names
 *   the elapsed seconds so the agent can diagnose slow endpoints.
 */

import { checkUrlAllowed } from "../util/net-guard.js";
import { getConfig } from "../config/index.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** Allowed HTTP verb set. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/** Input options for {@link HttpTool.request}. */
export interface HttpRequestOptions {
  /** HTTP verb. Defaults to `"GET"`. */
  method?: HttpMethod;
  /** Fully-qualified URL to request. Must be http/https. */
  url: string;
  /** Additional request headers to send. */
  headers?: Record<string, string>;
  /**
   * Request body string. Sent for POST, PUT, PATCH, DELETE when present.
   * If no `content-type` header is provided, defaults to `application/json`.
   */
  body?: string;
  /**
   * Request timeout in milliseconds. Defaults to 30 000 ms.
   * Clamped to the range [1 000, 120 000].
   */
  timeoutMs?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Default timeout when the caller does not specify one (30 s). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Minimum permitted timeout (1 s — anything shorter is unreasonably tight). */
const MIN_TIMEOUT_MS = 1_000;
/** Maximum permitted timeout (2 min — avoids a hung task blocking forever). */
const MAX_TIMEOUT_MS = 120_000;
/** Response body cap to protect the LLM context window (100 KB). */
const MAX_BODY_CHARS = 100_000;

/**
 * Response headers worth surfacing to the agent — everything else is noise in
 * the context window.
 */
const INTERESTING_HEADERS: ReadonlyArray<string> = [
  "content-type",
  "content-length",
  "location",
  "server",
  "date",
];

/** All valid method values (used to build the validation error message). */
const VALID_METHODS: ReadonlyArray<HttpMethod> = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
];

// ── Helper — validate options ─────────────────────────────────────────────────

/**
 * Validate the caller-supplied options and return a normalised copy.
 * Throws a descriptive `Error` on any invalid input.
 *
 * @param options  Raw options from the caller.
 * @returns        Normalised options with defaults applied.
 */
function normaliseOptions(options: HttpRequestOptions): Required<HttpRequestOptions> {
  // url must be non-empty.
  if (!options.url || options.url.trim().length === 0) {
    throw new Error("HttpTool: url must be a non-empty string.");
  }

  // method validation.
  const method: HttpMethod = options.method ?? "GET";
  if (!(VALID_METHODS as ReadonlyArray<string>).includes(method)) {
    throw new Error(
      `HttpTool: invalid method "${method}". Valid methods are: ${VALID_METHODS.join(", ")}.`,
    );
  }

  // Clamp timeout.
  const rawTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rawTimeout));

  return {
    method,
    url: options.url.trim(),
    headers: options.headers ?? {},
    body: options.body ?? "",
    timeoutMs,
  };
}

// ── Helper — format the response ──────────────────────────────────────────────

/**
 * Build the human-readable string returned to the agent from a completed fetch.
 *
 * Format:
 * ```
 * HTTP <status> <statusText>
 * content-type: application/json
 * content-length: 1234
 *
 * { … pretty JSON … }
 * ```
 *
 * @param status      HTTP status code.
 * @param statusText  HTTP reason phrase.
 * @param headers     Raw `Headers` from the fetch response.
 * @param body        Raw response body text (already capped at MAX_BODY_CHARS).
 */
function formatResponse(
  status: number,
  statusText: string,
  headers: Headers,
  body: string,
): string {
  const lines: string[] = [`HTTP ${status} ${statusText}`];

  // Surface only the handful of headers that are useful to the agent.
  for (const name of INTERESTING_HEADERS) {
    const value = headers.get(name);
    if (value !== null) {
      lines.push(`${name}: ${value}`);
    }
  }

  // Blank line separator between headers and body.
  lines.push("");

  // Attempt pretty-print for JSON responses.
  const contentType = headers.get("content-type") ?? "";
  let displayBody = body.length === 0 ? "(empty body)" : body;

  if (contentType.includes("application/json") && body.length > 0) {
    try {
      displayBody = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Not valid JSON despite the content-type header — keep raw body.
    }
  }

  lines.push(displayBody);
  return lines.join("\n");
}

// ── HttpTool ──────────────────────────────────────────────────────────────────

/**
 * HTTP client tool — lets the agent make outbound HTTP requests with SSRF
 * protection, automatic timeout, and a context-window-safe response format.
 *
 * Usage by the agent (via the tool registry):
 * ```ts
 * const tool = new HttpTool();
 * const result = await tool.request({ url: "https://api.example.com/data" });
 * ```
 */
export class HttpTool {
  /**
   * Perform an HTTP request and return a formatted string suitable for the
   * agent's context window.
   *
   * Throws only on:
   *  - Invalid input (bad url, unknown method).
   *  - SSRF guard block (the target resolves to an internal/private address).
   *  - Request timeout (message includes "timed out after N s").
   *  - Network-level errors (DNS failures, TCP resets, etc.).
   *
   * Non-2xx responses are returned formatted — they are a valid observation.
   *
   * @param options  Request configuration. See {@link HttpRequestOptions}.
   * @returns        Formatted response string, always beginning with
   *                 `"HTTP <status> <statusText>"`.
   */
  async request(options: HttpRequestOptions): Promise<string> {
    const norm = normaliseOptions(options);

    // ── SSRF guard (pre-fetch) ───────────────────────────────────────────────
    const preCheck = await checkUrlAllowed(norm.url, {
      allowLocal: getConfig().allowLocalNetworkAccess,
    });
    if (!preCheck.allowed) {
      throw new Error(`HttpTool SSRF guard blocked request: ${preCheck.reason ?? "blocked"}`);
    }

    // ── Build request init ───────────────────────────────────────────────────
    const requestHeaders: Record<string, string> = { ...norm.headers };

    // Default content-type for bodies when the caller did not specify one.
    const hasBody =
      norm.body.length > 0 &&
      (norm.method === "POST" ||
        norm.method === "PUT" ||
        norm.method === "PATCH" ||
        norm.method === "DELETE");

    if (hasBody) {
      const hasContentType = Object.keys(requestHeaders).some(
        (k) => k.toLowerCase() === "content-type",
      );
      if (!hasContentType) {
        requestHeaders["content-type"] = "application/json";
      }
    }

    const requestInit: RequestInit = {
      method: norm.method,
      headers: requestHeaders,
      // Follow redirects (the default) — we check the final URL post-fetch.
      redirect: "follow",
    };

    if (hasBody) {
      requestInit.body = norm.body;
    }

    // ── Abort controller for timeout ─────────────────────────────────────────
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), norm.timeoutMs);
    requestInit.signal = controller.signal;

    let response: Response;
    try {
      response = await fetch(norm.url, requestInit);
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      // Distinguish abort (timeout) from other network errors.
      if (err instanceof DOMException && err.name === "AbortError") {
        const secs = Math.round(norm.timeoutMs / 1_000);
        throw new Error(
          `HttpTool: request to "${norm.url}" timed out after ${secs}s. ` +
            `Increase timeoutMs (max ${MAX_TIMEOUT_MS / 1_000}s) if the server is slow.`,
        );
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`HttpTool: network error fetching "${norm.url}": ${msg}`);
    } finally {
      clearTimeout(timeoutId);
    }

    // ── SSRF guard (post-redirect check) ────────────────────────────────────
    // `response.url` is the final URL after all redirects. Re-check it so a
    // 301 → private-IP hop is caught.
    if (response.url && response.url !== norm.url) {
      const postCheck = await checkUrlAllowed(response.url, {
        allowLocal: getConfig().allowLocalNetworkAccess,
      });
      if (!postCheck.allowed) {
        throw new Error(
          `HttpTool SSRF guard blocked redirect destination: ${postCheck.reason ?? "blocked"}`,
        );
      }
    }

    // ── Read and cap the body ─────────────────────────────────────────────────
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`HttpTool: failed to read response body from "${norm.url}": ${msg}`);
    }

    let body = rawBody;
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + `... (body truncated at ${MAX_BODY_CHARS} chars)`;
    }

    // ── Format and return ────────────────────────────────────────────────────
    return formatResponse(response.status, response.statusText, response.headers, body);
  }
}
