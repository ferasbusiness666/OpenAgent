import { getConfig, type Config } from "../config/index.js";
import { CLIProvider } from "./cli.js";
import { APIProvider } from "./api.js";
import type { GenerateRequest, GenerateResult } from "./messages.js";

/**
 * Uniform interface the agent loop programs against. Each turn it assembles a
 * {@link GenerateRequest} — a stable, cacheable `system` prefix plus the
 * role-tagged message history — and calls `generate`, expecting raw model text
 * back (the JSON action object, which the loop parses).
 *
 * API providers send the system prefix in a way their prompt cache can reuse;
 * CLI providers flatten the request back into a single text prompt.
 */
export interface Provider {
  readonly name: string;
  /** Whether this provider can accept image content (vision). API providers are
   *  true; CLI providers (text-only stdout) are false. The loop only attaches
   *  screenshots when this is true and vision is enabled in config. */
  readonly supportsVision: boolean;
  /** Generate the next turn. When `request.tools` is set, API providers use
   *  native function-calling and return structured `toolCalls`; otherwise they
   *  return text only (planning / self-check). */
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export type {
  ChatRole,
  ChatMessage,
  ImageData,
  ToolSchema,
  ToolCall,
  GenerateResult,
  GenerateRequest,
} from "./messages.js";
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
    return new CLIProvider(cfg.activeCliName, cfg.activeModel);
  }

  return new APIProvider(cfg.apiKey, cfg.apiProvider, cfg.activeModel);
}

/**
 * IMP-18: build the optional FAST provider for model routing — a cheaper/faster
 * model used for simple action steps while the configured (smart) model handles
 * planning, verification, and reasoning. Returns undefined when routing is off:
 * `fastModel` is empty, equals `activeModel`, or the provider is CLI mode (one
 * CLI, nothing to route to). Same provider/key as the main one, different model.
 */
export function getFastProvider(config?: Config): Provider | undefined {
  const cfg = config ?? getConfig();
  if (cfg.providerMode !== "api") {
    return undefined;
  }
  const fast = cfg.fastModel.trim();
  if (fast.length === 0 || fast === cfg.activeModel.trim()) {
    return undefined;
  }
  return new APIProvider(cfg.apiKey, cfg.apiProvider, fast);
}
