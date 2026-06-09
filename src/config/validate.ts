/**
 * Live validation for settings the user can edit, used by /settings (and the
 * provider switcher) to verify values BEFORE they are written to config.json:
 *   - API key   → a real request to the provider; 401/403 means an invalid key.
 *   - Telegram  → getMe; returns the bot's name when the token is valid.
 *   - Workspace → the directory exists and is writable.
 *
 * Each validator returns a structured result; the UI shows ✅/❌ and only saves
 * when ok is true. Network/transport errors are reported but, for API keys, are
 * NOT treated as "invalid key" (only a clear auth rejection is) so a flaky
 * connection can't lock a user out of saving a correct key.
 */

import path from "node:path";
import { randomBytes } from "node:crypto";
import fs from "fs-extra";
import type { ApiProviderName } from "../providers/api.js";

export interface ValidationResult {
  ok: boolean;
  message: string;
}

const VALIDATION_TIMEOUT_MS = 15_000;

/** fetch with an abort-based timeout so a hung endpoint never blocks the UI. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Validate an API key by listing models (a cheap, side-effect-free request). */
export async function validateApiKey(
  provider: ApiProviderName,
  apiKey: string,
  model: string,
): Promise<ValidationResult> {
  const key = apiKey.trim();
  if (key.length === 0) {
    return { ok: false, message: "API key is empty." };
  }
  const modelNote = model.trim().length > 0 ? ` (model: ${model.trim()})` : "";
  try {
    let response: Response;
    if (provider === "anthropic") {
      response = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
    } else if (provider === "openai") {
      response = await fetchWithTimeout("https://api.openai.com/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      });
    } else if (provider === "openrouter") {
      response = await fetchWithTimeout("https://openrouter.ai/api/v1/auth/key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://github.com/ferasbusiness666/OpenAgent",
          "X-Title": "OpenAgent",
        },
      });
    } else if (provider === "groq") {
      // Groq is OpenAI-compatible; listing models is a cheap auth check.
      response = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      });
    } else if (provider === "google") {
      // Header auth matches the request wiring in api.ts (x-goog-api-key).
      response = await fetchWithTimeout(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { method: "GET", headers: { "x-goog-api-key": key } },
      );
    } else {
      // Unreachable for the typed union, but keeps the chain total without a
      // dangling else that TypeScript would treat as `never`.
      return { ok: false, message: `Unknown provider: ${provider}` };
    }

    if (response.ok) {
      return { ok: true, message: `✅ ${provider} key valid${modelNote}.` };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `❌ Invalid ${provider} API key (HTTP ${response.status}).` };
    }
    // Any other status means the key authenticated but something else is off
    // (rate limit, bad model, etc.) — don't block saving a working key.
    return {
      ok: true,
      message: `✅ ${provider} key accepted (server returned HTTP ${response.status})${modelNote}.`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Could not reach the provider — allow the save but flag it.
    return { ok: true, message: `⚠ Could not reach ${provider} to verify the key (${detail}). Saved anyway.` };
  }
}

interface TelegramGetMe {
  ok?: boolean;
  result?: { username?: string; first_name?: string };
  description?: string;
}

/** Validate a Telegram bot token via getMe; returns the bot's name on success. */
export async function validateTelegramToken(token: string): Promise<ValidationResult> {
  const t = token.trim();
  if (t.length === 0) {
    return { ok: false, message: "Telegram token is empty." };
  }
  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${encodeURIComponent(t)}/getMe`,
      { method: "GET" },
    );
    const data = (await response.json()) as TelegramGetMe;
    if (response.ok && data.ok && data.result) {
      const name = data.result.username
        ? `@${data.result.username}`
        : data.result.first_name ?? "your bot";
      return { ok: true, message: `✅ Telegram token valid — bot ${name}.` };
    }
    return {
      ok: false,
      message: `❌ Invalid Telegram token${data.description ? `: ${data.description}` : "."}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `❌ Could not verify Telegram token (${detail}).` };
  }
}

/** Validate that a workspace path exists, is a directory, and is writable. */
export function validateWorkspacePath(workspacePath: string): ValidationResult {
  const p = workspacePath.trim();
  if (p.length === 0) {
    // Empty = use the launch directory (cwd); always acceptable.
    return { ok: true, message: "Using the launch directory (cwd) as the workspace." };
  }
  const abs = path.resolve(p);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, message: `❌ Path does not exist: ${abs}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, message: `❌ Not a directory: ${abs}` };
  }
  // Probe writability by creating and removing a temp file.
  const probe = path.join(abs, `.openagent-write-test-${randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(probe, "");
    fs.removeSync(probe);
  } catch {
    return { ok: false, message: `❌ Directory is not writable: ${abs}` };
  }
  return { ok: true, message: `✅ Workspace OK: ${abs}` };
}
