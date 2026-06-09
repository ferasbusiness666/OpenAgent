/**
 * Offline verification script for src/tools/serve.ts
 * Run with: npx tsx scripts/verify-serve.ts
 */

import http from "node:http";
import path from "node:path";
import fs from "fs-extra";
import { ServeTool, closeAllServers } from "../src/tools/serve.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function pass(label: string): void {
  console.log(`  PASS  ${label}`);
}

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected string to contain "${needle}", got:\n${haystack}`);
  }
  pass(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
  pass(label);
}

function assertNotEqual<T>(actual: T, unexpected: T, label: string): void {
  if (actual === unexpected) {
    throw new Error(`${label}: expected value NOT to be ${String(unexpected)}`);
  }
  pass(label);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
// getActiveWorkspace() returns process.cwd() (the project root).
// We create a test subdir there so workspace-relative paths work.

const projectRoot = process.cwd();
const testRelDir = `__serve_test_${Date.now()}`;
const testAbsDir = path.join(projectRoot, testRelDir);

async function setup(): Promise<void> {
  await fs.ensureDir(testAbsDir);
  await fs.writeFile(path.join(testAbsDir, "index.html"), "<h1>hi</h1>", "utf8");
  await fs.writeFile(path.join(testAbsDir, "style.css"), "body{color:red}", "utf8");
  await fs.ensureDir(path.join(testAbsDir, "sub"));
  await fs.writeFile(path.join(testAbsDir, "sub", "page.html"), "<p>sub</p>", "utf8");
  console.log(`Test dir created: ${testAbsDir}`);
}

async function teardown(): Promise<void> {
  await closeAllServers();
  await fs.remove(testAbsDir);
  console.log("Cleanup done.");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  const tool = new ServeTool();

  // ── 1. serve a workspace-relative dir ──────────────────────────────────────
  console.log("\n--- Test 1: serve(dir) returns URL");
  const msg = await tool.serve(testRelDir);
  console.log("  serve() →", msg);
  assertContains(msg, "http://localhost:", "result contains URL");
  assertContains(msg, testAbsDir, "result contains abs dir");
  const urlMatch = msg.match(/http:\/\/localhost:\d+/);
  if (!urlMatch) throw new Error("URL not found in serve() result");
  const url = urlMatch[0];

  // ── 2. GET / returns index.html body ───────────────────────────────────────
  console.log("\n--- Test 2: GET / returns index.html");
  const resp = await fetch(`${url}/`);
  assertEqual(resp.status, 200, "GET / status 200");
  const body = await resp.text();
  assertContains(body, "hi", "body contains 'hi'");

  // ── 3. CSS Content-Type ────────────────────────────────────────────────────
  console.log("\n--- Test 3: CSS Content-Type");
  const cssResp = await fetch(`${url}/style.css`);
  assertEqual(cssResp.status, 200, "GET style.css status 200");
  const cssType = cssResp.headers.get("content-type") ?? "";
  assertContains(cssType, "text/css", "CSS content-type");
  await cssResp.text();

  // ── 4. 404 for missing file ────────────────────────────────────────────────
  console.log("\n--- Test 4: 404 for missing file");
  const notFound = await fetch(`${url}/nope.html`);
  assertEqual(notFound.status, 404, "missing file → 404");
  await notFound.text();

  // ── 5. Traversal via encoded URL (%2e%2e) → not 200 ───────────────────────
  console.log("\n--- Test 5: path traversal (percent-encoded) blocked");
  const enc = await fetch(`${url}/%2e%2e%2fpackage.json`);
  await enc.text();
  assertNotEqual(enc.status, 200, "encoded traversal not 200 (got " + enc.status + ")");

  // ── 6. Traversal via literal .. in URL path → not 200 ─────────────────────
  console.log("\n--- Test 6: path traversal (literal ..) blocked");
  // fetch() / the URL constructor normalises "sub/../../package.json" to "../package.json"
  // before the request leaves the client, so we send it as a raw path via node:http.get.
  const portNum = parseInt(url.replace("http://localhost:", ""), 10);
  const raw403 = await new Promise<number>((resolve, reject) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: portNum,
        path: "/sub/../../package.json",
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
  });
  assertNotEqual(raw403, 200, "raw literal-.. traversal not 200 (got " + raw403 + ")");

  // ── 7. dir arg with ".." → throws ─────────────────────────────────────────
  console.log("\n--- Test 7: dir arg containing '..' rejected");
  let threw = false;
  try {
    await tool.serve("../outside");
  } catch (e: unknown) {
    threw = true;
    const msg2 = e instanceof Error ? e.message : String(e);
    assertContains(msg2, "traversal", "error message mentions traversal");
  }
  if (!threw) throw new Error("Expected serve('../outside') to throw");

  // ── 8. absolute dir arg → throws ──────────────────────────────────────────
  console.log("\n--- Test 8: absolute dir arg rejected");
  threw = false;
  try {
    await tool.serve("/etc");
  } catch (e: unknown) {
    threw = true;
    const msg3 = e instanceof Error ? e.message : String(e);
    assertContains(msg3, "absolute", "error message mentions absolute");
  }
  if (!threw) throw new Error("Expected serve('/etc') to throw");

  // ── 9. listServers ─────────────────────────────────────────────────────────
  console.log("\n--- Test 9: listServers()");
  const list = tool.listServers();
  console.log("  listServers() →", list);
  if (!list.includes(url)) throw new Error("URL not found in listServers()");
  pass("URL present in listServers()");

  // ── 10. stop(url) ──────────────────────────────────────────────────────────
  console.log("\n--- Test 10: stop(url)");
  const stopped = await tool.stop(url);
  assertEqual(stopped, true, "stop() returns true for known URL");
  if (tool.listServers().includes(url)) throw new Error("URL still present after stop()");
  pass("URL removed from registry after stop()");

  const notStopped = await tool.stop(url);
  assertEqual(notStopped, false, "stop() returns false for unknown URL");

  // ── 11. serve workspace root (no dir arg) ──────────────────────────────────
  console.log("\n--- Test 11: serve() with no dir (workspace root)");
  const rootMsg = await tool.serve();
  console.log("  serve() →", rootMsg);
  assertContains(rootMsg, "http://localhost:", "workspace-root URL present");
  assertContains(rootMsg, projectRoot, "workspace-root abs path present");
  const rootUrlMatch = rootMsg.match(/http:\/\/localhost:\d+/);
  if (!rootUrlMatch) throw new Error("No URL in workspace-root result");

  // ── 12. preferredPort: valid free port ────────────────────────────────────
  console.log("\n--- Test 12: preferred port");
  // Pick an unlikely-to-be-used port for testing.
  const preferred = 59876;
  const pmsg = await tool.serve(testRelDir, preferred);
  console.log("  serve(dir, " + preferred + ") →", pmsg);
  assertContains(pmsg, `:${preferred}`, "preferred port used");
  const pUrlMatch = pmsg.match(/http:\/\/localhost:\d+/);
  if (!pUrlMatch) throw new Error("No URL in preferred-port result");
  await tool.stop(pUrlMatch[0]);

  // ── 13. closeAllServers clears all ────────────────────────────────────────
  console.log("\n--- Test 13: closeAllServers()");
  await tool.serve(testRelDir);
  await tool.serve(testRelDir);
  const before = tool.listServers().length;
  console.log("  Servers before closeAll:", before);
  await closeAllServers();
  const after = tool.listServers().length;
  console.log("  Servers after closeAll:", after);
  assertEqual(after, 0, "registry empty after closeAllServers()");
}

// ── Entry point ───────────────────────────────────────────────────────────────

try {
  await setup();
  await runTests();
  console.log("\n============================");
  console.log("  All tests PASSED");
  console.log("============================\n");
} finally {
  await teardown();
}
