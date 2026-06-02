import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Resolve the project root from this module's location: src/config/index.ts -> ../../
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
export const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");

/**
 * Config schema. Empty defaults are used when config.json does not yet exist
 * so the setup wizard can detect an incomplete configuration and run.
 */
export const ConfigSchema = z.object({
  workspacePath: z.string().default("./workspace"),
  providerMode: z.enum(["cli", "api"]).default("cli"),
  activeCliName: z.string().default(""),
  apiKey: z.string().default(""),
  apiProvider: z.enum(["openai", "anthropic", "google"]).default("anthropic"),
  telegramToken: z.string().default(""),
  telegramChatId: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

const EMPTY_CONFIG: Config = ConfigSchema.parse({});

/**
 * Read config from config.json only (no environment overlay). If the file does
 * not exist, it is created with empty defaults. Malformed JSON or invalid
 * fields fall back to defaults rather than throwing, so the app can always boot.
 *
 * This is the value used as the merge base when saving, so secrets supplied via
 * environment variables are never written back into config.json.
 */
function readFileConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeJsonSync(CONFIG_PATH, EMPTY_CONFIG, { spaces: 2 });
    ensureWorkspace(EMPTY_CONFIG);
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
  const config = parsed.success ? parsed.data : { ...EMPTY_CONFIG };
  ensureWorkspace(config);
  return config;
}

/**
 * Overlay secrets from the environment so the Telegram token (and chat id) can
 * be supplied at runtime without ever living in a committed/persisted file.
 * Environment values always take precedence over config.json. This is the
 * recommended "connect it later" path after cloning the repo.
 */
function applyEnvOverrides(config: Config): Config {
  const result = { ...config };
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && token.trim().length > 0) {
    result.telegramToken = token.trim();
  }
  if (chatId && chatId.trim().length > 0) {
    result.telegramChatId = chatId.trim();
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
  const current = readFileConfig();
  const merged: Config = { ...current, ...partial };
  const validated = ConfigSchema.parse(merged);
  fs.writeJsonSync(CONFIG_PATH, validated, { spaces: 2 });
  ensureWorkspace(validated);
  return applyEnvOverrides(validated);
}

/**
 * Ensure the workspace folder exists. Resolves relative workspace paths
 * against the project root so the agent always has a real directory to use.
 */
export function ensureWorkspace(config: Config): string {
  const abs = resolveWorkspacePath(config);
  fs.ensureDirSync(abs);
  return abs;
}

/** Absolute path to the configured workspace folder. */
export function resolveWorkspacePath(config: Config): string {
  return path.isAbsolute(config.workspacePath)
    ? config.workspacePath
    : path.resolve(PROJECT_ROOT, config.workspacePath);
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
