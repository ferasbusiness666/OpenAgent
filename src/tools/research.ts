/**
 * research.ts — Phase-2 web-research tool.
 *
 * Performs keyless web research by driving a headless Chromium against the
 * DuckDuckGo HTML endpoint (https://html.duckduckgo.com/html/). No API keys,
 * no auth, no third-party search API — just the plain HTML SERP markup, which
 * we parse with regex/string scanning (no external HTML-parser dependency).
 *
 * The HTML parser (`parseDuckDuckGoHtml`) is exported separately and is pure,
 * so it can be verified entirely offline against static markup.
 */

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { isBrowserAvailable, BROWSER_UNAVAILABLE_MESSAGE } from "./browser.js";

/** A single search result extracted from the DuckDuckGo HTML SERP. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Maximum length of the markdown summary returned by ResearchTool.research. */
const MAX_SUMMARY_CHARS = 4000;
/** Per-page extracted-text budget when fetchPages is enabled. */
const MAX_PAGE_EXCERPT_CHARS = 1500;
/** How many top results to actually visit when fetchPages is enabled. */
const MAX_PAGES_TO_FETCH = 3;

/**
 * Decode the small set of HTML entities DuckDuckGo emits in titles/snippets.
 * Handles named entities (&amp; &lt; &gt; &quot; &#39;) plus numeric decimal
 * (&#NN;) and hex (&#xNN;) references. Unknown entities are left untouched.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // &amp; must be decoded last so "&amp;lt;" -> "&lt;" -> "<" never happens
    // out of order; doing it last yields the literal "&lt;" which is correct.
    .replace(/&amp;/g, "&");
}

/** Strip HTML tags from a fragment and decode entities, collapsing whitespace. */
function stripTags(fragment: string): string {
  const withoutTags = fragment.replace(/<[^>]*>/g, "");
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}

/**
 * DuckDuckGo wraps outbound links as `//duckduckgo.com/l/?uddg=<encoded>` (and
 * sometimes `kh=` / other params). When the href is such a redirect, decode the
 * `uddg` query parameter to recover the real destination URL. Otherwise return
 * the href as-is, normalizing a protocol-relative `//host` to `https://host`.
 */
function resolveResultUrl(rawHref: string): string {
  const href = decodeEntities(rawHref).trim();
  if (href.length === 0) {
    return "";
  }
  // Look for the uddg redirect param anywhere in the href.
  const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]);
    } catch {
      // Fall through to returning the (normalized) raw href on bad encoding.
    }
  }
  if (href.startsWith("//")) {
    return `https:${href}`;
  }
  return href;
}

/**
 * Parse the DuckDuckGo HTML-endpoint markup into structured results.
 *
 * Result anchors carry `class="result__a"`; the anchor's href is the result URL
 * (often a `//duckduckgo.com/l/?uddg=` redirect we decode) and its inner text is
 * the visible title. Snippets carry `class="result__snippet"`. Both are matched
 * by scanning for their class attributes, tolerant of other attributes appearing
 * in any order and of single/double-quoted attribute values.
 *
 * The parser is robust to missing snippets, returns at most `maxResults`
 * well-formed entries, and silently skips malformed anchors (no href, or a
 * title/url that resolves to empty).
 *
 * @param html       Raw HTML from the DuckDuckGo HTML endpoint.
 * @param maxResults Maximum number of results to return (clamped to >= 0).
 */
export function parseDuckDuckGoHtml(
  html: string,
  maxResults: number,
): SearchResult[] {
  if (typeof html !== "string" || html.length === 0) {
    return [];
  }
  const limit = Number.isFinite(maxResults) ? Math.max(0, Math.floor(maxResults)) : 0;
  if (limit === 0) {
    return [];
  }

  // Snippets, collected in document order so we can pair them positionally with
  // the result anchors that precede them. We capture the element's tag name and
  // match up to that element's *own* closing tag, so inline children such as
  // <b>…</b> inside a snippet do not prematurely terminate the match.
  const snippets: Array<{ index: number; text: string }> = [];
  const snippetRe =
    /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/g;
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push({ index: m.index, text: stripTags(m[2]) });
  }

  // Result anchors: capture the full attribute blob (to dig out href in any
  // order) and the inner HTML (the title).
  const anchorRe =
    /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/g;
  const results: SearchResult[] = [];

  for (let m = anchorRe.exec(html); m !== null; m = anchorRe.exec(html)) {
    if (results.length >= limit) {
      break;
    }
    const attrs = m[1];
    const innerHtml = m[2];
    const anchorIndex = m.index;

    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/);
    if (!hrefMatch) {
      continue; // No href — malformed result, skip.
    }
    const url = resolveResultUrl(hrefMatch[1]);
    const title = stripTags(innerHtml);
    if (url.length === 0 || title.length === 0) {
      continue; // Nothing useful to show — skip.
    }

    // Pair with the nearest snippet occurring after this anchor (DuckDuckGo
    // emits the snippet below its title). Missing snippet -> "".
    const snippet =
      snippets.find((s) => s.index > anchorIndex)?.text ?? "";

    results.push({ title, url, snippet });
  }

  return results;
}

/**
 * Drives a single reusable headless Chromium to run DuckDuckGo HTML searches.
 * The browser is launched lazily on first `research()` and reused across calls;
 * on a Playwright error the browser is fully recreated once and the search is
 * retried (mirrors the resilience pattern in browser.ts).
 */
export class ResearchTool {
  private browser: Browser | null = null;

  /** Ensure a live, connected browser exists, launching it if necessary. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser === null || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  /** Tear the browser down so the next call relaunches it cleanly. */
  private async reset(): Promise<void> {
    if (this.browser !== null) {
      try {
        await this.browser.close();
      } catch {
        // Discarding this instance anyway — nothing actionable on failed close.
      }
    }
    this.browser = null;
  }

  /**
   * Run one full search-and-parse cycle against a freshly opened page. Pulled
   * out so `research()` can invoke it twice (initial + post-reset retry).
   */
  private async runSearch(
    query: string,
    maxResults: number,
    fetchPages: boolean,
  ): Promise<string> {
    const browser = await this.ensureBrowser();
    const page: Page = await browser.newPage();
    try {
      const searchUrl =
        "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      const html = await page.content();
      const results = parseDuckDuckGoHtml(html, maxResults);

      const excerpts: Array<{ url: string; text: string }> = [];
      if (fetchPages && results.length > 0) {
        const targets = results.slice(0, MAX_PAGES_TO_FETCH);
        for (const target of targets) {
          try {
            await page.goto(target.url, {
              waitUntil: "domcontentloaded",
              timeout: 20_000,
            });
            const raw = await page.evaluate(() => document.body.innerText);
            const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
            excerpts.push({
              url: target.url,
              text: text.slice(0, MAX_PAGE_EXCERPT_CHARS),
            });
          } catch {
            // Tolerate per-page failures — skip this excerpt and continue.
          }
        }
      }

      return formatSummary(query, results, excerpts);
    } finally {
      try {
        await page.close();
      } catch {
        // Ignore — page teardown errors are not actionable.
      }
    }
  }

  /**
   * Search the web for `query` and return a markdown summary.
   *
   * @param options.maxResults  Number of results to parse (default 5).
   * @param options.fetchPages  Visit the top results and include text excerpts
   *                            (default false).
   * @throws Error(BROWSER_UNAVAILABLE_MESSAGE) when Chromium is not installed.
   */
  async research(
    query: string,
    options?: { maxResults?: number; fetchPages?: boolean },
  ): Promise<string> {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("research requires a non-empty query.");
    }
    if (!isBrowserAvailable()) {
      throw new Error(BROWSER_UNAVAILABLE_MESSAGE);
    }
    const maxResults = options?.maxResults ?? 5;
    const fetchPages = options?.fetchPages ?? false;

    try {
      return await this.runSearch(query, maxResults, fetchPages);
    } catch (firstError) {
      // Recreate the browser once and retry, mirroring browser.ts resilience.
      await this.reset();
      try {
        return await this.runSearch(query, maxResults, fetchPages);
      } catch (secondError) {
        const firstDetail =
          firstError instanceof Error ? firstError.message : String(firstError);
        const secondDetail =
          secondError instanceof Error
            ? secondError.message
            : String(secondError);
        throw new Error(
          `Web research for "${query}" failed after retry. ` +
            `First error: ${firstDetail}. Retry error: ${secondDetail}.`,
        );
      }
    }
  }

  /** Close the browser if open; swallow any errors. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.browser !== null) {
      try {
        await this.browser.close();
      } catch {
        // Nothing actionable on a failed close during shutdown.
      }
    }
    this.browser = null;
  }
}

/**
 * Render results + optional page excerpts into a markdown summary, capped to
 * MAX_SUMMARY_CHARS. Pure helper so the formatting is trivially testable.
 */
function formatSummary(
  query: string,
  results: SearchResult[],
  excerpts: Array<{ url: string; text: string }>,
): string {
  const lines: string[] = [];
  lines.push(`# Web research: ${query}`);
  lines.push("");

  if (results.length === 0) {
    lines.push("_No results found._");
  } else {
    results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}**`);
      lines.push(r.url);
      if (r.snippet.length > 0) {
        lines.push(r.snippet);
      }
      lines.push("");
    });
  }

  if (excerpts.length > 0) {
    lines.push("## Page excerpts");
    lines.push("");
    for (const ex of excerpts) {
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
