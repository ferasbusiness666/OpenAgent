/**
 * verify-unit.ts — unit tests (IMP-21)
 *
 * Tests:
 *  1. Config schema defaults and validation
 *  2. Sandbox path resolution
 *  3. Corrector retry logic
 *  4. SessionMemory message cap
 *  5. parseAgentResponse
 *  6. Usage tracking and cost estimation
 *  7. Net-guard SSRF protection (async)
 *  8. Audit log sanitization and append
 */

import { ConfigSchema, getConfig, saveConfig } from "../src/config/index.js";
import {
  resolveWorkspaceRelative,
  isInsidePath,
  PathTraversalError,
} from "../src/util/sandbox.js";
import { Corrector, MAX_FAILURES_PER_STEP } from "../src/agent/corrector.js";
import { SessionMemory, SESSION_MAX } from "../src/memory/session.js";
import { parseAgentResponse } from "../src/agent/loop.js";
import {
  estimateCostUsd,
  formatTokens,
  UsageTracker,
} from "../src/agent/usage.js";
import {
  checkUrlAllowed,
  registerLoopbackExemption,
} from "../src/util/net-guard.js";
import {
  sanitizeParams,
  appendAuditEntry,
  AUDIT_LOG_PATH,
} from "../src/audit.js";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => {
  checks.push([l, c]);
};

// ---- 1. Config schema -------------------------------------------------------

{
  // Empty object succeeds with defaults
  const r1 = ConfigSchema.safeParse({});
  ok("ConfigSchema: empty {} succeeds", r1.success);
  if (r1.success) {
    ok("ConfigSchema: budgetUsd defaults to 0", r1.data.budgetUsd === 0);
    ok(
      "ConfigSchema: allowLocalNetworkAccess defaults to false",
      r1.data.allowLocalNetworkAccess === false,
    );
    ok(
      "ConfigSchema: providerMode defaults to api",
      r1.data.providerMode === "api",
    );
  } else {
    ok("ConfigSchema: budgetUsd defaults to 0", false);
    ok("ConfigSchema: allowLocalNetworkAccess defaults to false", false);
    ok("ConfigSchema: providerMode defaults to api", false);
  }

  // Negative budgetUsd is rejected
  const r2 = ConfigSchema.safeParse({ budgetUsd: -5 });
  ok("ConfigSchema: negative budgetUsd fails", !r2.success);

  // Invalid providerMode is rejected
  const r3 = ConfigSchema.safeParse({ providerMode: "bogus" });
  ok("ConfigSchema: invalid providerMode fails", !r3.success);
}

// ---- 2. Sandbox -------------------------------------------------------------

{
  const ws = path.join(os.tmpdir(), "openagent-unit-sandbox-" + Date.now());
  fs.ensureDirSync(ws);

  // Paths that must be rejected
  const badPaths = [
    "../x",
    "a/../../x",
    "/etc/passwd",
    "\\\\x",
    "~/x",
    "C:\\Windows",
    "C:/Windows",
    "",
  ];
  for (const p of badPaths) {
    let threw = false;
    try {
      resolveWorkspaceRelative(p, ws);
    } catch (e) {
      threw = e instanceof PathTraversalError;
    }
    ok(`sandbox: rejects "${p}"`, threw);
  }

  // Valid path must succeed and land inside workspace
  let validResolved = "";
  let valid = false;
  try {
    validResolved = resolveWorkspaceRelative("a/b.txt", ws);
    valid = validResolved.startsWith(ws);
  } catch {
    valid = false;
  }
  ok("sandbox: accepts a/b.txt and returns path inside workspace", valid);

  // isInsidePath
  const base = ws;
  const sub = path.join(ws, "sub");
  const other = path.join(path.dirname(ws), "other");
  ok("isInsidePath: base,base → true", isInsidePath(base, base));
  ok("isInsidePath: base,base/sub → true", isInsidePath(base, sub));
  ok("isInsidePath: base,other → false", !isInsidePath(base, other));

  fs.removeSync(ws);
}

// ---- 3. Corrector -----------------------------------------------------------

{
  const c = new Corrector();

  // Record failures on same signature up to give-up
  const sig = "filesystem:{op:read}";
  const r1 = c.recordFailure(sig);
  ok("corrector: attempt 1, not giveUp", r1.attempt === 1 && !r1.giveUp);

  const r2 = c.recordFailure(sig);
  ok("corrector: attempt 2, not giveUp", r2.attempt === 2 && !r2.giveUp);

  const r3 = c.recordFailure(sig);
  ok(
    "corrector: attempt 3 = MAX_FAILURES_PER_STEP → giveUp",
    r3.attempt === MAX_FAILURES_PER_STEP && r3.giveUp,
  );
  ok("corrector: giveUp has backoffMs=0", r3.backoffMs === 0);

  // Different signature resets counter
  const sigB = "shell:{cmd:ls}";
  const r4 = c.recordFailure(sigB);
  ok(
    "corrector: different signature resets to attempt 1",
    r4.attempt === 1 && !r4.giveUp,
  );

  // reset() clears state
  c.reset();
  ok("corrector: reset clears count", c.count === 0);

  const r5 = c.recordFailure(sig);
  ok("corrector: after reset, attempt starts at 1", r5.attempt === 1);
}

// ---- 4. SessionMemory message cap -------------------------------------------

{
  const mem = new SessionMemory();

  // Add SESSION_MAX + 5 messages; after rollover history should be < SESSION_MAX
  for (let i = 0; i < SESSION_MAX + 5; i++) {
    mem.add({ role: "user", content: `msg ${i}`, timestamp: new Date() });
  }
  const history = mem.getHistory();
  // After rollover the history is [summaryNote, ...tail] so it must be < SESSION_MAX
  ok(
    `SessionMemory: history stays under cap after ${SESSION_MAX + 5} adds`,
    history.length < SESSION_MAX,
  );
  // The first message should be the system summary note
  ok(
    "SessionMemory: first message after rollover is system note",
    history[0]?.role === "system",
  );
}

// ---- 5. parseAgentResponse --------------------------------------------------

{
  // Fenced JSON block
  const fenced = `\`\`\`json
{
  "thought": "I will read a file",
  "action": "filesystem",
  "params": { "operation": "read", "path": "test.txt" }
}
\`\`\``;
  const r1 = parseAgentResponse(fenced);
  ok(
    "parseAgentResponse: parses fenced ```json block",
    "value" in r1 && r1.value.action === "filesystem",
  );

  // Plain prose (no JSON) → error
  const r2 = parseAgentResponse("I will now read the file for you.");
  ok(
    "parseAgentResponse: rejects plain prose with error",
    "error" in r2,
  );

  // JSON with invalid action → error
  const r3 = parseAgentResponse(
    JSON.stringify({ thought: "x", action: "explode", params: {} }),
  );
  ok(
    "parseAgentResponse: rejects invalid action",
    "error" in r3,
  );
}

// ---- 6. Usage: estimateCostUsd, UsageTracker, formatTokens ------------------

{
  // 1M input tokens @ $3/MTok for claude-sonnet-4 = $3
  const cost = estimateCostUsd("api:anthropic (claude-sonnet-4)", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
  });
  ok("usage: 1M input tokens for claude-sonnet-4 = $3", cost === 3);

  // Unknown model → $0
  const unknown = estimateCostUsd("totally-unknown-model-xyz", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
  });
  ok("usage: unknown model → 0", unknown === 0);

  // UsageTracker accumulates
  const tracker = new UsageTracker();
  tracker.add("api:anthropic (claude-sonnet-4)", {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
  });
  tracker.add("api:anthropic (claude-sonnet-4)", {
    inputTokens: 200,
    outputTokens: 80,
    cacheReadTokens: 0,
  });
  const totals = tracker.get();
  ok("UsageTracker: accumulates inputTokens", totals.inputTokens === 300);
  ok("UsageTracker: accumulates outputTokens", totals.outputTokens === 130);
  ok("UsageTracker: calls count", totals.calls === 2);

  // overBudget flips only when budgetUsd > 0 and cost >= budget
  ok("UsageTracker: overBudget false when budgetUsd=0", !tracker.overBudget());
  tracker.budgetUsd = 0.001; // set a tiny limit so it's definitely exceeded
  ok(
    "UsageTracker: overBudget true after budget reached",
    tracker.overBudget(),
  );

  // formatTokens
  ok('formatTokens(950) === "950"', formatTokens(950) === "950");
  ok('formatTokens(12431) === "12.4k"', formatTokens(12431) === "12.4k");
}

// ---- 7. net-guard (async) ---------------------------------------------------

async function runNetGuardTests(): Promise<void> {
  // Blocked URLs
  const blocked = [
    "http://192.168.1.1/",
    "http://10.0.0.5/",
    "http://172.20.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:9/",
    "http://localhost:9/",
    "file:///etc/passwd",
  ];
  for (const url of blocked) {
    const r = await checkUrlAllowed(url);
    ok(`net-guard: blocks "${url}"`, !r.allowed);
  }

  // data: URL is allowed
  const dataR = await checkUrlAllowed("data:text/html,<p>x</p>");
  ok("net-guard: allows data: URL", dataR.allowed);

  // 127.0.0.1 with allowLocal:true is allowed
  const localR = await checkUrlAllowed("http://127.0.0.1:9/", {
    allowLocal: true,
  });
  ok("net-guard: 127.0.0.1 allowed with {allowLocal:true}", localR.allowed);

  // Exemption: port 59999 is exempt, port 59998 is not
  registerLoopbackExemption((u) => u.port === "59999");
  const exemptR = await checkUrlAllowed("http://localhost:59999/");
  ok("net-guard: loopback exemption allows port 59999", exemptR.allowed);

  const blockedR = await checkUrlAllowed("http://localhost:59998/");
  ok("net-guard: non-exempt loopback port 59998 still blocked", !blockedR.allowed);
}

// ---- 8. Audit ---------------------------------------------------------------

function runAuditTests(): void {
  // sanitizeParams
  const params = {
    content: "x".repeat(500),
    apiKey: "secret",
    headers: { Authorization: "Bearer x", Accept: "application/json" },
    note: "y".repeat(300),
  };
  const sanitized = sanitizeParams(params);

  ok(
    'audit: content → "<500 chars>"',
    sanitized.content === "<500 chars>",
  );
  ok(
    'audit: apiKey → "<redacted>"',
    sanitized.apiKey === "<redacted>",
  );
  ok(
    "audit: headers.Authorization → <redacted>",
    (sanitized.headers as Record<string, unknown>)?.Authorization ===
      "<redacted>",
  );
  // note is a plain string >200 chars → truncated to 200 chars + "…"
  const note = sanitized.note as string;
  ok(
    "audit: note truncated to 200+ellipsis",
    typeof note === "string" && note.length === 201 && note.endsWith("…"),
  );

  // appendAuditEntry and read last line
  appendAuditEntry("unit-test", { content: "abc" }, true, "ok");

  let lastEntry: Record<string, unknown> | null = null;
  try {
    const raw = fs.readFileSync(AUDIT_LOG_PATH, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const lastLine = lines[lines.length - 1];
    if (lastLine) {
      lastEntry = JSON.parse(lastLine) as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  ok(
    'audit: last log line has tool==="unit-test"',
    lastEntry?.tool === "unit-test",
  );
  ok(
    'audit: last log line params.content === "<3 chars>"',
    (lastEntry?.params as Record<string, unknown>)?.content === "<3 chars>",
  );
}

// ---- Run everything ---------------------------------------------------------

async function main(): Promise<void> {
  // Save original config values we'll need to preserve
  const origConfig = getConfig();

  try {
    await runNetGuardTests();
    runAuditTests();
  } finally {
    // Restore any config keys that might have been affected
    saveConfig({
      budgetUsd: origConfig.budgetUsd,
      allowLocalNetworkAccess: origConfig.allowLocalNetworkAccess,
    });
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nUNIT VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
