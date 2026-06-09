/**
 * Offline smoke-test for the new BrowserTool operations.
 * Run with: npx tsx scripts/verify-browser-ops.ts
 */
import { BrowserTool } from "../src/tools/browser.js";

const DATA_URL =
  "data:text/html," +
  encodeURIComponent(
    '<html><body><main><h1>Hello</h1><p>World</p></main>' +
      '<div style="height:2000px">filler</div></body></html>',
  );

const b = new BrowserTool();

async function run(): Promise<void> {
  // 1. navigate
  const nav = await b.navigate(DATA_URL);
  console.log("navigate:", nav);

  // 2. readText — should contain Hello and World (from <main>)
  const rt = await b.readText();
  const rtOk = rt.includes("Hello") && rt.includes("World");
  console.log("readText result:", JSON.stringify(rt));
  console.log("readText OK (contains Hello+World):", rtOk);
  if (!rtOk) throw new Error("readText missing expected content");

  // 3. waitFor existing selector
  const wf = await b.waitFor("h1");
  console.log("waitFor h1:", wf);
  if (!wf.includes("appeared")) throw new Error("waitFor unexpected result");

  // 4. scroll bottom
  const sb = await b.scroll("bottom");
  console.log("scroll bottom:", sb);
  if (!sb.includes("bottom")) throw new Error("scroll bottom unexpected");

  // 5. scroll top
  const st = await b.scroll("top");
  console.log("scroll top:", st);

  // 6. scroll down
  const sd = await b.scroll("down");
  console.log("scroll down:", sd);

  // 7. scroll up
  const su = await b.scroll("up");
  console.log("scroll up:", su);

  // 8. press Tab
  const pr = await b.press("Tab");
  console.log("press Tab:", pr);
  if (!pr.includes("Tab")) throw new Error("press unexpected result");

  // 9. waitFor timeout on a selector that does not exist
  try {
    await b.waitFor("#does-not-exist", 800);
    throw new Error("waitFor should have thrown on timeout");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("should have thrown")) throw e;
    console.log(
      "waitFor timeout correctly threw:",
      msg.slice(0, 100),
    );
  }

  // 10. screenshot returns a non-empty string (absolute path)
  const ss = await b.screenshot();
  console.log("screenshot path:", ss);
  if (!ss || ss.trim().length === 0) throw new Error("screenshot returned empty string");

  await b.close();
  console.log("\nALL TESTS PASSED");
}

run().catch((err) => {
  console.error("TEST FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
