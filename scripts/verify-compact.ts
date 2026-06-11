/**
 * verify-compact.ts — IMP-03: token-based context compaction.
 *  1. estimateTokens math.
 *  2. No-op below threshold; compaction above it (oldest half → system note).
 *  3. Custom limit, <4-message guard, persistence, and the 500-message
 *     rollover regression.
 */
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import {
  SessionMemory,
  estimateTokens,
  CONTEXT_TOKEN_LIMIT,
  COMPACT_THRESHOLD,
  type Message,
} from "../src/memory/session.js";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };

const msg = (content: string, role: Message["role"] = "tool_result"): Message => ({
  role,
  content,
  timestamp: new Date(),
});

function bigSession(count: number, charsEach: number): SessionMemory {
  const session = new SessionMemory();
  for (let i = 0; i < count; i += 1) {
    session.add(msg(`m${i} ` + "x".repeat(charsEach)));
  }
  return session;
}

function main(): void {
  // ---- 1. estimateTokens ----
  ok("estimateTokens: 400 chars ≈ 100 tokens", estimateTokens([msg("x".repeat(400))]) === 100);
  ok("estimateTokens: empty history → 0", estimateTokens([]) === 0);
  ok("constants: threshold is 70% of a 100k default",
    CONTEXT_TOKEN_LIMIT === 100_000 && COMPACT_THRESHOLD === 0.7);

  // ---- 2. no-op below threshold ----
  {
    const session = bigSession(10, 100);
    const before = session.getHistory().length;
    ok("small history: compactIfNeeded() is a no-op",
      session.compactIfNeeded() === false && session.getHistory().length === before);
  }

  // ---- 3. compaction above threshold ----
  {
    const session = bigSession(40, 20_000); // ≈ 200k tokens
    const before = session.estimateTokens();
    const compacted = session.compactIfNeeded();
    const history = session.getHistory();
    ok("large history: compactIfNeeded() returns true", compacted);
    ok("oldest half summarized: 40 → 21 messages", history.length === 21);
    ok("first message is the system summary note",
      history[0]?.role === "system" && (history[0]?.content.includes("summary") ?? false));
    ok("estimated tokens dropped substantially", session.estimateTokens() < before * 0.6);
  }

  // ---- 4. custom limit ----
  {
    const session = bigSession(40, 20_000); // ≈ 200k tokens < 70% of 1M
    ok("custom 1M limit: no compaction", session.compactIfNeeded(1_000_000) === false);
  }

  // ---- 5. <4 messages guard ----
  {
    const session = bigSession(3, 200_000);
    ok("under 4 messages: never compacts", session.compactIfNeeded() === false);
  }

  // ---- 6. persistence: bound file holds the compacted history ----
  {
    const file = path.join(os.tmpdir(), `openagent-compact-${Date.now()}.json`);
    try {
      const session = new SessionMemory();
      session.bindPersistence(file);
      for (let i = 0; i < 12; i += 1) {
        session.add(msg("y".repeat(40_000)));
      }
      const compacted = session.compactIfNeeded();
      const onDisk = fs.readJsonSync(file) as { messages?: unknown[] } | unknown[];
      const count = Array.isArray(onDisk)
        ? onDisk.length
        : Array.isArray(onDisk.messages)
          ? onDisk.messages.length
          : -1;
      ok("persisted file mirrors the compacted history",
        compacted && count === session.getHistory().length && session.getHistory().length === 7);
    } finally {
      fs.removeSync(file);
    }
  }

  // ---- 7. regression: the 500-message rollover is unchanged ----
  {
    const session = new SessionMemory();
    for (let i = 0; i < 500; i += 1) {
      session.add(msg(`short ${i}`, "user"));
    }
    const history = session.getHistory();
    ok("500-message rollover still yields [note, ...250] = 251",
      history.length === 251 && history[0]?.role === "system");
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nCOMPACT VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

main();
