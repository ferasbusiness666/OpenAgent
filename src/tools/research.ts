/**
 * research.ts — Phase-2 web-research tool, backed by the Tavily API.
 *
 * Tavily (https://tavily.com) is a search API purpose-built for agents: a single
 * POST returns ranked results (title/url/content) plus an optional synthesized
 * answer, so there is no HTML to scrape and no headless browser to drive. The
 * tool interface is unchanged from the previous backend — `research(query, opts)`
 * still returns a markdown digest — only the backend was swapped.
 *
 * Auth: the API key is read from the TAVILY_API_KEY environment variable (which
 * takes precedence) or the `tavilyApiKey` config field. The response mapper
 * (`parseTavilyResponse`) is pure and exported so it can be verified offline.
 */

import { getConfig } from "../config/index.js";

/** A single search result, normalized from the Tavily response. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Mapped Tavily payload: an optional answer, ranked results, and raw excerpts. */
export interface ResearchData {
  answer: string;
  results: SearchResult[];
  excerpts: Array<{ url: string; text: string }>;
}

/** Tavily REST endpoint. */
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
/** Request timeout (ms). */
const REQUEST_TIMEOUT_MS = 20_000;
/** Maximum length of the markdown summary returned by ResearchTool.research. */
const MAX_SUMMARY_CHARS = 4000;
/** Per-page raw-content budget when fetchPages is enabled. */
const MAX_PAGE_EXCERPT_CHARS = 1500;

/** Collapse runs of whitespace to single spaces and trim. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Read a string field from an unknown record, or "" when absent/non-string. */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * Map a raw Tavily `/search` response into structured data. Pure and defensive:
 * tolerates missing/extra fields and a non-array `results`, and never throws —
 * which keeps it trivially testable offline against canned JSON.
 *
 * @param raw         The parsed JSON body returned by Tavily.
 * @param maxResults  Maximum number of results to keep (clamped to >= 0).
 */
export function parseTavilyResponse(raw: unknown, maxResults: number): ResearchData {
  const limit = Number.isFinite(maxResults) ? Math.max(0, Math.floor(maxResults)) : 0;
  const empty: ResearchData = { answer: "", results: [], excerpts: [] };
  if (typeof raw !== "object" || raw === null) {
    return empty;
  }
  const record = raw as Record<string, unknown>;
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";

  const rawResults = Array.isArray(record.results) ? record.results : [];
  const results: SearchResult[] = [];
  const excerpts: Array<{ url: string; text: string }> = [];

  for (const item of rawResults) {
    if (results.length >= limit) {
      break;
    }
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const r = item as Record<string, unknown>;
    const url = readString(r, "url").trim();
    if (url.length === 0) {
      continue; // A result without a URL is unusable.
    }
    const title = collapse(readString(r, "title")) || url;
    const snippet = collapse(readString(r, "content"));
    results.push({ title, url, snippet });

    const rawContent = collapse(readString(r, "raw_content"));
    if (rawContent.length > 0) {
      excerpts.push({ url, text: rawContent.slice(0, MAX_PAGE_EXCERPT_CHARS) });
    }
  }

  return { answer, results, excerpts };
}

/**
 * Web-research tool backed by the Tavily API. Stateless aside from per-call
 * fetches; `close()` exists only to satisfy the tool lifecycle contract.
 */
export class ResearchTool {
  /** Resolve the Tavily API key (env takes precedence over config). */
  private resolveKey(): string {
    const fromEnv = process.env.TAVILY_API_KEY;
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
      return fromEnv.trim();
    }
    const fromConfig = getConfig().tavilyApiKey;
    return typeof fromConfig === "string" ? fromConfig.trim() : "";
  }

  /**
   * Search the web for `query` via Tavily and return a markdown summary.
   *
   * @param options.maxResults  Number of results to return (default 5).
   * @param options.fetchPages  Ask Tavily for raw page content and include
   *                            excerpts of the top results (default false).
   * @throws Error when no Tavily API key is configured, or the request fails.
   */
  async research(
    query: string,
    options?: { maxResults?: number; fetchPages?: boolean },
  ): Promise<string> {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("research requires a non-empty query.");
    }
    const apiKey = this.resolveKey();
    if (apiKey.length === 0) {
      throw new Error(
        "TAVILY_API_KEY is not set. Add a Tavily API key in /settings (Tavily API key) " +
          "or set the TAVILY_API_KEY environment variable to use the research tool.",
      );
    }

    const maxResults = options?.maxResults ?? 5;
    const fetchPages = options?.fetchPages ?? false;

    const body = {
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: fetchPages ? "advanced" : "basic",
      include_answer: true,
      include_raw_content: fetchPages,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Tavily request for "${query}" failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let snippet = "";
      try {
        snippet = (await response.text()).slice(0, 200);
      } catch {
        // ignore body read errors
      }
      const hint =
        response.status === 401
          ? " (check that the TAVILY_API_KEY is valid)"
          : "";
      throw new Error(
        `Tavily responded with HTTP ${response.status}${hint}. ${snippet}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Tavily returned an unparseable response: ${detail}`);
    }

    const data = parseTavilyResponse(json, maxResults);
    return formatSummary(query, data);
  }

  /** No-op: the Tavily backend holds no long-lived resources. Kept for the
   *  tool lifecycle contract (the entry point calls closeResearch() on exit). */
  async close(): Promise<void> {
    // Nothing to tear down.
  }
}

/**
 * Render the mapped Tavily data into a markdown summary, capped to
 * MAX_SUMMARY_CHARS. Pure helper so the formatting is trivially testable.
 */
export function formatSummary(query: string, data: ResearchData): string {
  const lines: string[] = [];
  lines.push(`# Web research: ${query}`);
  lines.push("");

  if (data.answer.length > 0) {
    lines.push(`**Answer:** ${data.answer}`);
    lines.push("");
  }

  if (data.results.length === 0) {
    lines.push("_No results found._");
  } else {
    data.results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}**`);
      lines.push(r.url);
      if (r.snippet.length > 0) {
        lines.push(r.snippet);
      }
      lines.push("");
    });
  }

  if (data.excerpts.length > 0) {
    lines.push("## Page excerpts");
    lines.push("");
    for (const ex of data.excerpts) {
      lines.push(`### ${ex.url}`);
      lines.push(ex.text.length > 0 ? ex.text : "_No extractable text._");
      lines.push("");
    }
  }

  const summary = lines.join("\n").trimEnd();
  if (summary.length <= MAX_SUMMARY_CHARS) {
    return summary;
  }
  return summary.slice(0, MAX_SUMMARY_CHARS - 3).trimEnd() + "...";
}
