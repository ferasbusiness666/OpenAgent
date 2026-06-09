import type { Provider } from "./index.js";
import type { ApiProviderName } from "./catalog.js";
import { defaultModelFor } from "./catalog.js";
import type { GenerateRequest, ChatMessage } from "./messages.js";

export type { ApiProviderName } from "./catalog.js";

/**
 * Wire shapes for the per-provider message `content` / `parts` fields. When a
 * message carries images we send a block array in the provider's native vision
 * format; otherwise we send the plain string (Anthropic/OpenAI) or a single
 * text part (Gemini) exactly as before.
 */
interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
type AnthropicContent = string | Array<AnthropicTextBlock | AnthropicImageBlock>;

interface OpenAITextPart {
  type: "text";
  text: string;
}
interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}
type OpenAIContent = string | Array<OpenAITextPart | OpenAIImagePart>;

interface GeminiTextPart {
  text: string;
}
interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}
type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

/** Minimal shapes of the response payloads we read from each provider. */
interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface GoogleResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/**
 * Calls a hosted chat/completions API with a cacheable system prefix plus the
 * role-tagged history and returns the assistant's text. The agent loop assembles
 * the {@link GenerateRequest} — a stable `system` prefix (identity + tool
 * reference + memory + format rules) and the running `messages` — so each
 * provider can route the prefix through its prompt cache: Anthropic via an
 * explicit `cache_control` breakpoint, OpenAI/Groq/OpenRouter via automatic
 * prefix caching (which works precisely because the prefix is now stable), and
 * Gemini via `systemInstruction`.
 */
export class APIProvider implements Provider {
  /** Hosted API models are vision-capable, so the loop may attach images. */
  readonly supportsVision = true;

  private readonly apiKey: string;
  private readonly apiProvider: ApiProviderName;
  private readonly model: string;

  constructor(apiKey: string, apiProvider: ApiProviderName, model = "") {
    this.apiKey = apiKey;
    this.apiProvider = apiProvider;
    this.model = model;
  }

  get name(): string {
    return this.model
      ? `api:${this.apiProvider} (${this.model})`
      : `api:${this.apiProvider}`;
  }

  async generate(request: GenerateRequest): Promise<string> {
    switch (this.apiProvider) {
      case "anthropic":
        return this.completeAnthropic(request);
      case "openai":
        return this.completeOpenAI(request);
      case "google":
        return this.completeGoogle(request);
      case "openrouter":
        return this.completeOpenRouter(request);
      case "groq":
        return this.completeGroq(request);
      default: {
        // Exhaustiveness guard — unreachable under the typed union.
        const never: never = this.apiProvider;
        throw new Error(`Unsupported API provider: ${String(never)}`);
      }
    }
  }

  /**
   * Collapses consecutive same-role messages into one (joining content with a
   * blank line) so the array strictly alternates user/assistant. Anthropic and
   * Gemini both reject non-alternating roles; the loop already alternates, so
   * this is a defensive guard rather than a reshape. Merging also concatenates
   * any attached `images` so vision payloads survive the collapse.
   */
  private mergeAlternating(messages: ChatMessage[]): ChatMessage[] {
    const merged: ChatMessage[] = [];
    for (const message of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === message.role) {
        last.content = `${last.content}\n\n${message.content}`;
        const images = [...(last.images ?? []), ...(message.images ?? [])];
        if (images.length > 0) {
          last.images = images;
        }
      } else {
        const next: ChatMessage = { role: message.role, content: message.content };
        if (message.images && message.images.length > 0) {
          next.images = [...message.images];
        }
        merged.push(next);
      }
    }
    return merged;
  }

  /**
   * Builds an Anthropic message `content`: a plain string when there are no
   * images, or a `[text, ...image]` block array when there are.
   */
  private anthropicContent(message: ChatMessage): AnthropicContent {
    if (!message.images || message.images.length === 0) {
      return message.content;
    }
    return [
      { type: "text", text: message.content },
      ...message.images.map(
        (img): AnthropicImageBlock => ({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.data,
          },
        })
      ),
    ];
  }

  /**
   * Builds an OpenAI-compatible message `content`: a plain string when there
   * are no images, or a `[text, ...image_url]` part array when there are. The
   * image is inlined as a `data:` URI, which OpenAI/Groq/OpenRouter accept.
   */
  private openAIContent(message: ChatMessage): OpenAIContent {
    if (!message.images || message.images.length === 0) {
      return message.content;
    }
    return [
      { type: "text", text: message.content },
      ...message.images.map(
        (img): OpenAIImagePart => ({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        })
      ),
    ];
  }

  /**
   * Builds Gemini message `parts`: a single text part when there are no images,
   * or a `[text, ...inlineData]` part array when there are.
   */
  private geminiParts(message: ChatMessage): GeminiPart[] {
    if (!message.images || message.images.length === 0) {
      return [{ text: message.content }];
    }
    return [
      { text: message.content },
      ...message.images.map(
        (img): GeminiInlineDataPart => ({
          inlineData: { mimeType: img.mediaType, data: img.data },
        })
      ),
    ];
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `API request to ${this.name} failed with status ${response.status} ${response.statusText}: ${text}`
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `API request to ${this.name} returned non-JSON body: ${text}`
      );
    }
  }

  private async completeAnthropic(request: GenerateRequest): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        // Enables prompt caching so the system block below is reused across turns.
        "anthropic-beta": "prompt-caching-2024-07-31",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model.trim() || defaultModelFor("anthropic"),
        max_tokens: 4096,
        // System sent as a content-block array with an ephemeral cache breakpoint
        // so the stable prefix is cached and reused on subsequent turns.
        system: [
          {
            type: "text",
            text: request.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        // Merge consecutive same-role messages — Anthropic rejects non-alternating
        // roles. Roles are already "user"/"assistant" from the request. Images,
        // if present, are encoded as native image blocks alongside the text.
        messages: this.mergeAlternating(request.messages).map((m) => ({
          role: m.role,
          content: this.anthropicContent(m),
        })),
      }),
    });

    const data = (await this.readJson(response)) as AnthropicResponse;
    const block = data.content?.find(
      (item) => typeof item.text === "string"
    );
    const text = block?.text;
    if (typeof text !== "string") {
      throw new Error(
        `Anthropic response missing content text: ${JSON.stringify(data)}`
      );
    }
    return text;
  }

  /**
   * Shared implementation for OpenAI-compatible chat completions endpoints
   * (OpenAI, Groq, OpenRouter). They share request/response format and differ
   * only in URL, optional extra headers, and the default model id.
   *
   * The system prefix is prepended as a `system` message; no explicit cache
   * flags are needed because these providers do AUTOMATIC prefix caching, which
   * pays off precisely because the system message + early history are stable.
   */
  private async completeOpenAICompatible(
    request: GenerateRequest,
    options: {
      url: string;
      extraHeaders?: Record<string, string>;
      defaultModel: string;
    }
  ): Promise<string> {
    const { url, extraHeaders = {}, defaultModel } = options;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: this.model.trim() || defaultModel,
        messages: [
          { role: "system", content: request.system },
          // Per message: plain string content, or a text+image_url part array
          // when the message carries images.
          ...request.messages.map((m) => ({
            role: m.role,
            content: this.openAIContent(m),
          })),
        ],
      }),
    });

    const data = (await this.readJson(response)) as OpenAIResponse;
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error(
        `${url} response missing choices[0].message.content: ${JSON.stringify(data)}`
      );
    }
    return text;
  }

  private async completeOpenAI(request: GenerateRequest): Promise<string> {
    return this.completeOpenAICompatible(request, {
      url: "https://api.openai.com/v1/chat/completions",
      defaultModel: defaultModelFor("openai"),
    });
  }

  /** Groq's OpenAI-compatible chat completions endpoint (no extra headers). */
  private async completeGroq(request: GenerateRequest): Promise<string> {
    return this.completeOpenAICompatible(request, {
      url: "https://api.groq.com/openai/v1/chat/completions",
      defaultModel: defaultModelFor("groq"),
    });
  }

  private async completeOpenRouter(request: GenerateRequest): Promise<string> {
    return this.completeOpenAICompatible(request, {
      url: "https://openrouter.ai/api/v1/chat/completions",
      extraHeaders: {
        "HTTP-Referer": "https://github.com/ferasbusiness666/OpenAgent",
        "X-Title": "OpenAgent",
      },
      defaultModel: defaultModelFor("openrouter"),
    });
  }

  private async completeGoogle(request: GenerateRequest): Promise<string> {
    const model = this.model.trim() || defaultModelFor("google");
    // AI Studio's documented auth puts the key in the x-goog-api-key header
    // rather than the URL query string.
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // The stable prefix goes in systemInstruction so Gemini can cache it.
        systemInstruction: { parts: [{ text: request.system }] },
        // Map roles to Gemini's vocabulary ("assistant" -> "model") and merge
        // consecutive same-role turns — Gemini wants alternating user/model.
        // Images, if present, are encoded as inlineData parts after the text.
        contents: this.mergeAlternating(request.messages).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: this.geminiParts(m),
        })),
      }),
    });

    const data = (await this.readJson(response)) as GoogleResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(
        `Google response missing candidates[0].content.parts[0].text: ${JSON.stringify(data)}`
      );
    }
    return text;
  }
}
