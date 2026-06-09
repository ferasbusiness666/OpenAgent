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

/** A single provider turn: a cacheable system prefix + the running history. */
export interface GenerateRequest {
  /** STABLE, cacheable prefix. Must not change across turns of one session. */
  system: string;
  /** Role-tagged history, alternating user/assistant, starting with `user`.
   *  The final message is the current turn (carrying time + recited plan). */
  messages: ChatMessage[];
}
