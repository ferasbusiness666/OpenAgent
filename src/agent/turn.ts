/**
 * turn.ts — pure parsing/serialization helpers for the agent loop (IMP-34).
 *
 * Extracted from loop.ts so the loop file holds the state machine and these
 * stateless transforms live on their own: turning a provider {@link
 * GenerateResult} into a normalized {@link ParsedTurn} (native tool calls or
 * the JSON text protocol), serializing a turn back to history form, reading a
 * reflection verdict, and a few small string/JSON utilities the loop shares.
 *
 * Nothing here touches loop state, the filesystem, or the network — every
 * function is pure, which is what makes them safe to unit-test in isolation.
 */

import {
  AgentResponseSchema,
  isActionName,
  type ActionName,
  type AgentResponse,
  type Reflection,
} from "./planner.js";
import type { GenerateResult } from "../providers/index.js";
import { extractJsonObject } from "../util/json.js";

/** One normalized action from a model turn (native tool call or JSON text). */
export interface TurnAction {
  action: ActionName;
  params: Record<string, unknown>;
  message?: string;
}

/** A fully parsed model turn: shared thought + one or more actions (IMP-02). */
export interface ParsedTurn {
  thought: string;
  message?: string;
  progress?: AgentResponse["progress"];
  actions: TurnAction[];
}

export type ParseSuccess = { value: AgentResponse };
export type ParseFailure = { error: string };
export type TurnSuccess = { value: ParsedTurn };

/**
 * Parse a provider's raw text into an AgentResponse. Tolerates markdown code
 * fences and surrounding prose by extracting the first balanced JSON object,
 * then validates it against the schema.
 */
export function parseAgentResponse(raw: string): ParseSuccess | ParseFailure {
  const jsonText = extractJsonObject(raw);
  if (jsonText === null) {
    return { error: "no JSON object found in output" };
  }

  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    return { error: `JSON.parse failed: ${errMessage(err)}` };
  }

  const validated = AgentResponseSchema.safeParse(data);
  if (!validated.success) {
    return { error: validated.error.issues.map((i) => i.message).join("; ") };
  }
  return { value: validated.data };
}

/**
 * Adapt a provider {@link GenerateResult} into a normalized {@link ParsedTurn}.
 * Native function-calling: EVERY tool call in the turn becomes an action
 * (IMP-02 — providers may call several tools in parallel). Text fallback: the
 * JSON action object, whose optional "actions" array also yields a batch.
 */
export function turnFromResult(result: GenerateResult): TurnSuccess | ParseFailure {
  if (result.toolCalls.length > 0) {
    const actions: TurnAction[] = [];
    const invalid: string[] = [];
    for (const call of result.toolCalls) {
      if (!isActionName(call.name)) {
        invalid.push(call.name);
        continue;
      }
      const args = call.arguments ?? {};
      const message = typeof args.message === "string" ? args.message : undefined;
      actions.push({ action: call.name, params: args, ...(message !== undefined ? { message } : {}) });
    }
    if (actions.length === 0) {
      return { error: `unknown tool(s): ${invalid.join(", ")}` };
    }
    const first = actions[0];
    return {
      value: {
        thought: result.text ?? "",
        ...(first?.message !== undefined ? { message: first.message } : {}),
        actions,
      },
    };
  }

  if (result.text.trim().length > 0) {
    const parsed = parseAgentResponse(result.text);
    if ("error" in parsed) {
      return parsed;
    }
    const r = parsed.value;
    const actions: TurnAction[] =
      r.actions && r.actions.length > 0
        ? r.actions.map((a) => ({
            action: a.action,
            params: a.params,
            ...(a.message !== undefined ? { message: a.message } : {}),
          }))
        : r.action !== undefined
          ? [{ action: r.action, params: r.params, ...(r.message !== undefined ? { message: r.message } : {}) }]
          : [];
    if (actions.length === 0) {
      // Unreachable thanks to the schema refine, but be defensive.
      return { error: "no action specified" };
    }
    return {
      value: {
        thought: r.thought,
        ...(r.message !== undefined ? { message: r.message } : {}),
        ...(r.progress !== undefined ? { progress: r.progress } : {}),
        actions,
      },
    };
  }
  return { error: "the model returned neither a tool call nor any text" };
}

/** History form of a turn: the single-action JSON for one action (identical to
 *  the pre-batch format), or {thought, actions:[…]} for a parallel batch. */
export function serializeTurn(turn: ParsedTurn): string {
  const single = turn.actions.length === 1 ? turn.actions[0] : undefined;
  if (single) {
    return JSON.stringify({
      thought: turn.thought,
      action: single.action,
      params: single.params,
      ...(turn.message !== undefined ? { message: turn.message } : {}),
      ...(turn.progress !== undefined ? { progress: turn.progress } : {}),
    });
  }
  return JSON.stringify({
    thought: turn.thought,
    ...(turn.message !== undefined ? { message: turn.message } : {}),
    ...(turn.progress !== undefined ? { progress: turn.progress } : {}),
    actions: turn.actions,
  });
}

/** Build a Reflection verdict from native `verdict` tool-call arguments. */
export function reflectionFromArgs(args: Record<string, unknown>): Reflection {
  const complete = args.complete === false || args.complete === "false" ? false : true;
  const reason = typeof args.reason === "string" ? args.reason : "";
  const nextStep =
    typeof args.nextStep === "string" && args.nextStep.trim().length > 0
      ? args.nextStep
      : undefined;
  return nextStep ? { complete, reason, nextStep } : { complete, reason };
}

/**
 * Try to read `text` as a JSON action object (e.g. a text-mode model asking to
 * run a filesystem check during verification). Returns null when the text is
 * not an action object — the caller then treats it as a verdict.
 */
export function tryParseActionObject(
  text: string,
): { action: string; params: Record<string, unknown> } | null {
  const json = extractJsonObject(text);
  if (json === null) {
    return null;
  }
  try {
    const data: unknown = JSON.parse(json);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj.action !== "string") {
      return null;
    }
    const params =
      obj.params !== null && typeof obj.params === "object" && !Array.isArray(obj.params)
        ? (obj.params as Record<string, unknown>)
        : {};
    return { action: obj.action, params };
  } catch {
    return null;
  }
}

/** Deterministic stringify (sorted keys) so identical params share a signature. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Promise that resolves after `ms` milliseconds (used for retry back-off). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap a tool observation kept in the MODEL context (head + tail) so a huge
 * output doesn't bloat the prompt and blow the cache window. The UI still shows
 * the full result via the toolResult event; only the model-context copy stored
 * in session history is trimmed.
 */
export function compressObservation(text: string, max = 6000): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, Math.round(max * 0.66));
  const tail = text.slice(-Math.round(max * 0.25));
  const omitted = text.length - head.length - tail.length;
  return (
    `${head}\n\n... [${omitted} characters omitted to save context — ` +
    `re-run with a narrower query/path if you need the rest] ...\n\n${tail}`
  );
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
