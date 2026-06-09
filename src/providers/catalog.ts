/**
 * catalog.ts — the single source of truth for the hosted API providers Open
 * Agent can talk to directly with an API key (no local CLI required).
 *
 * Every layer reads from here: the APIProvider backend (default models), the
 * first-run wizard and the /provider switcher (menus + key hints), live
 * validation, and the config enum. Adding a provider is (almost) just a new
 * entry below plus its request wiring in api.ts and validate.ts.
 */

/** The hosted API providers selectable in `api` provider mode. */
export type ApiProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "openrouter";

/** Display + default metadata for one API provider. */
export interface ApiProviderMeta {
  /** The id stored in config (`apiProvider`). */
  id: ApiProviderName;
  /** Human-friendly menu label. */
  label: string;
  /** Model id used when the user has not set an explicit `activeModel`. */
  defaultModel: string;
  /** Where to obtain a key + which env var (shown as a hint in the UI/wizard). */
  keyHint: string;
}

/**
 * Ordered provider catalog. API-key providers are the primary way to run Open
 * Agent, so this list drives the wizard and the /provider menu directly.
 *
 * Default models verified against each provider's docs:
 *  - groq: OpenAI-compatible at api.groq.com; llama-3.3-70b-versatile is the
 *    general-purpose production default (also: llama-3.1-8b-instant,
 *    openai/gpt-oss-120b/20b, meta-llama/llama-4-scout-17b-16e-instruct).
 *  - google: AI Studio Gemini API; gemini-2.0-flash is a stable default.
 *  - openrouter: OpenAI-compatible aggregator; model ids are namespaced.
 */
export const API_PROVIDERS: readonly ApiProviderMeta[] = [
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o",
    keyHint: "platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-4-20250514",
    keyHint: "console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    label: "Google AI Studio (Gemini)",
    defaultModel: "gemini-2.0-flash",
    keyHint: "aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    keyHint: "console.groq.com/keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "openai/gpt-4o",
    keyHint: "openrouter.ai/keys",
  },
];

/** Just the provider ids, in catalog order. */
export const API_PROVIDER_IDS: readonly ApiProviderName[] = API_PROVIDERS.map(
  (p) => p.id,
);

/** The default model for a provider, or "" if somehow unknown. */
export function defaultModelFor(id: ApiProviderName): string {
  return API_PROVIDERS.find((p) => p.id === id)?.defaultModel ?? "";
}

/** Look up the full metadata for a provider id. */
export function providerMeta(id: ApiProviderName): ApiProviderMeta | undefined {
  return API_PROVIDERS.find((p) => p.id === id);
}

/** Runtime guard that narrows an arbitrary string to an ApiProviderName. */
export function isApiProviderName(value: string): value is ApiProviderName {
  return (API_PROVIDER_IDS as readonly string[]).includes(value);
}
