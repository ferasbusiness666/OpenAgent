/**
 * verify-http.ts — integration tests for HttpTool (IMP-14) + ServeTool (IMP-36).
 *
 * Tests:
 *  1. Loopback-exempt: http request to a serve URL succeeds.
 *  2. JSON pretty-print: JSON response body is formatted.
 *  3. 404 is an observation, not an error.
 *  4. SSRF block: private/link-local/file/non-served loopback URLs throw with "Blocked".
 *  5. allowLocal override: with allowLocalNetworkAccess:true, the BLOCK message disappears
 *     for a non-served loopback (it throws a network/connection error instead).
 *  6. executeTool("http", ...) success/failure cases.
 *  7. Audit trail: last lines of audit.log include an entry with tool === "http".
 */

import { HttpTool } from "../src/tools/http.js";
import { ServeTool, closeAllServers } from "../src/tools/serve.js";
import { executeTool } from "../src/tools/index.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import { AUDIT_LOG_PATH } from "../src/audit.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-http-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);

  // Create site directory with test files.
  const siteDir = path.join(ws, "site");
  fs.ensureDirSync(siteDir);
  fs.writeFileSync(path.join(siteDir, "index.html"), "<h1>hello</h1>", "utf8");
  fs.writeFileSync(path.join(siteDir, "data.json"), '{"a":1}', "utf8");

  // Capture original config values we'll restore.
  const origAllowLocal = getConfig().allowLocalNetworkAccess;

  // Start the preview server.
  const serveResult = await new ServeTool().serve("site");
  // Extract URL from "Serving /abs/path at http://localhost:PORT"
  const urlMatch = /at (http:\/\/localhost:\d+)/.exec(serveResult);
  if (!urlMatch || !urlMatch[1]) {
    throw new Error(`Could not parse URL from serve result: ${serveResult}`);
  }
  const serveUrl = urlMatch[1];

  try {
    const http = new HttpTool();

    // ---- 1. Loopback-exempt: serve URL is accessible ----------------------------
    {
      let result = "";
      let threw = false;
      try {
        result = await http.request({ url: serveUrl + "/index.html" });
      } catch {
        threw = true;
      }
      ok("serve URL is loopback-exempt: succeeds", !threw && result.includes("HTTP 200") && result.includes("hello"));
    }

    // ---- 2. JSON pretty-print: data.json has "a": 1 with space -----------------
    {
      let result = "";
      let threw = false;
      try {
        result = await http.request({ url: serveUrl + "/data.json" });
      } catch {
        threw = true;
      }
      ok('JSON pretty-print: result contains "a": 1', !threw && result.includes('"a": 1'));
    }

    // ---- 3. 404 is an observation, not an error ---------------------------------
    {
      let result = "";
      let threw = false;
      try {
        result = await http.request({ url: serveUrl + "/missing.txt" });
      } catch {
        threw = true;
      }
      ok("404 is an observation (no throw, contains HTTP 404)", !threw && result.includes("HTTP 404"));
    }

    // ---- 4. SSRF block: private/link-local/file/non-served loopback -------------
    // 4a. Cloud metadata endpoint
    {
      let threw = false;
      let msg = "";
      try {
        await http.request({ url: "http://169.254.169.254/latest/meta-data/" });
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      ok("SSRF block: 169.254.169.254 throws with Blocked", threw && msg.includes("Blocked"));
    }

    // 4b. Private RFC-1918 address
    {
      let threw = false;
      let msg = "";
      try {
        await http.request({ url: "http://10.1.2.3/" });
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      ok("SSRF block: 10.1.2.3 throws with Blocked", threw && msg.includes("Blocked"));
    }

    // 4c. file:// scheme
    {
      let threw = false;
      let msg = "";
      try {
        await http.request({ url: "file:///x" });
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      ok("SSRF block: file:///x throws with Blocked", threw && msg.includes("Blocked"));
    }

    // 4d. Non-served loopback port (port 1 is almost certainly unregistered)
    {
      let threw = false;
      let msg = "";
      try {
        await http.request({ url: "http://127.0.0.1:1/", timeoutMs: 2000 });
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      ok("SSRF block: non-served 127.0.0.1:1 throws with Blocked", threw && msg.includes("Blocked"));
    }

    // ---- 5. allowLocal override: 127.0.0.1:1 no longer "Blocked" ---------------
    {
      saveConfig({ allowLocalNetworkAccess: true });
      let threw = false;
      let msg = "";
      try {
        await http.request({ url: "http://127.0.0.1:1/", timeoutMs: 2000 });
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      // Must throw but NOT with "Blocked" — it's a network/connection error now.
      ok(
        "allowLocal override: 127.0.0.1:1 does NOT say Blocked (connection error instead)",
        threw && !msg.includes("Blocked"),
      );
      // Restore.
      saveConfig({ allowLocalNetworkAccess: origAllowLocal });
    }

    // ---- 6. executeTool("http", ...) success/failure cases ----------------------
    {
      const r1 = await executeTool("http", { url: serveUrl + "/index.html" });
      ok("executeTool http success: success:true", r1.success === true);

      const r2 = await executeTool("http", {});
      ok("executeTool http missing url: success:false", r2.success === false);

      const r3 = await executeTool("http", { url: serveUrl, method: "BOGUS" });
      ok("executeTool http bad method: success:false", r3.success === false);
    }

    // ---- 7. Audit trail: audit.log contains an entry with tool === "http" -------
    {
      let found = false;
      try {
        if (fs.existsSync(AUDIT_LOG_PATH)) {
          const raw = fs.readFileSync(AUDIT_LOG_PATH, "utf8");
          const lines = raw.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
          // Check the last few lines for a recent http entry.
          const recent = lines.slice(-20);
          for (const line of recent) {
            try {
              const entry = JSON.parse(line) as { tool?: string };
              if (entry.tool === "http") {
                found = true;
                break;
              }
            } catch {
              // skip malformed lines
            }
          }
        }
      } catch {
        // best-effort
      }
      ok("audit.log contains an http tool entry", found);
    }
  } finally {
    await closeAllServers();
    saveConfig({ allowLocalNetworkAccess: origAllowLocal });
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nHTTP VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
