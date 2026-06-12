/**
 * verify-browser-deep.ts — IMP-12: advanced browser tool features.
 *
 * The following browser operations are NOT wired in the registry dispatch
 * (parseBrowserParams / dispatchBrowser only handle: navigate, click, type,
 * screenshot, extractText, getHtml, waitFor, scroll, readText, press).
 * So injectJs / setCookies / getCookies / download / network are tested
 * directly on a BrowserTool instance.
 *
 * Tests:
 *  1. navigate(serveUrl) works (sanity).
 *  2. injectJs("document.title") returns a string containing "DeepTest".
 *  3. setCookies + getCookies round-trip.
 *  4. network() contains GET and the serve URL; filtered network("data.json").
 *  5. download: saved file exists; SSRF download blocked.
 *  6. setCookies with garbage JSON → throws.
 */

import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { BrowserTool } from "../src/tools/browser.js";
import { ServeTool, closeAllServers } from "../src/tools/serve.js";
import { closeBrowser, executeTool } from "../src/tools/index.js";
import { setActiveWorkspace, getConfig, saveConfig } from "../src/config/index.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-browser-deep-" + Date.now());
  fs.ensureDirSync(ws);
  const siteDir = path.join(ws, "site");
  fs.ensureDirSync(siteDir);

  // Write the test HTML.
  fs.writeFileSync(
    path.join(siteDir, "index.html"),
    `<h1 id="t">Deep</h1><script>document.title="DeepTest"</script>`,
    "utf8",
  );
  // Write a tiny JSON file for download / network tests.
  fs.writeFileSync(
    path.join(siteDir, "data.json"),
    '{"verify":"deep"}',
    "utf8",
  );

  // Save and restore config state.
  const origConfig = {
    workspacePath: getConfig().workspacePath,
  };
  setActiveWorkspace(ws);

  // Start the static server (SSRF-exempt because it is a serve URL).
  const serveResult = await new ServeTool().serve("site");
  const urlMatch = /at (http:\/\/localhost:\d+)/.exec(serveResult);
  if (!urlMatch?.[1]) {
    throw new Error(`Could not parse URL from serve result: ${serveResult}`);
  }
  const serveUrl = urlMatch[1];

  // We test BrowserTool directly because injectJs / setCookies / getCookies /
  // download / network are NOT dispatched by the registry (see parseBrowserParams).
  const browser = new BrowserTool();

  try {
    // ---- 1. navigate (sanity) -----------------------------------------------
    {
      let result = "";
      let threw = false;
      try {
        result = await browser.navigate(serveUrl);
      } catch (e) {
        threw = true;
        console.error("navigate threw:", e);
      }
      ok("navigate(serveUrl) succeeds", !threw && result.includes("DeepTest"));
    }

    // ---- 2. injectJs: document.title ----------------------------------------
    {
      let result = "";
      let threw = false;
      try {
        result = await browser.injectJs("document.title");
      } catch (e) {
        threw = true;
        console.error("injectJs threw:", e);
      }
      // result is JSON-stringified: '"DeepTest"'
      ok(
        'injectJs("document.title") contains "DeepTest"',
        !threw && result.includes("DeepTest"),
      );
    }

    // ---- 3. setCookies + getCookies round-trip --------------------------------
    {
      let setResult = "";
      let threw = false;
      try {
        setResult = await browser.setCookies(
          JSON.stringify([{ name: "vtest", value: "1", url: serveUrl }]),
        );
      } catch (e) {
        threw = true;
        console.error("setCookies threw:", e);
      }
      ok('setCookies: result is "Set 1 cookie(s)."', !threw && setResult === "Set 1 cookie(s).");

      let getResult = "";
      let getThrew = false;
      try {
        getResult = await browser.getCookies();
      } catch (e) {
        getThrew = true;
        console.error("getCookies threw:", e);
      }
      ok(
        'getCookies contains "vtest"',
        !getThrew && getResult.includes("vtest"),
      );
    }

    // ---- 4. network() -------------------------------------------------------
    // Navigate to the page so the network log has entries.
    {
      await browser.navigate(serveUrl);
      const netAll = browser.network();
      ok(
        "network() contains 'GET' and serve URL",
        netAll.includes("GET") && netAll.includes("localhost"),
      );

      // Fetch data.json via injectJs so it shows up in the network log.
      // page.evaluate automatically awaits Promises returned by the script.
      await browser.injectJs(`fetch('/data.json').then(() => 'ok')`);
      // Small delay for the response listener to record the entry.
      await new Promise<void>((r) => setTimeout(r, 200));

      const netFiltered = browser.network("data.json");
      ok(
        'network("data.json") filters to data.json entries',
        netFiltered.includes("data.json"),
      );
    }

    // ---- 5. download --------------------------------------------------------
    {
      // Ensure the download dir exists.
      const dlDir = path.join(ws, "dl");
      fs.ensureDirSync(dlDir);

      let downloadResult = "";
      let threw = false;
      try {
        downloadResult = await browser.download(serveUrl + "/data.json", "dl/saved.json");
      } catch (e) {
        threw = true;
        console.error("download threw:", e);
      }
      ok("download: result string mentions HTTP 200", !threw && downloadResult.includes("200"));
      const savedPath = path.join(ws, "dl", "saved.json");
      ok(
        "download: saved file exists in workspace",
        !threw && fs.existsSync(savedPath),
      );
      if (!threw && fs.existsSync(savedPath)) {
        const content = fs.readFileSync(savedPath, "utf8");
        ok(
          "download: saved file has JSON content",
          content.includes("verify") || content.includes("deep"),
        );
      } else {
        ok("download: saved file has JSON content", false);
      }

      // SSRF: cloud metadata endpoint must be blocked.
      let ssrfThrew = false;
      let ssrfMsg = "";
      try {
        await browser.download("http://169.254.169.254/x", "dl/evil");
      } catch (e) {
        ssrfThrew = true;
        ssrfMsg = e instanceof Error ? e.message : String(e);
      }
      ok(
        "download SSRF: 169.254.169.254 throws Blocked",
        ssrfThrew && ssrfMsg.includes("Blocked"),
      );
    }

    // ---- 6. setCookies with garbage JSON → throws ---------------------------
    {
      let threw = false;
      let errMsg = "";
      try {
        await browser.setCookies("not-valid-json{{{{");
      } catch (e) {
        threw = true;
        errMsg = e instanceof Error ? e.message : String(e);
      }
      ok(
        "setCookies with garbage JSON throws readable error",
        threw && errMsg.length > 0,
      );
    }

  } finally {
    await closeAllServers();
    await browser.close();
    // Also close the registry's shared browser instance.
    await closeBrowser();
    saveConfig(origConfig);
    setActiveWorkspace(process.cwd());
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nBROWSER-DEEP VERIFY: ${allOk ? "PASS" : "FAIL"}`);

  // Registry dispatch status for the caller.
  console.log(
    "\nRegistry dispatch note: injectJs / setCookies / getCookies / download / network " +
    "are NOT wired in the registry (parseBrowserParams / dispatchBrowser). " +
    "Tests use BrowserTool methods directly.",
  );

  process.exit(allOk ? 0 : 1);
}

void main();
