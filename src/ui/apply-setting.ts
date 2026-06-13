/**
 * apply-setting.ts — translate raw string edits from the /settings UI into a
 * validated Partial<Config> (IMP-34, extracted from App.tsx).
 *
 * The settings screen hands every field back as a string; this maps each known
 * key to its typed config field, validating the enum and boolean/number fields
 * and returning a human-readable error for an invalid value. Unknown keys are
 * ignored. saveConfig() re-validates the whole merged config afterwards, so
 * this is the first (field-level) of two validation layers.
 */

import type { Config } from "../config/index.js";
import { isApiProviderName, API_PROVIDER_IDS } from "../providers/catalog.js";

/** Parse a "true"/"false" string, or return an error message for `field`. */
function asBool(field: string, value: string): boolean | { error: string } {
  if (value !== "true" && value !== "false") {
    return { error: `${field} must be 'true' or 'false'.` };
  }
  return value === "true";
}

/**
 * Build a type-safe Partial<Config> from raw string edits, validating enum,
 * boolean, and numeric fields. Unknown keys are ignored. Returns an error
 * string for an invalid value.
 */
export function buildPartial(
  raw: Record<string, string>,
): Partial<Config> | { error: string } {
  const partial: Partial<Config> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "workspacePath":
        partial.workspacePath = value;
        break;
      case "activeCliName":
        partial.activeCliName = value;
        break;
      case "apiKey":
        partial.apiKey = value;
        break;
      case "activeModel":
        partial.activeModel = value;
        break;
      case "fastModel":
        partial.fastModel = value;
        break;
      case "telegramToken":
        partial.telegramToken = value;
        break;
      case "telegramChatId":
        partial.telegramChatId = value;
        break;
      case "tavilyApiKey":
        partial.tavilyApiKey = value;
        break;
      case "providerMode":
        if (value !== "cli" && value !== "api") {
          return { error: "providerMode must be 'cli' or 'api'." };
        }
        partial.providerMode = value;
        break;
      case "apiProvider":
        if (!isApiProviderName(value)) {
          return { error: "apiProvider must be one of: " + API_PROVIDER_IDS.join(", ") };
        }
        partial.apiProvider = value;
        break;
      case "onboardingCompleted": {
        const b = asBool("onboardingCompleted", value);
        if (typeof b !== "boolean") return b;
        partial.onboardingCompleted = b;
        break;
      }
      case "permReadFiles": {
        const b = asBool("permReadFiles", value);
        if (typeof b !== "boolean") return b;
        partial.permReadFiles = b;
        break;
      }
      case "permSuggestEdits": {
        const b = asBool("permSuggestEdits", value);
        if (typeof b !== "boolean") return b;
        partial.permSuggestEdits = b;
        break;
      }
      case "requireCommandApproval": {
        const b = asBool("requireCommandApproval", value);
        if (typeof b !== "boolean") return b;
        partial.requireCommandApproval = b;
        break;
      }
      case "enableVision": {
        const b = asBool("enableVision", value);
        if (typeof b !== "boolean") return b;
        partial.enableVision = b;
        break;
      }
      case "enableReflection": {
        const b = asBool("enableReflection", value);
        if (typeof b !== "boolean") return b;
        partial.enableReflection = b;
        break;
      }
      case "allowLocalNetworkAccess": {
        const b = asBool("allowLocalNetworkAccess", value);
        if (typeof b !== "boolean") return b;
        partial.allowLocalNetworkAccess = b;
        break;
      }
      case "budgetUsd": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return { error: "budgetUsd must be a number ≥ 0 (0 disables the budget)." };
        partial.budgetUsd = n;
        break;
      }
      default:
        // Ignore unknown keys.
        break;
    }
  }
  return partial;
}
