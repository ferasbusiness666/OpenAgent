/**
 * mock.ts — offline testing and UI development providers.
 *
 * Three exports:
 *
 *   MockProvider    — steps through a scripted sequence of results without
 *                     touching any real API, so tests never need credentials.
 *
 *   RecordingProvider — wraps a real provider and appends every request/result
 *                     pair to a JSONL fixture file for later replay.
 *
 *   ReplayProvider  — reads a fixture produced by RecordingProvider and
 *                     replays it in order, also without network access.
 */

import fs from "fs-extra";
import type { Provider } from "./index.js";
import type { GenerateRequest, GenerateResult, ChatMessage } from "./messages.js";

// ---------------------------------------------------------------------------
// MockProvider
// ---------------------------------------------------------------------------

/**
 * One scripted step: a fixed result, or a function of the incoming request.
 * Using a function lets tests assert on what the agent sent and tailor the
 * response to the conversation contents.
 */
export type MockStep = GenerateResult | ((request: GenerateRequest) => GenerateResult);

/** Safe terminal result returned when the script is exhausted and loopLast is false. */
const EXHAUSTED_RESULT: GenerateResult = {
  text: JSON.stringify({ thought: "", action: "done", params: {}, message: "mock script exhausted" }),
  toolCalls: [],
};

/**
 * Scripted provider for offline testing and UI development. Steps are consumed
 * in order; the behaviour when the script runs out is controlled by `loopLast`.
 *
 * Every call records a shallow copy of the request (see {@link requests}) so
 * test assertions can inspect what the agent loop sent without reaching into
 * mutable state.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly supportsVision = false;

  private readonly script: MockStep[];
  private readonly loopLast: boolean;
  private stepIndex = 0;
  private readonly _requests: GenerateRequest[] = [];

  constructor(script: MockStep[], options?: { loopLast?: boolean }) {
    this.script = script;
    this.loopLast = options?.loopLast ?? false;
  }

  /** Shallow copies of every request seen so far, for test assertions. */
  get requests(): GenerateRequest[] {
    return this._requests.slice();
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    // Record a shallow copy — clone messages array so later mutations to the
    // real history array don't retroactively change what tests see.
    this._requests.push({ ...request, messages: [...request.messages] });

    if (this.stepIndex >= this.script.length) {
      if (this.loopLast && this.script.length > 0) {
        const last = this.script[this.script.length - 1]!;
        return typeof last === "function" ? last(request) : last;
      }
      return EXHAUSTED_RESULT;
    }

    const step = this.script[this.stepIndex]!;
    this.stepIndex++;
    return typeof step === "function" ? step(request) : step;
  }
}

// ---------------------------------------------------------------------------
// RecordingProvider
// ---------------------------------------------------------------------------

/** Shape of one JSONL line written by RecordingProvider. */
interface FixtureLine {
  request: GenerateRequest;
  result: GenerateResult;
}

/**
 * Wraps a real provider and records every request/result pair to a JSONL
 * fixture file so tests can replay calls offline.
 *
 * NOTE: Images are stripped from the recorded request before writing so
 * fixtures stay small (base64 screenshots can be several MB each). API keys
 * are never present in GenerateRequest, so no further redaction is needed.
 */
export class RecordingProvider implements Provider {
  readonly supportsVision: boolean;
  private readonly inner: Provider;
  private readonly fixturePath: string;

  constructor(inner: Provider, fixturePath: string) {
    this.inner = inner;
    this.fixturePath = fixturePath;
    this.supportsVision = inner.supportsVision;
  }

  get name(): string {
    return `recording(${this.inner.name})`;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const result = await this.inner.generate(request);

    // Record asynchronously-ish: append to file but never let a write failure
    // propagate — recording is best-effort and must never break the real call.
    try {
      fs.ensureFileSync(this.fixturePath);
      // Strip images from each message before writing so fixture files stay
      // small; base64 screenshots can be several MB per call.
      const strippedMessages: ChatMessage[] = request.messages.map((msg) => {
        if (msg.images !== undefined) {
          // Rebuild without the images key rather than setting it to undefined
          // so JSON.stringify omits the field entirely.
          const { images: _images, ...rest } = msg;
          return rest as ChatMessage;
        }
        return msg;
      });
      const line: FixtureLine = {
        request: { ...request, messages: strippedMessages },
        result,
      };
      fs.appendFileSync(this.fixturePath, JSON.stringify(line) + "\n", "utf8");
    } catch {
      // Best-effort recording — swallow all errors.
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// ReplayProvider
// ---------------------------------------------------------------------------

/** Type guard: checks that `v` has the shape of a {@link GenerateResult}. */
function isGenerateResult(v: unknown): v is GenerateResult {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const obj = v as Record<string, unknown>;
  return typeof obj["text"] === "string" && Array.isArray(obj["toolCalls"]);
}

/** Type guard: checks that `v` has the shape of a recorded {@link FixtureLine}. */
function isFixtureLine(v: unknown): v is FixtureLine {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["request"] === "object" &&
    obj["request"] !== null &&
    isGenerateResult(obj["result"])
  );
}

/**
 * Replays a fixture file produced by {@link RecordingProvider}, returning
 * results in the original order. Useful for deterministic tests and offline
 * UI development — zero network calls, zero API keys required.
 *
 * Bad JSONL lines (malformed JSON or unexpected shape) are skipped silently so
 * a single corrupt entry never kills the entire fixture.
 */
export class ReplayProvider implements Provider {
  readonly name = "replay";
  readonly supportsVision = false;

  private readonly entries: GenerateResult[];
  private replayIndex = 0;

  constructor(fixturePath: string) {
    // Read and parse the fixture file eagerly at construction time.
    let raw: string;
    try {
      raw = fs.readFileSync(fixturePath, "utf8");
    } catch {
      // File may not exist yet (e.g. in a test that creates it on the fly).
      raw = "";
    }

    this.entries = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line): GenerateResult[] => {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isFixtureLine(parsed)) {
            return [parsed.result];
          }
          // Line parsed as JSON but doesn't match the expected shape — skip it.
          return [];
        } catch {
          // Malformed JSON — skip line.
          return [];
        }
      });
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    if (this.replayIndex >= this.entries.length) {
      throw new Error(
        `ReplayProvider: fixture exhausted after ${this.entries.length} entr${this.entries.length === 1 ? "y" : "ies"}. ` +
          "Re-record the fixture or extend it with additional calls.",
      );
    }
    const result = this.entries[this.replayIndex]!;
    this.replayIndex++;
    return result;
  }
}
