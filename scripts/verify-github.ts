// Smoke test for the GitHub connector and its tool-registry integration.
// Deterministic (no network) by default; optionally extends to a live API call
// when GITHUB_TOKEN is set in the environment.
import { executeTool } from "../src/tools/index.js";
import { getConnector, listConnectors } from "../src/connectors/index.js";

// ---------------------------------------------------------------------------
// Tiny assertion helper
// ---------------------------------------------------------------------------
function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`  FAIL: ${label}`);
    throw new Error(label);
  }
  console.log(`  pass: ${label}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  let allOk = true;

  try {
    // 1. Registry sanity checks (no network required)
    console.log("\n[1] Connector registry");
    const connector = getConnector("github");
    assert(connector !== undefined, 'getConnector("github") returns a value');
    assert(connector?.name === "github", 'connector.name === "github"');
    const names = listConnectors();
    assert(names.includes("github"), 'listConnectors() includes "github"');

    // 2. No-token: listRepos must fail with a GITHUB_TOKEN message
    console.log("\n[2] No-token rejection (listRepos)");
    const savedToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];

    const noToken = await executeTool("github", { operation: "listRepos" });
    assert(noToken.success === false, "success === false when token absent");
    assert(
      typeof noToken.error === "string" && noToken.error.includes("GITHUB_TOKEN"),
      'error mentions "GITHUB_TOKEN"',
    );

    // 3. Invalid operation
    console.log("\n[3] Invalid operation");
    const badOp = await executeTool("github", { operation: "bogus" });
    assert(badOp.success === false, "success === false for unknown operation");

    // 4. readFile missing path (params validated before hitting network)
    console.log("\n[4] readFile with missing path");
    const noPath = await executeTool("github", {
      operation: "readFile",
      repo: "a/b",
      // path intentionally omitted
    });
    assert(
      noPath.success === false,
      "success === false when path param is missing",
    );

    // 5. listIssues missing repo
    console.log("\n[5] listIssues with missing repo");
    const noRepo = await executeTool("github", {
      operation: "listIssues",
      // repo intentionally omitted
    });
    assert(
      noRepo.success === false,
      "success === false when repo param is missing",
    );

    // 6. listRepos missing repo (no repo param needed — just checking it doesn't crash)
    console.log("\n[6] listRepos with no token still returns structured failure");
    const listNoToken = await executeTool("github", { operation: "listRepos" });
    assert(listNoToken.success === false, "structured ToolResult (no throw)");

    // Restore token if it was set
    if (savedToken !== undefined) {
      process.env["GITHUB_TOKEN"] = savedToken;
    }

    // 7. Optional live test — only runs when GITHUB_TOKEN is available
    if (process.env["GITHUB_TOKEN"]) {
      console.log("\n[7] Live API test (GITHUB_TOKEN is set)");
      const live = await executeTool("github", { operation: "listRepos" });
      assert(live.success === true, "live listRepos succeeds with valid token");
      assert(
        typeof live.result === "string" && live.result.length > 0,
        "result is non-empty JSON string",
      );
      console.log(
        "  sample output (first 200 chars):",
        live.result.slice(0, 200),
      );
    } else {
      console.log("\n[7] Live API test — skipped (GITHUB_TOKEN not set)");
    }
  } catch {
    allOk = false;
  }

  console.log(`\nGITHUB VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
