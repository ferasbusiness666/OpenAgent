/**
 * verify-prune.ts — IMP-20: relevance-based pruning of stale tool_result
 * messages (complementary to IMP-03 compaction).
 *
 *  1. Old, large, IRRELEVANT tool_results get stubbed; relevant ones do not.
 *  2. The most recent PRUNE_KEEP_RECENT_RESULTS tool_results are untouched.
 *  3. user / assistant / system messages are never touched; history length
 *     stays stable (pruner mutates content only, never removes entries).
 *  4. Idempotency: a second pass prunes 0.
 *  5. Guard: a tool_result under minChars is never stubbed even if irrelevant.
 *
 * Offline; no config mutation. Final verdict: PRUNE VERIFY: PASS|FAIL.
 */
import {
  SessionMemory,
  PRUNE_KEEP_RECENT_RESULTS,
  type Message,
} from "../src/memory/session.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => {
  checks.push([l, c]);
};

const msg = (
  content: string,
  role: Message["role"] = "tool_result",
): Message => ({ role, content, timestamp: new Date() });

/** Repeat `unit` until the result comfortably exceeds `minLen` chars. */
function bloat(unit: string, minLen: number): string {
  let out = unit;
  while (out.length <= minLen) {
    out += " " + unit;
  }
  return out;
}

const FOCUS = "build a web scraper for product prices";

// A relevant observation: dense with scraper/product/price terms.
const relevant = (n: number): string =>
  `[browser] ` +
  bloat(
    `result ${n}: the web scraper fetched the product page and parsed the ` +
      `product price; scraper found product price listings, product titles, ` +
      `and product price ranges for each product on the scraper run`,
    700,
  );

// An irrelevant observation: unrelated topic, no overlap with the focus terms.
const irrelevant = (n: number): string =>
  `[shell] ` +
  bloat(
    `entry ${n}: lorem ipsum dolor sit amet, kitchen recipes for baking ` +
      `sourdough bread, garden mulch composting tips, vintage bicycle repair ` +
      `manuals, and assorted dolor consectetur lorem ipsum filler text`,
    700,
  );

function buildSession(): SessionMemory {
  const session = new SessionMemory();
  session.add(msg("build a web scraper for product prices", "user"));
  session.add(msg("Okay, I'll start by navigating to the store.", "assistant"));

  // 8 old, large tool_results: interleaved relevant/irrelevant.
  for (let i = 0; i < 8; i += 1) {
    session.add(msg(i % 2 === 0 ? relevant(i) : irrelevant(i)));
  }

  // 5 more recent, small tool_results — the kept-recent tail.
  for (let i = 0; i < PRUNE_KEEP_RECENT_RESULTS; i += 1) {
    session.add(msg(`[shell] recent small result ${i}`));
  }

  return session;
}

function main(): void {
  const session = buildSession();

  const before = session.getHistory();
  const beforeLen = before.length;
  const beforeNonResults = before
    .filter((m) => m.role !== "tool_result")
    .map((m) => `${m.role}:${m.content}`);

  // Snapshot the kept-recent tail (last N tool_results) by content.
  const toolResultsBefore = before.filter((m) => m.role === "tool_result");
  const keptRecentBefore = toolResultsBefore
    .slice(-PRUNE_KEEP_RECENT_RESULTS)
    .map((m) => m.content);

  // ---- 1. prune ----
  const prunedCount = session.pruneToolResults(FOCUS);
  ok("pruneToolResults returns > 0", prunedCount > 0);

  const after = session.getHistory();

  // ---- history length unchanged ----
  ok("history length unchanged (content-only mutation)", after.length === beforeLen);

  // ---- at least one irrelevant OLD large result was stubbed ----
  const stubbedIrrelevant = after.some(
    (m) =>
      m.role === "tool_result" &&
      m.content.includes("[pruned") &&
      m.content.includes("shell"),
  );
  ok("at least one irrelevant old large result was stubbed", stubbedIrrelevant);

  // ---- NO relevant result (scraper/product/price) was stubbed ----
  const relevantStubbed = after.some(
    (m) =>
      m.role === "tool_result" &&
      m.content.includes("[pruned") &&
      /scraper|product|price/i.test(m.content),
  );
  ok("no relevant scraper/product/price result was stubbed", !relevantStubbed);

  // ---- relevant content survives verbatim ----
  const relevantSurvives = after.some(
    (m) =>
      m.role === "tool_result" &&
      !m.content.includes("[pruned") &&
      /scraper.*product.*price/is.test(m.content),
  );
  ok("relevant observations survive verbatim", relevantSurvives);

  // ---- the last N tool_results are untouched ----
  const toolResultsAfter = after.filter((m) => m.role === "tool_result");
  const keptRecentAfter = toolResultsAfter
    .slice(-PRUNE_KEEP_RECENT_RESULTS)
    .map((m) => m.content);
  const keptRecentStable =
    keptRecentAfter.length === keptRecentBefore.length &&
    keptRecentAfter.every((c, i) => c === keptRecentBefore[i]) &&
    keptRecentAfter.every((c) => !c.includes("[pruned"));
  ok("the last N tool_results are untouched", keptRecentStable);

  // ---- user/assistant/system messages untouched (count + content) ----
  const afterNonResults = after
    .filter((m) => m.role !== "tool_result")
    .map((m) => `${m.role}:${m.content}`);
  const nonResultsStable =
    afterNonResults.length === beforeNonResults.length &&
    afterNonResults.every((c, i) => c === beforeNonResults[i]);
  ok("user/assistant/system messages untouched", nonResultsStable);

  // ---- 4. idempotency ----
  const secondPass = session.pruneToolResults(FOCUS);
  ok("second pass prunes 0 (idempotent)", secondPass === 0);

  // ---- 5. guard: small irrelevant tool_result is never stubbed ----
  {
    const guard = new SessionMemory();
    guard.add(msg("build a web scraper for product prices", "user"));
    // 6 small irrelevant tool_results — all under minChars (600).
    for (let i = 0; i < PRUNE_KEEP_RECENT_RESULTS + 1; i += 1) {
      guard.add(msg(`[shell] kitchen recipe lorem ipsum filler ${i}`));
    }
    const guardPruned = guard.pruneToolResults(FOCUS);
    const anyStubbed = guard
      .getHistory()
      .some((m) => m.content.includes("[pruned"));
    ok(
      "guard: tool_result under minChars is never stubbed",
      guardPruned === 0 && !anyStubbed,
    );
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nPRUNE VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

main();
