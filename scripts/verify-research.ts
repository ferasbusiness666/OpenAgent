/**
 * verify-research.ts — verification for the DuckDuckGo HTML parser.
 *
 * The PASS/FAIL verdict is based ONLY on the offline parser assertions against
 * inline static markup that mimics the DuckDuckGo HTML endpoint. A live search
 * is optionally attempted but never affects the verdict (it may legitimately
 * fail offline, when bot-blocked, or when Chromium is missing).
 *
 * Prints "✓/✗ label" lines and a final "RESEARCH VERIFY: PASS|FAIL", then exits
 * with code 0 (pass) or 1 (fail).
 */

import { parseDuckDuckGoHtml, ResearchTool } from "../src/tools/research.js";

let allPass = true;

/** Record and print a single check. */
function check(label: string, ok: boolean): void {
  if (!ok) {
    allPass = false;
  }
  console.log(`${ok ? "✓" : "✗"} ${label}`);
}

// Inline static HTML mimicking the DuckDuckGo HTML endpoint. Includes a uddg
// redirect href (must decode to https://example.com/a), a protocol-relative
// direct href, entity-encoded text, and one result with NO snippet.
const SAMPLE_HTML = `
<!DOCTYPE html><html><body>
  <div class="result results_links">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Example &amp; First Result</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">This is the <b>first</b> snippet &quot;quoted&quot;.</a>
  </div>
  <div class="result results_links">
    <h2 class="result__title">
      <a class="result__a" href="//example.org/page">Second &#39;Result&#39;</a>
    </h2>
    <a class="result__snippet" href="#">Second snippet &lt;tag&gt; here.</a>
  </div>
  <div class="result results_links">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fc">Third Result No Snippet</a>
    </h2>
  </div>
</body></html>
`;

const parsed = parseDuckDuckGoHtml(SAMPLE_HTML, 5);

check("parsed three results", parsed.length === 3);

const [r1, r2, r3] = parsed;

check("result 1 title decoded", r1?.title === "Example & First Result");
check("result 1 url decoded from uddg", r1?.url === "https://example.com/a");
check(
  "result 1 snippet decoded",
  r1?.snippet === 'This is the first snippet "quoted".',
);

check("result 2 title decoded (&#39;)", r2?.title === "Second 'Result'");
check(
  "result 2 url normalized protocol-relative",
  r2?.url === "https://example.org/page",
);
check(
  "result 2 snippet decoded (&lt;&gt;)",
  r2?.snippet === "Second snippet <tag> here.",
);

check("result 3 url decoded from uddg", r3?.url === "https://example.net/c");
check("result 3 tolerates missing snippet", r3?.snippet === "");

// maxResults must be honored.
check("maxResults honored (limit 2)", parseDuckDuckGoHtml(SAMPLE_HTML, 2).length === 2);
check("maxResults 0 returns []", parseDuckDuckGoHtml(SAMPLE_HTML, 0).length === 0);

// Robustness: empty / junk input returns [] rather than throwing.
check("empty html returns []", parseDuckDuckGoHtml("", 5).length === 0);
check(
  "html with no result anchors returns []",
  parseDuckDuckGoHtml("<html><body><p>nothing</p></body></html>", 5).length === 0,
);

// Optional live test — informational only, never affects the verdict.
async function liveTest(): Promise<void> {
  const tool = new ResearchTool();
  try {
    const summary = await tool.research("typescript", { maxResults: 3 });
    console.log(
      `i live test ran — summary length ${summary.length} chars`,
    );
  } catch (err) {
    console.log(
      `i live test skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await tool.close();
  }
}

await liveTest();

console.log(`RESEARCH VERIFY: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
