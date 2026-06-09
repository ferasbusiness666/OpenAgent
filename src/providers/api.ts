import type { Provider } from "./index.js";
import type { ApiProviderName } from "./catalog.js";
import { defaultModelFor } from "./catalog.js";
import type { GenerateRequest, ChatMessage } from "./messages.js";

export type { ApiProviderName } from "./catalog.js";

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
   * this is a defensive guard rather than a reshape.
   */
  private mergeAlternating(messages: ChatMessage[]): ChatMessage[] {
    const merged: ChatMessage[] = [];
    for (const message of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === message.role) {
        last.content = `${last.content}\n\n${message.content}`;
      } else {
        merged.push({ role: message.role, content: message.content });
      }
    }
    return merged;
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
        // roles. Roles are already "user"/"assistant" from the request.
        messages: this.mergeAlternating(request.messages).map((m) => ({
          role: m.role,
          content: m.content,
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
          ...request.messages,
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
        contents: this.mergeAlternating(request.messages).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
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
