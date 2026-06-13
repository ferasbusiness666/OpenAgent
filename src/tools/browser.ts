import path from "node:path";
import fs from "fs-extra";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { getConfig, resolveWorkspacePath } from "../config/index.js";
import { checkUrlAllowed } from "../util/net-guard.js";
import { resolveWorkspaceRelative } from "../util/sandbox.js";

/** One captured response in the network ring buffer (see {@link BrowserTool.network}). */
interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  at: number;
}

/** A single cookie accepted by {@link BrowserTool.setCookies}, after validation. */
interface ValidatedCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

// Cached result of the chromium-binary check (the path never changes at runtime).
let browserAvailableCache: boolean | null = null;

/**
 * True when Playwright's Chromium binary is actually installed. We check the
 * resolved executable path on disk rather than trusting that the npm package is
 * present, so a missing `npx playwright install chromium` degrades gracefully
 * instead of throwing when the browser tool is first used.
 */
export function isBrowserAvailable(): boolean {
  if (browserAvailableCache !== null) {
    return browserAvailableCache;
  }
  try {
    const execPath = chromium.executablePath();
    browserAvailableCache =
      typeof execPath === "string" && execPath.length > 0 && fs.existsSync(execPath);
  } catch {
    browserAvailableCache = false;
  }
  return browserAvailableCache;
}

/** Message shown when the browser tool is requested but Chromium is missing. */
export const BROWSER_UNAVAILABLE_MESSAGE =
  "Browser tool unavailable — run `npx playwright install chromium` to enable.";

/**
 * Drives a single headless Chromium instance for the lifetime of the session.
 * The browser + page are launched lazily on first use and reused across calls.
 * On any Playwright error an operation is retried exactly once after fully
 * recreating the browser.
 */
export class BrowserTool {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  /**
   * Always-on ring buffer of recent network responses, surfaced by
   * {@link network}. Capped at {@link NETWORK_BUFFER_CAP} entries (oldest
   * dropped) so a long-lived page can never grow it without bound.
   */
  private networkLog: NetworkEntry[] = [];

  /**
   * Pages that already have the "response" listener attached. A page is created
   * inside {@link ensurePage} on first use and again after every crash-recovery
   * relaunch, so we guard against double-attachment per page instance (the set
   * holds weak references, so closed/GC'd pages drop out automatically).
   */
  private readonly listenedPages = new WeakSet<Page>();

  /** Maximum entries retained in the network ring buffer. */
  private static readonly NETWORK_BUFFER_CAP = 200;

  /**
   * Per-URL character cap for ring-buffer entries. The entry COUNT is already
   * bounded (NETWORK_BUFFER_CAP), but a single `data:`/`blob:` URL can be
   * megabytes, so without this the buffer's memory is effectively unbounded.
   * 200 entries × 2 KB keeps the whole buffer well under 1 MB.
   */
  private static readonly NETWORK_URL_CAP = 2_000;

  /** Character cap applied to serialized output of getCookies / injectJs. */
  private static readonly OUTPUT_CAP = 4_000;

  /** Maximum download body size accepted by {@link download} (50 MB). */
  private static readonly MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

  /**
   * Ensure a live browser + explicit context + page exist, launching them if
   * necessary. We create an explicit BrowserContext (rather than relying on the
   * implicit one behind browser.newPage()) so cookie operations have a context
   * handle to read from / write to. The "response" listener that feeds the
   * network ring buffer is (re)attached every time a page is created — including
   * after a crash-recovery relaunch — and guarded against double-attachment.
   */
  private async ensurePage(): Promise<Page> {
    if (this.browser === null || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
      this.context = null;
      this.page = null;
    }
    if (this.context === null) {
      this.context = await this.browser.newContext();
      this.page = null;
    }
    if (this.page === null || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    const page = this.page;
    if (!this.listenedPages.has(page)) {
      this.listenedPages.add(page);
      page.on("response", (response) => {
        try {
          const request = response.request();
          const rawUrl = response.url();
          const url =
            rawUrl.length > BrowserTool.NETWORK_URL_CAP
              ? rawUrl.slice(0, BrowserTool.NETWORK_URL_CAP) + "…"
              : rawUrl;
          this.recordNetwork({
            method: request.method(),
            url,
            status: response.status(),
            resourceType: request.resourceType(),
            at: Date.now(),
          });
        } catch {
          // A response can race with teardown; dropping one entry is harmless.
        }
      });
    }
    return page;
  }

  /** Append a network entry, dropping the oldest once the cap is exceeded. */
  private recordNetwork(entry: NetworkEntry): void {
    this.networkLog.push(entry);
    if (this.networkLog.length > BrowserTool.NETWORK_BUFFER_CAP) {
      this.networkLog.splice(
        0,
        this.networkLog.length - BrowserTool.NETWORK_BUFFER_CAP,
      );
    }
  }

  /** Tear down the browser so the next operation relaunches it cleanly. */
  private async reset(): Promise<void> {
    if (this.browser !== null) {
      try {
        await this.browser.close();
      } catch {
        // Ignore close errors — we are discarding this instance anyway.
      }
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.networkLog = [];
  }

  /**
   * Run a page operation with a single retry. On the first failure the browser
   * is fully recreated before the retry. A second failure throws a descriptive
   * error.
   */
  private async withRetry<T>(
    label: string,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    try {
      const page = await this.ensurePage();
      return await fn(page);
    } catch (firstError) {
      await this.reset();
      try {
        const page = await this.ensurePage();
        return await fn(page);
      } catch (secondError) {
        const detail =
          secondError instanceof Error
            ? secondError.message
            : String(secondError);
        const firstDetail =
          firstError instanceof Error ? firstError.message : String(firstError);
        throw new Error(
          `Browser operation "${label}" failed after retry. ` +
            `First error: ${firstDetail}. Retry error: ${detail}.`,
        );
      }
    }
  }

  /**
   * Navigate to a URL and return the resulting page title. URLs are screened
   * by the SSRF guard before AND after navigation (redirects could land on an
   * internal address even when the requested URL was public); the agent's own
   * `serve` previews on localhost are exempt, and the user can disable the
   * guard with the `allowLocalNetworkAccess` setting.
   */
  async navigate(url: string): Promise<string> {
    if (typeof url !== "string" || url.trim().length === 0) {
      throw new Error("navigate requires a non-empty url.");
    }
    const allowLocal = getConfig().allowLocalNetworkAccess;
    const check = await checkUrlAllowed(url, { allowLocal });
    if (!check.allowed) {
      throw new Error(check.reason ?? `Blocked URL: ${url}`);
    }
    // A navigation starts a fresh browsing session — drop captured network
    // activity so network() describes only what happens from here on.
    this.networkLog = [];
    return await this.withRetry("navigate", async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const finalUrl = page.url();
      if (finalUrl !== url) {
        const post = await checkUrlAllowed(finalUrl, { allowLocal });
        if (!post.allowed) {
          await page.goto("about:blank");
          throw new Error(
            `Blocked: the page redirected to an internal address (${finalUrl}). ${post.reason ?? ""}`,
          );
        }
      }
      const title = await page.title();
      return `Navigated to ${url} — title: "${title}"`;
    });
  }

  /** Click the first element matching the selector. */
  async click(selector: string): Promise<string> {
    if (typeof selector !== "string" || selector.trim().length === 0) {
      throw new Error("click requires a non-empty selector.");
    }
    return await this.withRetry("click", async (page) => {
      await page.click(selector, { timeout: 15_000 });
      return `Clicked element "${selector}".`;
    });
  }

  /** Fill / type text into the element matching the selector. */
  async type(selector: string, text: string): Promise<string> {
    if (typeof selector !== "string" || selector.trim().length === 0) {
      throw new Error("type requires a non-empty selector.");
    }
    const value = typeof text === "string" ? text : "";
    return await this.withRetry("type", async (page) => {
      await page.fill(selector, value, { timeout: 15_000 });
      return `Typed ${value.length} character(s) into "${selector}".`;
    });
  }

  /** Capture a full-page PNG into the workspace; returns the saved file path. */
  async screenshot(): Promise<string> {
    const workspace = resolveWorkspacePath(getConfig());
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const fileName = `screenshot_${stamp}.png`;
    const filePath = path.join(workspace, fileName);
    return await this.withRetry("screenshot", async (page) => {
      await page.screenshot({ path: filePath, fullPage: true });
      return filePath;
    });
  }

  /** Return all visible text on the current page. */
  async extractText(): Promise<string> {
    return await this.withRetry("extractText", async (page) => {
      const text = await page.evaluate(() => document.body.innerText);
      return typeof text === "string" ? text : "";
    });
  }

  /** Return the full HTML of the current page. */
  async getHtml(): Promise<string> {
    return await this.withRetry("getHtml", async (page) => {
      return await page.content();
    });
  }

  /**
   * Wait for a CSS selector to appear in the DOM. Returns a confirmation
   * string on success; throws an Error if the selector does not appear within
   * the given timeout so the registry can surface a clear failure message.
   */
  async waitFor(selector: string, timeoutMs = 10_000): Promise<string> {
    if (typeof selector !== "string" || selector.trim().length === 0) {
      throw new Error("waitFor requires a non-empty selector.");
    }
    return await this.withRetry("waitFor", async (page) => {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      return `Element "${selector}" appeared.`;
    });
  }

  /**
   * Scroll the page. `target` is one of "bottom" | "top" | "down" | "up".
   * "bottom" scrolls to the document end, "top" scrolls to 0, "down"/"up"
   * scroll by approximately one viewport height.
   */
  async scroll(target: string): Promise<string> {
    const validTargets = ["bottom", "top", "down", "up"] as const;
    type ScrollTarget = (typeof validTargets)[number];
    const t: ScrollTarget = (validTargets as readonly string[]).includes(target)
      ? (target as ScrollTarget)
      : "bottom";

    return await this.withRetry("scroll", async (page) => {
      await page.evaluate((scrollTarget: string) => {
        if (scrollTarget === "bottom") {
          window.scrollTo(0, document.body.scrollHeight);
        } else if (scrollTarget === "top") {
          window.scrollTo(0, 0);
        } else if (scrollTarget === "down") {
          window.scrollBy(0, window.innerHeight);
        } else {
          // "up"
          window.scrollBy(0, -window.innerHeight);
        }
      }, t);
      return `Scrolled ${t}.`;
    });
  }

  /**
   * Extract the main readable text from the page, preferring <main> or
   * <article> elements over the full body. Strips excessive blank lines and
   * caps output at ~8000 characters.
   */
  async readText(): Promise<string> {
    return await this.withRetry("readText", async (page) => {
      const raw = await page.evaluate((): string => {
        const preferred =
          document.querySelector("main") ?? document.querySelector("article");
        const el = preferred ?? document.body;
        return (el as HTMLElement).innerText ?? "";
      });
      const text = typeof raw === "string" ? raw : "";
      // Collapse runs of 3+ blank lines down to two.
      const cleaned = text.replace(/(\r?\n){3,}/g, "\n\n").trim();
      const cap = 8_000;
      if (cleaned.length <= cap) return cleaned;
      return cleaned.slice(0, cap) + "\n... (text truncated at 8000 chars)";
    });
  }

  /**
   * Simulate pressing a keyboard key (e.g. "Enter", "Escape", "ArrowDown").
   * Uses Playwright's `page.keyboard.press` which accepts any KeyboardEvent.key
   * value or shorthand like "Tab", "Shift+Enter", etc.
   */
  async press(key: string): Promise<string> {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new Error("press requires a non-empty key string.");
    }
    return await this.withRetry("press", async (page) => {
      await page.keyboard.press(key);
      return `Pressed ${key}.`;
    });
  }

  /** Shut the browser down cleanly. Safe to call when nothing is open. */
  async close(): Promise<void> {
    if (this.browser !== null) {
      try {
        await this.browser.close();
      } catch {
        // Ignore — nothing actionable on a failed close during shutdown.
      }
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.networkLog = [];
  }

  /**
   * Set cookies on the current browser context from a JSON array of cookie
   * objects. Each entry needs a non-empty `name` and string `value`; a cookie
   * must carry EITHER a `url` OR a `domain` (when only a domain is given, `path`
   * defaults to "/"). Optional `expires` (unix seconds), `httpOnly`, and
   * `secure` are passed through. Validation runs before any cookie is applied,
   * so a malformed entry rejects the whole batch with a clear message — cookie
   * VALUES are never echoed in errors (only names / indices).
   */
  async setCookies(cookiesJson: string): Promise<string> {
    if (typeof cookiesJson !== "string" || cookiesJson.trim().length === 0) {
      throw new Error("setCookies requires a non-empty JSON string.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cookiesJson);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`setCookies: invalid JSON — ${detail}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("setCookies: expected a JSON array of cookie objects.");
    }

    const cookies: ValidatedCookie[] = [];
    const problems: string[] = [];

    parsed.forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        problems.push(`#${index}: not an object`);
        return;
      }
      const c = raw as Record<string, unknown>;
      const where = `#${index}`;

      if (typeof c.name !== "string" || c.name.length === 0) {
        problems.push(`${where}: missing/invalid "name"`);
        return;
      }
      const name = c.name;
      if (typeof c.value !== "string") {
        problems.push(`${where} ("${name}"): missing/invalid "value" (must be a string)`);
        return;
      }

      const hasUrl = typeof c.url === "string" && c.url.length > 0;
      const hasDomain = typeof c.domain === "string" && c.domain.length > 0;
      if (!hasUrl && !hasDomain) {
        problems.push(`${where} ("${name}"): needs either "url" or "domain"`);
        return;
      }

      const cookie: ValidatedCookie = { name, value: c.value };

      if (hasUrl) {
        cookie.url = c.url as string;
      }
      if (hasDomain) {
        cookie.domain = c.domain as string;
        // Per the spec: a domain cookie requires a path; default to "/".
        if (typeof c.path === "string" && c.path.length > 0) {
          cookie.path = c.path;
        } else {
          cookie.path = "/";
        }
      } else if (typeof c.path === "string" && c.path.length > 0) {
        cookie.path = c.path;
      }

      if (c.expires !== undefined) {
        if (typeof c.expires !== "number" || !Number.isFinite(c.expires)) {
          problems.push(`${where} ("${name}"): "expires" must be a finite number`);
          return;
        }
        cookie.expires = c.expires;
      }
      if (c.httpOnly !== undefined) {
        if (typeof c.httpOnly !== "boolean") {
          problems.push(`${where} ("${name}"): "httpOnly" must be a boolean`);
          return;
        }
        cookie.httpOnly = c.httpOnly;
      }
      if (c.secure !== undefined) {
        if (typeof c.secure !== "boolean") {
          problems.push(`${where} ("${name}"): "secure" must be a boolean`);
          return;
        }
        cookie.secure = c.secure;
      }

      cookies.push(cookie);
    });

    if (problems.length > 0) {
      throw new Error(`setCookies: invalid cookie(s): ${problems.join("; ")}`);
    }
    if (cookies.length === 0) {
      throw new Error("setCookies: no cookies provided.");
    }

    return await this.withRetry("setCookies", async () => {
      // ensurePage (run by withRetry) guarantees the context exists.
      if (this.context === null) {
        throw new Error("setCookies: browser context is unavailable.");
      }
      await this.context.addCookies(cookies);
      return `Set ${cookies.length} cookie(s).`;
    });
  }

  /**
   * Return the cookies on the current browser context as pretty-printed JSON,
   * capped at {@link OUTPUT_CAP} characters with a truncation note. Reports
   * "(no cookies)" when the context holds none.
   */
  async getCookies(): Promise<string> {
    return await this.withRetry("getCookies", async () => {
      if (this.context === null) {
        throw new Error("getCookies: browser context is unavailable.");
      }
      const cookies = await this.context.cookies();
      if (cookies.length === 0) {
        return "(no cookies)";
      }
      const json = JSON.stringify(cookies, null, 2);
      const cap = BrowserTool.OUTPUT_CAP;
      if (json.length <= cap) {
        return json;
      }
      return (
        json.slice(0, cap) +
        `\n... (output truncated at ${cap} chars; ${cookies.length} cookie(s) total)`
      );
    });
  }

  /**
   * Evaluate a JavaScript snippet inside the current page and return its result
   * serialized as JSON (capped at {@link OUTPUT_CAP} chars). The script runs in
   * the page's own Chromium sandbox — it can only touch that page, the same
   * accepted risk model as click/type. The snippet is evaluated as an
   * expression-or-body by Playwright, so a trailing expression (or `return`
   * inside a function body) becomes the result; `undefined` reports
   * "(no return value)". Errors thrown inside the page bubble up as a readable
   * Error message.
   */
  async injectJs(script: string): Promise<string> {
    if (typeof script !== "string" || script.trim().length === 0) {
      throw new Error("injectJs requires a non-empty script string.");
    }
    return await this.withRetry("injectJs", async (page) => {
      let result: unknown;
      try {
        result = await page.evaluate(script);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`injectJs: page evaluation failed — ${detail}`);
      }
      if (result === undefined) {
        return "(no return value)";
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(result);
      } catch {
        serialized = String(result);
      }
      if (serialized === undefined) {
        return "(no return value)";
      }
      const cap = BrowserTool.OUTPUT_CAP;
      if (serialized.length <= cap) {
        return serialized;
      }
      return serialized.slice(0, cap) + `\n... (output truncated at ${cap} chars)`;
    });
  }

  /**
   * Download a URL to a file inside the workspace using the PAGE's request
   * context, so the current session's cookies are applied. The URL is SSRF-
   * screened and the destination is confined to the workspace. Bodies over
   * {@link MAX_DOWNLOAD_BYTES} (50 MB) are rejected — checked against the
   * content-length header up front AND the actual body length. Non-2xx
   * responses throw with the status.
   */
  async download(url: string, savePath: string): Promise<string> {
    if (typeof url !== "string" || url.trim().length === 0) {
      throw new Error("download requires a non-empty url.");
    }
    if (typeof savePath !== "string" || savePath.trim().length === 0) {
      throw new Error("download requires a non-empty savePath.");
    }

    const allowLocal = getConfig().allowLocalNetworkAccess;
    const check = await checkUrlAllowed(url, { allowLocal });
    if (!check.allowed) {
      throw new Error(check.reason ?? `Blocked URL: ${url}`);
    }

    const workspace = path.resolve(resolveWorkspacePath(getConfig()));
    const destination = resolveWorkspaceRelative(savePath, workspace, "browser");

    const maxBytes = BrowserTool.MAX_DOWNLOAD_BYTES;

    return await this.withRetry("download", async (page) => {
      const response = await page.request.get(url, {
        timeout: 60_000,
        maxRedirects: 5,
      });
      const status = response.status();
      if (status < 200 || status >= 300) {
        throw new Error(`download: server returned HTTP ${status} for ${url}`);
      }

      const declared = response.headers()["content-length"];
      if (declared !== undefined) {
        const declaredBytes = Number(declared);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
          throw new Error(
            `download: response is ${declaredBytes} bytes, exceeding the ` +
              `${maxBytes}-byte (50 MB) limit.`,
          );
        }
      }

      const body = await response.body();
      if (body.length > maxBytes) {
        throw new Error(
          `download: downloaded ${body.length} bytes, exceeding the ` +
            `${maxBytes}-byte (50 MB) limit.`,
        );
      }

      await fs.ensureDir(path.dirname(destination));
      await fs.writeFile(destination, body);
      return `Downloaded ${body.length} bytes to "${savePath}" (HTTP ${status}).`;
    });
  }

  /**
   * Return recent network activity captured by the always-on ring buffer
   * (newest last). Without a filter the most recent 50 entries are shown; with
   * one, entries are filtered by a case-insensitive match on the URL — the
   * filter is tried as a regular expression first and falls back to a plain
   * substring match if it is not valid regex. Synchronous: it reads the
   * in-memory buffer only and never touches the page.
   */
  network(filter?: string): string {
    let entries = this.networkLog;

    const pattern = typeof filter === "string" ? filter.trim() : "";
    if (pattern.length > 0) {
      let test: (url: string) => boolean;
      try {
        const regex = new RegExp(pattern, "i");
        test = (url) => regex.test(url);
      } catch {
        const needle = pattern.toLowerCase();
        test = (url) => url.toLowerCase().includes(needle);
      }
      entries = entries.filter((e) => test(e.url));
    }

    if (entries.length === 0) {
      return "(no captured network activity)";
    }

    const recent = entries.slice(-50);
    return recent
      .map((e) => `${e.method} ${e.url} -> ${e.status} (${e.resourceType})`)
      .join("\n");
  }
}
