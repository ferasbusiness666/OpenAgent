import type { Provider } from "./index.js";

export type ApiProviderName = "openai" | "anthropic" | "google";

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
 * Calls a hosted chat/completions API with a single user message and returns
 * the assistant's text. The agent loop assembles the entire prompt (system +
 * history + format rules) into the one `prompt` string passed here.
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

  async complete(prompt: string): Promise<string> {
    switch (this.apiProvider) {
      case "anthropic":
        return this.completeAnthropic(prompt);
      case "openai":
        return this.completeOpenAI(prompt);
      case "google":
        return this.completeGoogle(prompt);
      default: {
        // Exhaustiveness guard — unreachable under the typed union.
        const never: never = this.apiProvider;
        throw new Error(`Unsupported API provider: ${String(never)}`);
      }
    }
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

  private async completeAnthropic(prompt: string): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model.trim() || "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
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

  private async completeOpenAI(prompt: string): Promise<string> {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model.trim() || "gpt-4o",
          messages: [{ role: "user", content: prompt }],
        }),
      }
    );

    const data = (await this.readJson(response)) as OpenAIResponse;
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error(
        `OpenAI response missing choices[0].message.content: ${JSON.stringify(data)}`
      );
    }
    return text;
  }

  private async completeGoogle(prompt: string): Promise<string> {
    const model = this.model.trim() || "gemini-2.0-flash";
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(this.apiKey);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
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
