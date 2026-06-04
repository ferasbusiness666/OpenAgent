/**
 * verify-research.ts — offline verification of the Tavily-backed research tool.
 *
 * The pure mapper (parseTavilyResponse) and formatter (formatSummary) are tested
 * against canned Tavily JSON so no network/API key is needed. A live search is
 * attempted only when TAVILY_API_KEY is set, and is informational (never fails
 * the script).
 */

import {
  parseTavilyResponse,
  formatSummary,
  ResearchTool,
} from "../src/tools/research.js";

const checks: Array<[string, boolean]> = [];
const ok = (label: string, cond: boolean): void => {
  checks.push([label, cond]);
};

// A representative Tavily /search response.
const sample = {
  query: "typescript strict mode",
  answer: "TypeScript strict mode enables a set of stricter type checks.",
  results: [
    {
      title: "Strict Mode — TS Docs",
      url: "https://www.typescriptlang.org/tsconfig#strict",
      content: "The strict flag enables a wide range of type checking behavior.",
      score: 0.98,
      raw_content: "Strict mode raw page content here ...",
    },
    {
      title: "noImplicitAny",
      url: "https://example.com/noimplicitany",
      content: "Disallows implicit any types.",
      score: 0.81,
    },
    {
      // Missing url — must be skipped.
      title: "No URL result",
      content: "should be skipped",
    },
  ],
};

// ---- parseTavilyResponse ----
const parsed = parseTavilyResponse(sample, 5);
ok("answer is extracted", parsed.answer.startsWith("TypeScript strict mode"));
ok("results mapped (2 valid, 1 url-less skipped)", parsed.results.length === 2);
ok(
  "first result title/url/snippet mapped",
  parsed.results[0]!.title === "Strict Mode — TS Docs" &&
    parsed.results[0]!.url.includes("typescriptlang.org") &&
    parsed.results[0]!.snippet.includes("type checking"),
);
ok(
  "raw_content becomes a page excerpt",
  parsed.excerpts.length === 1 && parsed.excerpts[0]!.text.includes("raw page content"),
);

// maxResults honored
const limited = parseTavilyResponse(sample, 1);
ok("maxResults clamps the result count", limited.results.length === 1);

// maxResults <= 0 → empty
ok("maxResults 0 returns no results", parseTavilyResponse(sample, 0).results.length === 0);

// Defensive: junk inputs degrade to empty rather than throwing.
ok("non-object response returns empty", parseTavilyResponse("nope", 5).results.length === 0);
ok("null response returns empty", parseTavilyResponse(null, 5).results.length === 0);
ok(
  "missing results array returns empty",
  parseTavilyResponse({ answer: "x" }, 5).results.length === 0,
);

// ---- formatSummary ----
const summary = formatSummary("typescript strict mode", parsed);
ok("summary includes the query header", summary.includes("# Web research: typescript strict mode"));
ok("summary includes the answer", summary.includes("**Answer:**"));
ok("summary lists a result url", summary.includes("typescriptlang.org"));
ok("summary includes page excerpts section", summary.includes("## Page excerpts"));

const emptySummary = formatSummary("nothing", { answer: "", results: [], excerpts: [] });
ok("empty results render 'No results found'", emptySummary.includes("_No results found._"));

// ---- Optional live test (informational only) ----
async function liveTest(): Promise<void> {
  if (!process.env.TAVILY_API_KEY) {
    console.log("i live Tavily test — skipped (TAVILY_API_KEY not set)");
    return;
  }
  const tool = new ResearchTool();
  try {
    const out = await tool.research("typescript", { maxResults: 2 });
    console.log(`i live Tavily test ran — summary length ${out.length} chars`);
  } catch (err) {
    console.log(
      `i live Tavily test errored (informational): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await tool.close();
  }
}

async function main(): Promise<void> {
  await liveTest();
  for (const [label, pass] of checks) console.log(`${pass ? "✓" : "✗"} ${label}`);
  const allOk = checks.every(([, pass]) => pass);
  console.log(`\nRESEARCH VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
