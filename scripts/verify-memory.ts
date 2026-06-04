/**
 * verify-memory.ts — offline verification for the LongTermMemory BM25 store.
 *
 * Runs against a throwaway temp directory so it never touches real user data.
 * Asserts ranking behaviour, list() count/ordering, and empty/no-match recall.
 * Prints "✓/✗ label" lines and a final "MEMORY VERIFY: PASS|FAIL", then exits
 * with code 0 (pass) or 1 (fail).
 */

import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { LongTermMemory } from "../src/memory/longterm.js";

const tmp = path.join(os.tmpdir(), "openagent-verify-memory-" + Date.now());
fs.removeSync(tmp);

let allPass = true;

/** Record and print a single check. */
function check(label: string, ok: boolean): void {
  if (!ok) {
    allPass = false;
  }
  console.log(`${ok ? "✓" : "✗"} ${label}`);
}

try {
  const mem = new LongTermMemory(tmp);

  // Empty corpus: recall must return [] before anything is remembered.
  check("empty corpus recall returns []", mem.recall("anything").length === 0);
  check("empty corpus list returns []", mem.list().length === 0);

  const notes = [
    "The deployment uses Docker and Kubernetes on AWS",
    "User prefers TypeScript with strict mode and no any types",
    "The database is PostgreSQL running on port 5432",
    "Kubernetes pods scale automatically based on CPU",
  ];
  const stored = notes.map((n, i) => mem.remember(n, [`note${i}`]));
  check("remember returns ids", stored.every((s) => s.id.length > 0));
  check("remember writes files", stored.every((s) => fs.existsSync(s.path)));

  // Ranking assertions.
  const kube = mem.recall("kubernetes scaling");
  const kubeTop = kube[0]?.excerpt ?? "";
  check(
    'recall("kubernetes scaling") ranks a Kubernetes note first',
    kube.length > 0 && kubeTop.toLowerCase().includes("kubernetes"),
  );

  const ts = mem.recall("typescript any");
  const tsTop = ts[0]?.excerpt ?? "";
  check(
    'recall("typescript any") surfaces the preferences note as top',
    ts.length > 0 &&
      tsTop.toLowerCase().includes("typescript") &&
      tsTop.toLowerCase().includes("any"),
  );

  const db = mem.recall("postgres database port");
  const dbTop = db[0]?.excerpt ?? "";
  check(
    'recall("postgres database port") surfaces the database note',
    db.length > 0 && dbTop.toLowerCase().includes("postgresql"),
  );

  // Scores must be positive and sorted descending.
  check(
    "recall scores are positive and sorted desc",
    kube.every((h) => h.score > 0) &&
      kube.every((h, i) => i === 0 || kube[i - 1].score >= h.score),
  );

  // list() count and ordering.
  const listing = mem.list();
  check("list() length === number remembered", listing.length === notes.length);
  check(
    "list() is newest-first by createdAt",
    listing.every(
      (e, i) => i === 0 || listing[i - 1].createdAt >= e.createdAt,
    ),
  );
  check("list() excerpts present", listing.every((e) => e.excerpt.length > 0));

  // No-match and empty-query recall must return [].
  check(
    "recall with no matching terms returns []",
    mem.recall("zzzz nonexistentterm qqqq").length === 0,
  );
  check("recall with empty query returns []", mem.recall("").length === 0);
  check(
    "recall with only short tokens returns []",
    mem.recall("a i x").length === 0,
  );
} catch (err) {
  allPass = false;
  console.log(`✗ unexpected error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  fs.removeSync(tmp);
}

console.log(`MEMORY VERIFY: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
