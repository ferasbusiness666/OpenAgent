import { getConfig, type Config } from "../config/index.js";
import { CLIProvider } from "./cli.js";
import { APIProvider } from "./api.js";

/**
 * Uniform interface the agent loop programs against. Each turn it assembles one
 * full prompt string (system prompt + conversation history + JSON-format
 * instructions) and calls `complete`, expecting raw model text back.
 */
export interface Provider {
  readonly name: string;
  complete(prompt: string): Promise<string>;
}

export { CLIProvider } from "./cli.js";
export { APIProvider } from "./api.js";
export { KNOWN_CLIS, detectClis } from "./detector.js";

/**
 * Build the active provider from config. Reads config via getConfig() when one
 * is not supplied. Returns a CLIProvider in "cli" mode or an APIProvider in
 * "api" mode. Throws if cli mode is selected without an active CLI name.
 */
export function getProvider(config?: Config): Provider {
  const cfg = config ?? getConfig();

  if (cfg.providerMode === "cli") {
    if (cfg.activeCliName.trim().length === 0) {
      throw new Error(
        "Provider mode is 'cli' but no activeCliName is set in config. " +
          "Run setup to select a detected CLI, or switch to 'api' mode."
      );
    }
    return new CLIProvider(cfg.activeCliName);
  }

  return new APIProvider(cfg.apiKey, cfg.apiProvider);
}
