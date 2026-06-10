/**
 * verify-fs-ops.ts — grep/find/diff end-to-end tests (IMP-11)
 *
 * Sets up a temp workspace, exercises FilesystemTool directly and via
 * executeTool(), then tears down.
 */

import { FilesystemTool } from "../src/tools/filesystem.js";
import { executeTool } from "../src/tools/index.js";
import { setActiveWorkspace, getConfig, saveConfig } from "../src/config/index.js";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => {
  checks.push([l, c]);
};

async function main(): Promise<void> {
  // Capture original workspace/config so we can restore afterwards
  const origWorkspace = getConfig().workspacePath;

  const ws = path.join(os.tmpdir(), "openagent-fs-ops-" + Date.now());
  fs.ensureDirSync(ws);

  // Point the active workspace at the temp dir
  setActiveWorkspace(ws);

  try {
    // ---- Populate temp workspace -----------------------------------------------

    // src/a.ts  — contains "const useEffect = 1;"
    fs.ensureDirSync(path.join(ws, "src"));
    fs.writeFileSync(
      path.join(ws, "src", "a.ts"),
      'import React from "react";\nconst useEffect = 1;\nexport default {};',
      "utf8",
    );

    // src/deep/b.ts — contains "useEffect("
    fs.ensureDirSync(path.join(ws, "src", "deep"));
    fs.writeFileSync(
      path.join(ws, "src", "deep", "b.ts"),
      "// deep file\nuseEffect(\n  () => {},\n  []\n);",
      "utf8",
    );

    // node_modules/skip.ts — should be ignored by grep/find
    fs.ensureDirSync(path.join(ws, "node_modules"));
    fs.writeFileSync(
      path.join(ws, "node_modules", "skip.ts"),
      "useEffect",
      "utf8",
    );

    // readme.md — contains "nothing here"
    fs.writeFileSync(
      path.join(ws, "readme.md"),
      "nothing here",
      "utf8",
    );

    // one.txt and two.txt for diff
    fs.writeFileSync(
      path.join(ws, "one.txt"),
      "alpha\nbeta\ngamma\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(ws, "two.txt"),
      "alpha\nBETA\ngamma\ndelta\n",
      "utf8",
    );

    const tool = new FilesystemTool();

    // ---- 1. grep("useEffect") recursive default --------------------------------

    const grepResult1 = await tool.grep("useEffect");
    ok(
      "grep: finds match in src/a.ts",
      grepResult1.includes("src/a.ts"),
    );
    ok(
      "grep: finds match in src/deep/b.ts",
      grepResult1.includes("src/deep/b.ts"),
    );
    ok(
      "grep: does not include node_modules",
      !grepResult1.includes("node_modules"),
    );
    // Output lines contain ":lineNumber:"
    ok(
      'grep: output lines contain ":<lineNumber>:"',
      /:\d+:/.test(grepResult1),
    );

    // ---- 2. grep with recursive=false at root ----------------------------------

    const grepResult2 = await tool.grep("useEffect", "", false);
    ok(
      "grep recursive=false at root finds nothing (matches are in subdirs)",
      grepResult2.startsWith("No matches"),
    );

    // ---- 3. grep case-insensitive / case-sensitive -----------------------------

    const grepCI = await tool.grep("USEEFFECT", "", true, true);
    ok(
      "grep caseInsensitive=true finds matches for USEEFFECT",
      !grepCI.startsWith("No matches"),
    );

    const grepCS = await tool.grep("USEEFFECT", "", true, false);
    ok(
      "grep caseInsensitive=false finds nothing for USEEFFECT",
      grepCS.startsWith("No matches"),
    );

    // ---- 4. grep with invalid regex falls back to literal ----------------------

    // "useEffect(" is an invalid regex (unmatched parenthesis).
    const grepInvalidRe = await tool.grep("useEffect(");
    ok(
      "grep invalid regex literal fallback finds src/deep/b.ts",
      grepInvalidRe.includes("src/deep/b.ts"),
    );

    // ---- 5. find("*.ts") -------------------------------------------------------

    const findTs = await tool.find("*.ts");
    ok(
      "find *.ts includes src/a.ts",
      findTs.includes("src/a.ts"),
    );
    ok(
      "find *.ts includes src/deep/b.ts",
      findTs.includes("src/deep/b.ts"),
    );
    ok(
      "find *.ts excludes node_modules/skip.ts",
      !findTs.includes("node_modules"),
    );
    ok(
      "find *.ts excludes readme.md",
      !findTs.includes("readme.md"),
    );

    // find("readme.*")
    const findReadme = await tool.find("readme.*");
    ok(
      "find readme.* finds readme.md",
      findReadme.includes("readme.md"),
    );

    // ---- 6. diff ---------------------------------------------------------------

    const diffResult = await tool.diff("one.txt", "two.txt");
    ok("diff: contains ---", diffResult.includes("---"));
    ok("diff: contains +++", diffResult.includes("+++"));
    ok("diff: contains @@", diffResult.includes("@@"));
    ok("diff: has -beta line", diffResult.includes("-beta"));
    ok("diff: has +BETA line", diffResult.includes("+BETA"));
    ok("diff: has +delta line", diffResult.includes("+delta"));

    // diff of a file with itself → "Files are identical."
    const diffSame = await tool.diff("one.txt", "one.txt");
    ok('diff same file → "Files are identical."', diffSame === "Files are identical.");

    // ---- 7. Traversal: executeTool with path "../" returns success:false -------

    const traversalResult = await executeTool("filesystem", {
      operation: "grep",
      pattern: "x",
      path: "../",
    });
    ok(
      "traversal: executeTool grep with path=../ returns success:false",
      !traversalResult.success,
    );

    // ---- 8. Param validation ---------------------------------------------------

    // grep without pattern
    const noPattern = await executeTool("filesystem", {
      operation: "grep",
      path: "",
    });
    ok(
      "param validation: grep without pattern → success:false",
      !noPattern.success,
    );
    ok(
      "param validation: grep without pattern error is helpful",
      typeof noPattern.error === "string" && noPattern.error.length > 0,
    );

    // diff without pathB
    const noPathB = await executeTool("filesystem", {
      operation: "diff",
      path: "one.txt",
    });
    ok(
      "param validation: diff without pathB → success:false",
      !noPathB.success,
    );
    ok(
      "param validation: diff without pathB error is helpful",
      typeof noPathB.error === "string" && noPathB.error.length > 0,
    );

    // ---- Use executeTool for at least one real op (grep via dispatcher) --------
    const dispatchedGrep = await executeTool("filesystem", {
      operation: "grep",
      pattern: "useEffect",
      path: "src",
    });
    ok(
      "executeTool dispatcher: grep via executeTool succeeds",
      dispatchedGrep.success,
    );
    ok(
      "executeTool dispatcher: result includes src/a.ts",
      dispatchedGrep.result.includes("src/a.ts"),
    );

  } finally {
    // Restore original workspace
    saveConfig({ workspacePath: origWorkspace });
    setActiveWorkspace(origWorkspace ?? "");
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nFS-OPS VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
