/**
 * verify-health.ts — IMP-25: pre-task health check (offline; the provider
 * check is skipped so no network call is made, and config is never modified).
 */
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { setActiveWorkspace } from "../src/config/index.js";
import { runHealthCheck, formatHealthReport, type HealthReport } from "../src/health.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), `openagent-health-${Date.now()}`);
  fs.ensureDirSync(ws);
  try {
    // ---- 1. happy path in a writable temp workspace ----
    setActiveWorkspace(ws);
    const report = await runHealthCheck({ skipProvider: true });
    const names = report.items.map((i) => i.name).join(" | ");
    ok("report has >= 4 items", report.items.length >= 4);
    ok(
      "items cover Config / Provider / Workspace / Browser",
      /Config/.test(names) && /Provider/.test(names) && /Workspace/.test(names) && /Browser/.test(names),
    );
    const provider = report.items.find((i) => i.name.startsWith("Provider"));
    ok("provider check skipped (offline)", provider?.ok === true && provider.detail === "skipped");
    const workspace = report.items.find((i) => i.name.includes("Workspace"));
    ok("workspace is writable", workspace?.ok === true);
    const leftovers = fs.readdirSync(ws).filter((f) => f.includes("openagent-health"));
    ok("no probe file left behind", leftovers.length === 0);

    // ---- 2. workspace failure path (a path under a FILE can't be a dir) ----
    const blocker = path.join(ws, "blocker.txt");
    fs.writeFileSync(blocker, "x");
    setActiveWorkspace(path.join(blocker, "sub"));
    const failing = await runHealthCheck({ skipProvider: true });
    const failingWs = failing.items.find((i) => i.name.includes("Workspace"));
    ok("unwritable workspace: item fails without throwing", failingWs?.ok === false);
    ok("a failing required item fails the report", failing.ok === false);
    ok("failing report formats as FAILED", formatHealthReport(failing).includes("Health check FAILED"));

    // ---- 3. formatting + required/optional semantics ----
    setActiveWorkspace(ws);
    const formatted = formatHealthReport(report);
    ok("format shows ✅ lines", formatted.includes("✅"));
    ok("format ends with a verdict line", /Health check (PASSED|FAILED)/.test(formatted));
    const optionalOnlyFailure: HealthReport = {
      ok: true,
      items: [
        { name: "Config", ok: true, severity: "required", detail: "ok" },
        { name: "Browser", ok: false, severity: "optional", detail: "missing" },
      ],
    };
    ok(
      "optional-only failures still PASS and are marked (optional)",
      formatHealthReport(optionalOnlyFailure).includes("Health check PASSED") &&
        formatHealthReport(optionalOnlyFailure).includes("(optional)"),
    );
  } finally {
    setActiveWorkspace("");
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nHEALTH VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
