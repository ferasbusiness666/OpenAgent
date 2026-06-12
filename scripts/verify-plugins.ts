/**
 * verify-plugins.ts — IMP-30: plugin system integration tests.
 *
 * Tests:
 *  1. Valid plugin discovered with correct name/description/schema.
 *  2. No-header file → errors; reserved name → rejected; duplicate → first wins.
 *  3. executePlugin("slugify", {text:"Hello World!"}) === '"hello-world"'.
 *  4. Sandbox proof: require/process/fetch all "undefined" inside sandbox;
 *     require("fs") throws.
 *  5. Unknown plugin → throws; async plugin → throws.
 *  6. executeTool("plugin", {name:"slugify", params:{text:"A B"}}) succeeds;
 *     executeTool("plugin", {}) fails.
 *  7. renderPluginList([]) === "(no plugins installed)".
 */

import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { loadPlugins, executePlugin, renderPluginList } from "../src/plugins/index.js";
import { executeTool, clearToolResultCache } from "../src/tools/index.js";
import { setActiveWorkspace } from "../src/config/index.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };

async function main(): Promise<void> {
  // Probe write permission (already done by parent but guard here too).
  const ws = path.join(os.tmpdir(), "openagent-plugins-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  clearToolResultCache();

  const pluginDir = path.join(ws, "plugins");
  fs.ensureDirSync(pluginDir);

  // Save and clear the env so our temp dir is the sole source.
  const origEnv = process.env.OPENAGENT_PLUGIN_DIRS;

  try {
    // ---- Write plugin files --------------------------------------------------

    // 1. Valid slugify plugin (trim trailing dashes variant).
    const slugifySource = [
      `// openagent-plugin: {"name":"slugify","description":"Turn a string into a URL slug","schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}`,
      `function execute(params) {`,
      `  return params.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");`,
      `}`,
    ].join("\n");
    fs.writeFileSync(path.join(pluginDir, "slugify.js"), slugifySource, "utf8");

    // 2a. No-header file.
    fs.writeFileSync(
      path.join(pluginDir, "no-header.js"),
      `function execute(params) { return params; }`,
      "utf8",
    );

    // 2b. Reserved name "shell".
    const reservedSource = [
      `// openagent-plugin: {"name":"shell","description":"Reserved name test","schema":{"type":"object","properties":{}}}`,
      `function execute(params) { return "bad"; }`,
    ].join("\n");
    fs.writeFileSync(path.join(pluginDir, "reserved.js"), reservedSource, "utf8");

    // 2c. Duplicate: a second file also named "slugify" (must sort AFTER "slugify.js"
    //     alphabetically so the original wins — "zz-dup.js" sorts after "slugify.js").
    const dupSource = [
      `// openagent-plugin: {"name":"slugify","description":"Duplicate slug","schema":{"type":"object","properties":{}}}`,
      `function execute(params) { return "dup"; }`,
    ].join("\n");
    fs.writeFileSync(path.join(pluginDir, "zz-dup.js"), dupSource, "utf8");

    // 4. Sandbox-probe plugin: tests typeof require / process / fetch.
    const sandboxProbeSource = [
      `// openagent-plugin: {"name":"sandbox-probe","description":"Test sandbox isolation","schema":{"type":"object","properties":{}}}`,
      `function execute() {`,
      `  return typeof require + "|" + typeof process + "|" + typeof fetch;`,
      `}`,
    ].join("\n");
    fs.writeFileSync(path.join(pluginDir, "sandbox-probe.js"), sandboxProbeSource, "utf8");

    // 4b. Plugin that tries require("fs") — should throw from sandbox.
    const requireFsSource = [
      `// openagent-plugin: {"name":"require-fs","description":"Tries require fs","schema":{"type":"object","properties":{}}}`,
      `function execute() {`,
      `  var mod = require("fs");`,
      `  return mod ? "got-fs" : "no-fs";`,
      `}`,
    ].join("\n");
    fs.writeFileSync(path.join(pluginDir, "require-fs.js"), requireFsSource, "utf8");

    // 5b. Async plugin (returns a Promise).
    const asyncSource = [
      `// openagent-plugin: {"name":"async-plugin","description":"Async test","schema":{"type":"object","properties":{}}}`,
      `function execute() {`,
      `  return new Promise(function(resolve) { resolve("done"); });`,
      `}`,
    ].join("\n");
    fs.writeFileSync(path.join(pluginDir, "async-plugin.js"), asyncSource, "utf8");

    // ---- Point the plugin loader at our temp dir and reload -----------------
    process.env.OPENAGENT_PLUGIN_DIRS = pluginDir;
    const { plugins, errors } = loadPlugins({ reload: true });

    // ---- Check 1: slugify discovered with correct metadata ------------------
    const slugify = plugins.find((p) => p.name === "slugify");
    ok(
      "valid plugin discovered: name slugify",
      slugify !== undefined,
    );
    ok(
      "valid plugin: description matches",
      slugify?.description === "Turn a string into a URL slug",
    );
    ok(
      "valid plugin: schema has type object",
      slugify?.schema?.type === "object",
    );

    // ---- Check 2: errors contain no-header; reserved rejection; dup skipped --
    const noHeaderErr = errors.some((e) => e.includes("no-header") || e.includes("missing"));
    const reservedErr = errors.some((e) => e.includes("reserved") || e.includes("shell"));
    const dupErr = errors.some((e) => e.includes("duplicate") || e.includes("zz-dup"));
    ok("no-header file → in errors", noHeaderErr);
    ok("reserved name 'shell' → rejected (in errors)", reservedErr);
    ok("duplicate name → error, first wins", dupErr && plugins.filter((p) => p.name === "slugify").length === 1);

    // ---- Check 3: executePlugin slugify -------------------------------------
    {
      let result = "";
      let threw = false;
      try {
        result = await executePlugin("slugify", { text: "Hello World!" });
      } catch (e) {
        threw = true;
        console.error("slugify threw:", e);
      }
      // The plugin returns the slug string; executePlugin wraps it in JSON.stringify.
      ok(
        'executePlugin("slugify", {text:"Hello World!"}) === \'"hello-world"\'',
        !threw && result === '"hello-world"',
      );
    }

    // ---- Check 4: Sandbox isolation -----------------------------------------
    {
      let probeResult = "";
      let threw = false;
      try {
        probeResult = await executePlugin("sandbox-probe", {});
      } catch (e) {
        threw = true;
        console.error("sandbox-probe threw:", e);
      }
      // Result is a JSON-stringified string like '"undefined|undefined|undefined"'
      let inner = "";
      if (!threw && probeResult.startsWith('"')) {
        try {
          inner = JSON.parse(probeResult) as string;
        } catch {
          inner = probeResult;
        }
      }
      const segments = inner.split("|");
      ok(
        "sandbox: typeof require === 'undefined'",
        !threw && segments[0] === "undefined",
      );
      ok(
        "sandbox: typeof process === 'undefined'",
        !threw && segments[1] === "undefined",
      );
      ok(
        "sandbox: typeof fetch === 'undefined'",
        !threw && segments[2] === "undefined",
      );
    }

    // 4b. require("fs") inside sandbox → throws.
    {
      let threw = false;
      let errMsg = "";
      try {
        await executePlugin("require-fs", {});
      } catch (e) {
        threw = true;
        errMsg = e instanceof Error ? e.message : String(e);
      }
      ok("require('fs') in sandbox → throws readable error", threw && errMsg.length > 0);
    }

    // ---- Check 5: Unknown plugin → throws -----------------------------------
    {
      let threw = false;
      let errMsg = "";
      try {
        await executePlugin("nonexistent-plugin", {});
      } catch (e) {
        threw = true;
        errMsg = e instanceof Error ? e.message : String(e);
      }
      ok(
        "unknown plugin → throws with readable message",
        threw && (errMsg.includes("unknown") || errMsg.includes("nonexistent")),
      );
    }

    // 5b. Async plugin → throws async-not-supported error.
    {
      let threw = false;
      let errMsg = "";
      try {
        await executePlugin("async-plugin", {});
      } catch (e) {
        threw = true;
        errMsg = e instanceof Error ? e.message : String(e);
      }
      ok(
        "async plugin → throws async-not-supported error",
        threw && (errMsg.toLowerCase().includes("async") || errMsg.toLowerCase().includes("promise")),
      );
    }

    // ---- Check 6: executeTool("plugin", ...) --------------------------------
    {
      const r1 = await executeTool("plugin", { name: "slugify", params: { text: "A B" } });
      ok(
        'executeTool("plugin", {name:"slugify", params:{text:"A B"}}) success:true, result contains "a-b"',
        r1.success === true && r1.result.includes("a-b"),
      );

      const r2 = await executeTool("plugin", {});
      ok(
        'executeTool("plugin", {}) → success:false',
        r2.success === false,
      );
    }

    // ---- Check 7: renderPluginList([]) --------------------------------------
    ok(
      'renderPluginList([]) === "(no plugins installed)"',
      renderPluginList([]) === "(no plugins installed)",
    );

  } finally {
    // Restore env and reload cache to avoid leaking into other test contexts.
    if (origEnv === undefined) {
      delete process.env.OPENAGENT_PLUGIN_DIRS;
    } else {
      process.env.OPENAGENT_PLUGIN_DIRS = origEnv;
    }
    // Final reload with restored env so the module cache doesn't pollute other contexts.
    loadPlugins({ reload: true });
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nPLUGINS VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
