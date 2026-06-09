import fs from "fs-extra";
import path from "node:path";
import { z } from "zod";
import { CONFIG_PATH, ensureDataDir } from "../paths.js";

export { CONFIG_PATH } from "../paths.js";

/**
 * Config schema. Empty defaults are used when config.json does not yet exist so
 * the setup wizard can detect an incomplete configuration and run.
 *
 * `workspacePath` defaults to "" — the agent's working directory is normally the
 * directory it was launched in (see the active-workspace helpers below). A
 * non-empty value is an explicit override the user can set from /settings.
 */
export const ConfigSchema = z.object({
  workspacePath: z.string().default(""),
  providerMode: z.enum(["cli", "api"]).default("api"),
  activeCliName: z.string().default(""),
  apiKey: z.string().default(""),
  apiProvider: z.enum(["openai", "anthropic", "google", "groq", "openrouter"]).default("anthropic"),
  activeModel: z.string().default(""),
  telegramToken: z.string().default(""),
  telegramChatId: z.string().default(""),
  // API key for the Tavily web-research backend (https://tavily.com). Also
  // readable from the TAVILY_API_KEY environment variable, which takes
  // precedence so the secret need never live in a file.
  tavilyApiKey: z.string().default(""),
  // First-run onboarding (the 7-step guided intro). Set true once the user
  // completes or skips it so it never reappears; reset it from /settings (or
  // run /onboarding) to see it again.
  onboardingCompleted: z.boolean().default(false),
  // Permission preferences chosen during onboarding (Step 6) and editable in
  // /settings. readFiles is informational (reads are always allowed);
  // suggestEdits gates filesystem write/delete/mkdir; requireCommandApproval
  // pauses shell commands for approve/deny in the interactive TUI (a headless
  // --task run, which has no one to ask, always proceeds).
  permReadFiles: z.boolean().default(true),
  permSuggestEdits: z.boolean().default(true),
  requireCommandApproval: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

const EMPTY_CONFIG: Config = ConfigSchema.parse({});

// ---- Active workspace ------------------------------------------------------
//
// The agent's working directory ("workspace") is the directory it was launched
// in (process.cwd()). When a project is opened we point it at that project's
// directory — which, in the normal launch flow, is the same cwd. /settings can
// override it for the current session. All tool operations resolve against this.

let activeWorkspace = process.cwd();

/** Absolute path of the directory the agent's tools currently operate in. */
export function getActiveWorkspace(): string {
  return activeWorkspace;
}

/**
 * Point the active workspace at `dir` (resolved to an absolute path). An empty
 * value resets it to the launch directory (process.cwd()).
 */
export function setActiveWorkspace(dir: string): void {
  const trimmed = typeof dir === "string" ? dir.trim() : "";
  activeWorkspace = trimmed.length > 0 ? path.resolve(trimmed) : process.cwd();
}

/**
 * Read config from config.json only (no environment overlay). If the file does
 * not exist, it is created with empty defaults. Malformed JSON or invalid
 * fields fall back to defaults rather than throwing, so the app can always boot.
 *
 * This is the value used as the merge base when saving, so secrets supplied via
 * environment variables are never written back into config.json.
 */
function readFileConfig(): Config {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeJsonSync(CONFIG_PATH, EMPTY_CONFIG, { spaces: 2 });
    return { ...EMPTY_CONFIG };
  }

  let raw: unknown;
  try {
    raw = fs.readJsonSync(CONFIG_PATH);
  } catch {
    // Corrupt file — reset to empty defaults.
    fs.writeJsonSync(CONFIG_PATH, EMPTY_CONFIG, { spaces: 2 });
    return { ...EMPTY_CONFIG };
  }

  const parsed = ConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...EMPTY_CONFIG };
}

/**
 * Overlay secrets from the environment so the Telegram token (and chat id) can
 * be supplied at runtime without ever living in a committed/persisted file.
 * Environment values always take precedence over config.json.
 */
function applyEnvOverrides(config: Config): Config {
  const result = { ...config };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const tavily = process.env.TAVILY_API_KEY;
  if (token && token.trim().length > 0) {
    result.telegramToken = token.trim();
  }
  if (chatId && chatId.trim().length > 0) {
    result.telegramChatId = chatId.trim();
  }
  if (tavily && tavily.trim().length > 0) {
    result.tavilyApiKey = tavily.trim();
  }
  return result;
}

/**
 * Read the effective config: config.json with environment overrides applied.
 * Read on every load so external edits / env changes are always picked up.
 */
export function getConfig(): Config {
  return applyEnvOverrides(readFileConfig());
}

/**
 * Merge a partial config into the on-disk config and persist it. The merge base
 * is the FILE config (not the env-overlaid one), so an env-supplied Telegram
 * token is never written to disk. Returns the effective (env-overlaid) config.
 */
export function saveConfig(partial: Partial<Config>): Config {
  ensureDataDir();
  const current = readFileConfig();
  const merged: Config = { ...current, ...partial };
  const validated = ConfigSchema.parse(merged);
  fs.writeJsonSync(CONFIG_PATH, validated, { spaces: 2 });
  return applyEnvOverrides(validated);
}

/**
 * Resolve the directory the agent works in. With the workspace-as-cwd model the
 * active workspace is authoritative; the config arg is accepted for backward
 * compatibility but no longer changes the result.
 */
export function resolveWorkspacePath(_config?: Config): string {
  return activeWorkspace;
}

/**
 * Ensure the active workspace directory exists and return it. The launch
 * directory always exists, so this is normally a no-op; it stays defensive for
 * an explicit /settings override that points somewhere new.
 */
export function ensureWorkspace(_config?: Config): string {
  try {
    fs.ensureDirSync(activeWorkspace);
  } catch {
    // The directory should already exist (it's where we were launched).
  }
  return activeWorkspace;
}

/**
 * A config is "complete" when the agent has a working provider:
 * either a CLI name (cli mode) or an API key (api mode).
 */
export function isConfigComplete(config: Config): boolean {
  if (config.providerMode === "cli") {
    return config.activeCliName.trim().length > 0;
  }
  if (config.providerMode === "api") {
    return config.apiKey.trim().length > 0;
  }
  return false;
}
