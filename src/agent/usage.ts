/**
 * usage.ts — session token accounting and cost estimation (IMP-17).
 *
 * API providers attach per-call {@link TokenUsage} to every GenerateResult; the
 * agent loop feeds those into a per-loop {@link UsageTracker}, which keeps the
 * running totals, estimates cost from the model id, and answers budget checks.
 *
 * Cost numbers are ESTIMATES: a small static price table matched by substring
 * against the model id. Unknown models still get token counts, just $0.00 cost.
 * Prices are USD per MILLION tokens; cache reads are billed at the discounted
 * rate when the provider reports them separately (Anthropic ~0.1×).
 */

import type { TokenUsage } from "../providers/messages.js";

/** Running totals for one agent session. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Estimated cumulative cost in USD (0 when the model is unknown). */
  costUsd: number;
  /** How many provider calls contributed to these totals. */
  calls: number;
}

interface PriceEntry {
  /** Matched case-insensitively against the provider/model name. */
  match: RegExp;
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens. */
  outPerMTok: number;
  /** USD per million cache-read tokens (defaults to 0.1 × input rate). */
  cacheReadPerMTok?: number;
}

/**
 * Approximate published list prices (USD/MTok). Ordered most-specific first —
 * the FIRST match wins. Update alongside provider price changes; an entry being
 * slightly stale only skews the estimate, never the token counts.
 */
const PRICES: readonly PriceEntry[] = [
  { match: /claude.*haiku/i, inPerMTok: 1, outPerMTok: 5 },
  { match: /claude.*opus/i, inPerMTok: 5, outPerMTok: 25 },
  { match: /claude/i, inPerMTok: 3, outPerMTok: 15 }, // sonnet + default
  { match: /gpt-4o-mini/i, inPerMTok: 0.15, outPerMTok: 0.6 },
  { match: /gpt-4o/i, inPerMTok: 2.5, outPerMTok: 10 },
  { match: /gpt-4\.1-mini/i, inPerMTok: 0.4, outPerMTok: 1.6 },
  { match: /gpt-4\.1/i, inPerMTok: 2, outPerMTok: 8 },
  { match: /gpt-5/i, inPerMTok: 1.25, outPerMTok: 10 },
  { match: /o3/i, inPerMTok: 2, outPerMTok: 8 },
  { match: /gemini.*flash/i, inPerMTok: 0.1, outPerMTok: 0.4 },
  { match: /gemini.*pro/i, inPerMTok: 1.25, outPerMTok: 10 },
  // Groq-hosted open models are effectively free-tier; count tokens, not cost.
  { match: /llama|mixtral|qwen|deepseek/i, inPerMTok: 0, outPerMTok: 0 },
];

/** Find the price entry for a provider/model name, or null when unknown. */
function priceFor(modelName: string): PriceEntry | null {
  for (const entry of PRICES) {
    if (entry.match.test(modelName)) {
      return entry;
    }
  }
  return null;
}

/** Estimate the USD cost of one call for the given provider/model name. */
export function estimateCostUsd(modelName: string, usage: TokenUsage): number {
  const price = priceFor(modelName);
  if (price === null) {
    return 0;
  }
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheRate = price.cacheReadPerMTok ?? price.inPerMTok * 0.1;
  return (
    (usage.inputTokens / 1_000_000) * price.inPerMTok +
    (usage.outputTokens / 1_000_000) * price.outPerMTok +
    (cacheRead / 1_000_000) * cacheRate
  );
}

/** Compact human format for the status bar: 12431 → "12.4k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Accumulates token usage + estimated cost across one agent session. */
export class UsageTracker {
  private totals: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  /** Stop-spending limit in USD; 0 disables budget enforcement. */
  budgetUsd = 0;

  /** Record one provider call's usage and return the new totals (a copy). */
  add(modelName: string, usage: TokenUsage): SessionUsage {
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.totals.costUsd += estimateCostUsd(modelName, usage);
    this.totals.calls += 1;
    return this.get();
  }

  /** A copy of the current totals (never the internal reference). */
  get(): SessionUsage {
    return { ...this.totals };
  }

  /** True when a budget is set and the estimated cost has reached it. */
  overBudget(): boolean {
    return this.budgetUsd > 0 && this.totals.costUsd >= this.budgetUsd;
  }

  reset(): void {
    this.totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      calls: 0,
    };
  }
}
