/**
 * wire-types.ts — the on-the-wire request/response shapes for the hosted
 * providers, extracted from api.ts (IMP-34) so that file holds the request
 * logic and these declarations live on their own.
 *
 * Each provider sends message content differently (Anthropic/OpenAI take a
 * string OR a block array when images are attached; Gemini takes `parts`), and
 * returns text/tool-calls/usage in its own shape. These interfaces describe
 * ONLY the fields api.ts reads — provider responses carry much more.
 */

// ── Request content shapes ────────────────────────────────────────────────

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type AnthropicContent = string | Array<AnthropicTextBlock | AnthropicImageBlock>;

export interface OpenAITextPart {
  type: "text";
  text: string;
}
export interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}
export type OpenAIContent = string | Array<OpenAITextPart | OpenAIImagePart>;

export interface GeminiTextPart {
  text: string;
}
export interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}
export type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

// ── Response shapes (only the fields we read) ─────────────────────────────

export interface AnthropicResponseBlock {
  type?: string;
  /** Present on `text` blocks. */
  text?: string;
  /** Present on `tool_use` blocks — the tool's declared name. */
  name?: string;
  /** Present on `tool_use` blocks — the parsed argument object. */
  input?: Record<string, unknown>;
}
/** Anthropic usage block. Cache writes (`cache_creation_input_tokens`) are
 *  billed as input, so api.ts folds them into `inputTokens`. */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export interface AnthropicResponse {
  content?: AnthropicResponseBlock[];
  usage?: AnthropicUsage;
}

export interface OpenAIToolCall {
  function?: { name?: string; arguments?: string };
}
export interface OpenAIResponseMessage {
  content?: string;
  tool_calls?: OpenAIToolCall[];
}
export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}
export interface OpenAIResponse {
  choices?: Array<{ message?: OpenAIResponseMessage }>;
  usage?: OpenAIUsage;
}

export interface GoogleFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}
export interface GooglePart {
  text?: string;
  functionCall?: GoogleFunctionCall;
}
export interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}
export interface GoogleResponse {
  candidates?: Array<{
    content?: { parts?: GooglePart[] };
  }>;
  usageMetadata?: GoogleUsageMetadata;
}
