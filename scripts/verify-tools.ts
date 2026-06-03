// Runtime smoke test of the tool registry: shell, filesystem (traversal block),
// and the Playwright browser (navigate + extract). The browser portion is
// skipped when the Playwright Chromium binary is not installed.
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { executeTool, closeBrowser, isBrowserAvailable } from "../src/tools/index.js";
import { setActiveWorkspace } from "../src/config/index.js";

async function main(): Promise<void> {
  // Operate inside a temp workspace so nothing is written into the repo root.
  const workspace = path.join(os.tmpdir(), "openagent-verify-tools");
  fs.ensureDirSync(workspace);
  setActiveWorkspace(workspace);

  // 1. shell — echo inside the workspace.
  const shell = await executeTool("shell", { command: "node -e \"console.log('shell-ok')\"" });
  console.log("shell:", shell.success, "->", shell.result.replace(/\s+/g, " ").slice(0, 80));

  // 2. filesystem — list workspace.
  const list = await executeTool("filesystem", { operation: "list", path: "" });
  console.log("fs list:", list.success, "->", JSON.stringify(list.result).slice(0, 80));

  // 3. filesystem — traversal must be blocked.
  const evil = await executeTool("filesystem", { operation: "read", path: "../package.json" });
  console.log("fs traversal blocked:", !evil.success, "->", evil.error?.slice(0, 60));

  // 4. shell — dangerous command must be blocked.
  const danger = await executeTool("shell", { command: "rm -rf /" });
  console.log("shell danger blocked:", danger.result.includes("-1") || !danger.success, "->",
    danger.result.replace(/\s+/g, " ").slice(0, 80));

  // 5. browser — navigate to a data: URL and extract text (only if available).
  const browserOk = isBrowserAvailable();
  let nav: { success: boolean; result: string } = { success: false, result: "" };
  let text: { success: boolean; result: string } = { success: false, result: "" };
  if (browserOk) {
    nav = await executeTool("browser", {
      operation: "navigate",
      url: "data:text/html,<title>OpenAgentTest</title><body><h1>Browser Works</h1></body>",
    });
    console.log("browser navigate:", nav.success, "->", JSON.stringify(nav.result).slice(0, 60));
    text = await executeTool("browser", { operation: "extractText" });
    console.log("browser extractText:", text.success, "->", JSON.stringify(text.result).slice(0, 60));
    await closeBrowser();
  } else {
    console.log("browser: unavailable (Playwright Chromium not installed) — skipped");
  }

  const coreOk =
    shell.success &&
    shell.result.includes("shell-ok") &&
    list.success &&
    !evil.success;

  // The browser only contributes to PASS when it is actually available.
  const browserCheckOk = !browserOk || (nav.success && text.success && text.result.includes("Browser Works"));

  const ok = coreOk && browserCheckOk;
  console.log(`\nTOOLS VERIFY: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

void main();
