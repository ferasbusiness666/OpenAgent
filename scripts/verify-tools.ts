// Runtime smoke test of the tool registry: shell, filesystem (traversal block),
// and the Playwright browser (navigate + extract).
import { executeTool, closeBrowser } from "../src/tools/index.js";

async function main(): Promise<void> {
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

  // 5. browser — navigate to a data: URL and extract text.
  const nav = await executeTool("browser", {
    operation: "navigate",
    url: "data:text/html,<title>OpenAgentTest</title><body><h1>Browser Works</h1></body>",
  });
  console.log("browser navigate:", nav.success, "->", JSON.stringify(nav.result).slice(0, 60));
  const text = await executeTool("browser", { operation: "extractText" });
  console.log("browser extractText:", text.success, "->", JSON.stringify(text.result).slice(0, 60));

  await closeBrowser();

  const ok =
    shell.success &&
    shell.result.includes("shell-ok") &&
    list.success &&
    !evil.success &&
    nav.success &&
    text.success &&
    text.result.includes("Browser Works");
  console.log(`\nTOOLS VERIFY: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

void main();
