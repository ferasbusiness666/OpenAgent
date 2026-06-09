import path from "node:path";
import fs from "fs-extra";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { getConfig, resolveWorkspacePath } from "../config/index.js";

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
  private page: Page | null = null;

  /** Ensure a live browser + page exist, launching them if necessary. */
  private async ensurePage(): Promise<Page> {
    if (this.browser === null || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
      this.page = null;
    }
    if (this.page === null || this.page.isClosed()) {
      this.page = await this.browser.newPage();
    }
    return this.page;
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
    this.page = null;
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

  /** Navigate to a URL and return the resulting page title. */
  async navigate(url: string): Promise<string> {
    if (typeof url !== "string" || url.trim().length === 0) {
      throw new Error("navigate requires a non-empty url.");
    }
    return await this.withRetry("navigate", async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
    this.page = null;
  }
}
