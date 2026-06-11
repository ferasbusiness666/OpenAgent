/**
 * health.ts — pre-task health check (IMP-25).
 *
 * Before the user invests time in a task, verify that every configured
 * component actually works: the provider is reachable and authenticated, the
 * workspace is writable, the browser is installed, and Telegram (when set up)
 * accepts its token. Run with `openagent --health-check`, which prints the
 * report and exits with a pass/fail code.
 *
 * Items are split into REQUIRED (the agent cannot work without them) and
 * OPTIONAL (a degraded capability, reported but not fatal): the overall verdict
 * is the conjunction of the required items only.
 */

import path from "node:path";
import { randomBytes } from "node:crypto";
import fs from "fs-extra";
import { getConfig, getActiveWorkspace, isConfigComplete } from "./config/index.js";
import { validateApiKey, validateTelegramToken } from "./config/validate.js";
import { detectClis } from "./providers/detector.js";
import { isBrowserAvailable, BROWSER_UNAVAILABLE_MESSAGE } from "./tools/browser.js";

export type HealthSeverity = "required" | "optional";

export interface HealthCheckItem {
  name: string;
  ok: boolean;
  severity: HealthSeverity;
  detail: string;
}

export interface HealthReport {
  /** True when every REQUIRED item passed. */
  ok: boolean;
  items: HealthCheckItem[];
}

/** Workspace probe: create, read back, and delete a temp file. */
function checkWorkspaceWritable(): HealthCheckItem {
  const workspace = getActiveWorkspace();
  const probe = path.join(
    workspace,
    `.openagent-health-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(probe, "ok");
    const read = fs.readFileSync(probe, "utf8");
    if (read !== "ok") {
      return {
        name: "Workspace write access",
        ok: false,
        severity: "required",
        detail: `wrote a probe file in ${workspace} but read different content back`,
      };
    }
    return {
      name: "Workspace write access",
      ok: true,
      severity: "required",
      detail: `${workspace} is writable`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name: "Workspace write access",
      ok: false,
      severity: "required",
      detail: `cannot write in ${workspace}: ${detail}`,
    };
  } finally {
    try {
      fs.removeSync(probe);
    } catch {
      // Probe cleanup is best-effort; a leftover file is harmless.
    }
  }
}

/** Provider connectivity: live key validation (api) or PATH lookup (cli). */
async function checkProvider(skip: boolean): Promise<HealthCheckItem> {
  const config = getConfig();
  const label =
    config.providerMode === "api"
      ? `Provider (api:${config.apiProvider})`
      : `Provider (cli:${config.activeCliName || "none"})`;
  if (skip) {
    return { name: label, ok: true, severity: "required", detail: "skipped" };
  }
  try {
    if (config.providerMode === "api") {
      const result = await validateApiKey(config.apiProvider, config.apiKey, config.activeModel);
      return { name: label, ok: result.ok, severity: "required", detail: result.message };
    }
    const cli = config.activeCliName.trim();
    if (cli.length === 0) {
      return { name: label, ok: false, severity: "required", detail: "no CLI configured" };
    }
    const found = detectClis().includes(cli);
    return {
      name: label,
      ok: found,
      severity: "required",
      detail: found ? `"${cli}" found on PATH` : `"${cli}" is not on PATH`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { name: label, ok: false, severity: "required", detail };
  }
}

/** Telegram token check via getMe — only when a token is configured. */
async function checkTelegram(): Promise<HealthCheckItem> {
  const token = getConfig().telegramToken.trim();
  if (token.length === 0) {
    return { name: "Telegram", ok: true, severity: "optional", detail: "not configured" };
  }
  try {
    const result = await validateTelegramToken(token);
    return { name: "Telegram", ok: result.ok, severity: "optional", detail: result.message };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { name: "Telegram", ok: false, severity: "optional", detail };
  }
}

/**
 * Run every health check. Never throws — each check converts its own errors
 * into a failed item. `skipProvider` avoids the live network call (used by the
 * offline verify script).
 */
export async function runHealthCheck(options?: {
  skipProvider?: boolean;
}): Promise<HealthReport> {
  const config = getConfig();
  const items: HealthCheckItem[] = [];

  // 1. Config completeness.
  const complete = isConfigComplete(config);
  items.push({
    name: "Config",
    ok: complete,
    severity: "required",
    detail: complete
      ? `provider mode "${config.providerMode}" is configured`
      : "no provider configured yet — run openagent once interactively to complete setup",
  });

  // 2. Provider connectivity.
  items.push(await checkProvider(options?.skipProvider === true));

  // 3. Workspace write access.
  items.push(checkWorkspaceWritable());

  // 4. Browser (optional capability).
  const browserOk = isBrowserAvailable();
  items.push({
    name: "Browser (Playwright Chromium)",
    ok: browserOk,
    severity: "optional",
    detail: browserOk ? "Chromium installed" : BROWSER_UNAVAILABLE_MESSAGE,
  });

  // 5. Telegram (optional, only when configured).
  items.push(await checkTelegram());

  // 6. Tavily web research (optional).
  const tavily = config.tavilyApiKey.trim().length > 0;
  items.push({
    name: "Tavily (web research)",
    ok: tavily,
    severity: "optional",
    detail: tavily ? "configured" : "not configured — research tool disabled",
  });

  const ok = items.every((item) => item.severity !== "required" || item.ok);
  return { ok, items };
}

/** Render a report as printable ✅/❌ lines plus a final verdict line. */
export function formatHealthReport(report: HealthReport): string {
  const lines = report.items.map(
    (item) =>
      `${item.ok ? "✅" : "❌"} ${item.name} — ${item.detail}` +
      (item.severity === "optional" ? " (optional)" : ""),
  );
  const failingRequired = report.items.filter(
    (item) => item.severity === "required" && !item.ok,
  ).length;
  lines.push(
    report.ok
      ? "Health check PASSED"
      : `Health check FAILED (${failingRequired} required check(s) failing)`,
  );
  return lines.join("\n");
}
