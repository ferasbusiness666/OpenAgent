/**
 * messages.ts — the request shape every provider is programmed against.
 *
 * Phase A (context engineering): instead of rebuilding one giant prompt string
 * each turn, the loop sends a STABLE system prefix plus a role-tagged message
 * array. Keeping `system` (identity + tool reference + memory + format rules)
 * byte-for-byte stable across turns is what lets us hit each provider's prompt
 * cache — Anthropic `cache_control`, OpenAI/Groq automatic prefix caching,
 * Gemini `systemInstruction` — which is the single biggest latency/cost win and
 * the architecture Manus is built around.
 *
 * Volatile content (the current time, the recited plan/TODO) deliberately lives
 * in the LAST user message, never in `system`, so the cache prefix stays stable
 * and the goal stays in recent attention (recitation).
 */

/** Conversation roles. Tool observations are folded into `user` messages by the
 *  planner, so providers only ever see `user` / `assistant`. */
export type ChatRole = "user" | "assistant";

/** A base64-encoded image attached to a message (vision). */
export interface ImageData {
  /** Base64 image bytes, WITHOUT a `data:` prefix. */
  data: string;
  /** MIME type, e.g. "image/png". */
  mediaType: string;
}

/**
 * One message in the conversation. `content` is always plain text (kept a
 * string so history/merge/CLI text paths never change). `images` is an optional
 * vision attachment — usually only the latest user turn carries one (a
 * screenshot the agent just took). Vision-capable providers encode these
 * natively; text-only providers ignore them.
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  images?: ImageData[];
}

/** A tool the model may call (function calling). `parameters` is JSON Schema
 *  for the arguments object. Providers translate this to their native format. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A single tool call the model emitted this turn. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Token usage reported by an API provider for one call. Field names are
 * normalized across providers (Anthropic input/output_tokens, OpenAI
 * prompt/completion_tokens, Gemini promptTokenCount/candidatesTokenCount).
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (when reported). */
  cacheReadTokens?: number;
}

/**
 * Structured model output: any free text the model produced plus the tool calls
 * it made (empty when it just replied with text — e.g. planning/reflection,
 * which pass no tools). Native function-calling fills `toolCalls` directly; the
 * CLI provider parses its JSON reply into the same shape.
 */
export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  /** Per-call token usage. API providers fill this from the response's usage
   *  metadata; absent for CLI providers, which report nothing. */
  usage?: TokenUsage;
}

/** A single provider turn: a cacheable system prefix + the running history. */
export interface GenerateRequest {
  /** STABLE, cacheable prefix. Must not change across turns of one session. */
  system: string;
  /** Role-tagged history, alternating user/assistant, starting with `user`.
   *  The final message is the current turn (carrying time + recited plan). */
  messages: ChatMessage[];
  /** When present, the provider offers these as native tools (function calling)
   *  for THIS turn. History stays plain text; only the current action is
   *  structured. Absent for plain-text turns (planning, self-check). */
  tools?: ToolSchema[];
}
