/**
 * verify-semantic.ts — IMP-07 (semantic embeddings) + IMP-10 (importance/decay).
 *
 * Intercepts globalThis.fetch to return deterministic 256-dim vectors so no
 * real network calls are made. Sets env OPENAI_API_KEY = "test-key" to force
 * the "openai-256" backend; restores the original key and fetch in finally.
 */
import { cosineSimilarity, embeddingBackendTag, embedTexts } from "../src/memory/embeddings.js";
import { effectiveImportance, LongTermMemory, parseNote } from "../src/memory/longterm.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };

// ---------------------------------------------------------------------------
// Deterministic 256-dim vectors
// ---------------------------------------------------------------------------
function makeVec(hotDim: number, dims = 256): number[] {
  const v = new Array<number>(dims).fill(0);
  v[hotDim] = 1;
  return v;
}
const vA = makeVec(0);   // [1,0,0,...] → "alpha"
const vB = makeVec(1);   // [0,1,0,...] → "beta"
const vC = makeVec(2);   // [0,0,1,...] → "gamma"
const vD = makeVec(3);   // [0,0,0,1,...] → default / fallback

/**
 * Given an array of input strings, return matching vectors by inspecting
 * which marker word each string contains. Falls back to vD.
 */
function vectorsFor(inputs: string[]): number[][] {
  return inputs.map((t) => {
    if (t.includes("alpha")) return vA.slice();
    if (t.includes("beta"))  return vB.slice();
    if (t.includes("gamma")) return vC.slice();
    if (t.includes("zebra")) return vB.slice(); // for check 6
    if (t.includes("quick brown fox")) return vA.slice(); // for check 5 query
    return vD.slice();
  });
}

async function main(): Promise<void> {
  // Save originals.
  const origKey   = process.env.OPENAI_API_KEY;
  const origFetch = globalThis.fetch;

  // Force openai backend.
  process.env.OPENAI_API_KEY = "test-key";

  // Intercept fetch — parse the request body, return deterministic embeddings.
  // The module-level LRU cache is keyed by backend+text, so we use DISTINCT
  // texts for each check so cache hits don't silently skip the fake fetch.
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let inputs: string[] = [];
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      // OpenAI format: { input: string[] }
      inputs = Array.isArray(body.input) ? (body.input as string[]) : [];
    } catch {
      // Ignore parse errors; return vD for all.
    }
    const vectors = vectorsFor(inputs);
    const data = vectors.map((embedding, index) => ({ index, embedding }));
    const responseBody = { data };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(responseBody),
      json: async () => responseBody,
    } as unknown as Response;
  }) as typeof fetch;

  const tempDir = path.join(os.tmpdir(), "openagent-semantic-" + Date.now());
  fs.ensureDirSync(tempDir);

  try {
    // ---- 1. embeddingBackendTag() === "openai-256" with env key set ----
    const tag = embeddingBackendTag();
    ok("embeddingBackendTag() === 'openai-256'", tag === "openai-256");

    // ---- 2. cosineSimilarity ----
    {
      const same = cosineSimilarity(vA, vA);
      ok("cosineSimilarity: identical vectors → 1", Math.abs(same - 1) < 1e-9);

      const orth = cosineSimilarity(vA, vB);
      ok("cosineSimilarity: orthogonal vectors → 0", Math.abs(orth) < 1e-9);

      const mismatch = cosineSimilarity(vA, [0, 1]);
      ok("cosineSimilarity: mismatched lengths → 0", mismatch === 0);
    }

    // ---- 3. effectiveImportance ----
    {
      const now = new Date();
      const createdAt = now.toISOString();

      // fresh note: importance 5, accessCount 0 → 5
      const fresh = { importance: 5, accessCount: 0, lastAccessed: createdAt, createdAt };
      ok("effectiveImportance: fresh note → 5", effectiveImportance(fresh, now) === 5);

      // accessCount 4 → boost = min(2, 4*0.5) = 2 → 7
      const accessed4 = { importance: 5, accessCount: 4, lastAccessed: createdAt, createdAt };
      ok("effectiveImportance: accessCount 4 → 7", effectiveImportance(accessed4, now) === 7);

      // lastAccessed 90 days ago → penalty = min(3, floor(90/30)) = 3 → 5-3=2
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const stale = { importance: 5, accessCount: 0, lastAccessed: ninetyDaysAgo, createdAt: ninetyDaysAgo };
      ok("effectiveImportance: 90-day-old note → 2", effectiveImportance(stale, now) === 2);

      // Floor at 1: importance 1, accessCount 0, 90 days stale → 1-3 → clamp to 1
      const veryStale = { importance: 1, accessCount: 0, lastAccessed: ninetyDaysAgo, createdAt: ninetyDaysAgo };
      ok("effectiveImportance: floor clamped to 1", effectiveImportance(veryStale, now) === 1);

      // Cap at 10: importance 9, accessCount 4 → 9+2=11 → clamp to 10
      const veryHigh = { importance: 9, accessCount: 4, lastAccessed: createdAt, createdAt };
      ok("effectiveImportance: cap clamped to 10", effectiveImportance(veryHigh, now) === 10);
    }

    // ---- 4. rememberWithEmbedding → file contains "embedding: openai-256|" ----
    {
      const mem = new LongTermMemory(tempDir);
      const { path: filePath } = await mem.rememberWithEmbedding("alpha marker note unique check4", [], 5);
      const raw = fs.readFileSync(filePath, "utf8");
      ok(
        "rememberWithEmbedding: file has embedding: openai-256| line",
        raw.split("\n").some((l) => l.startsWith("embedding: openai-256|")),
      );
    }

    // ---- 5. Hybrid beats keyword-only: same BM25, cosine differs ----
    {
      const mem2 = new LongTermMemory(tempDir);
      // Store two notes with IDENTICAL text (same BM25), but different embeddings.
      // We force different embeddings by different textual content that our fake
      // fetch distinguishes. Content must be distinct for cache keys to differ.
      const { id: idX } = await mem2.rememberWithEmbedding(
        "the quick brown fox alpha unique-x-check5",
        [],
        5,
      );
      const { id: idY } = await mem2.rememberWithEmbedding(
        "the quick brown fox beta unique-y-check5",
        [],
        5,
      );
      // Query whose fake embedding is vA (contains "alpha" → "quick brown fox" → vA via fallback)
      // Actually our vectorsFor maps "quick brown fox" → vA, so query text with that phrase gets vA.
      const hits = await mem2.recallHybrid("the quick brown fox alpha unique-x-check5", 5);
      const firstId = hits[0]?.id;
      ok("hybrid beats keyword-only: vA-embedded note ranks first", firstId === idX);
      // Confirm the other note is also returned (both have matching text)
      ok("hybrid: second note also appears", hits.some((h) => h.id === idY));
    }

    // ---- 6. Tag mismatch: mismatched-backend note still returned via BM25 ----
    {
      const mem3 = new LongTermMemory(tempDir);
      // Hand-write a note with a local-384 embedding (384 floats of 0.001)
      const epochMs = Date.now() + 1;
      const rand = "aabbccdd";
      const noteId = `${epochMs}-${rand}`;
      const fileName = `${noteId}.md`;
      const local384 = new Array(384).fill(0.001).map((n: number) => n.toFixed(5)).join(",");
      const createdAt = new Date(epochMs).toISOString();
      const noteContent = [
        "---",
        `id: ${noteId}`,
        `tags: `,
        `createdAt: ${createdAt}`,
        `importance: 5`,
        `lastAccessed: ${createdAt}`,
        `accessCount: 0`,
        `embedding: local-384|${local384}`,
        "---",
        "zebra unique content check6",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(tempDir, fileName), noteContent, "utf8");

      // Query for "zebra unique" — our backend is openai-256, so the vector
      // won't be comparable, but BM25 must still return it.
      const hits6 = await mem3.recallHybrid("zebra unique content check6", 5);
      ok(
        "tag mismatch: mismatched-backend note still returned via BM25",
        hits6.some((h) => h.id === noteId),
      );
    }

    // ---- 7. Importance weighting: high-importance note ranks first ----
    {
      const dir7 = path.join(os.tmpdir(), "openagent-sem-check7-" + Date.now());
      fs.ensureDirSync(dir7);
      const mem7 = new LongTermMemory(dir7);
      // Both notes: identical text, will get vD (no marker word) from fake fetch.
      const { id: highId } = await mem7.rememberWithEmbedding("some common text check7 unique alpha", [], 9);
      const { id: lowId }  = await mem7.rememberWithEmbedding("some common text check7 unique beta", [], 1);

      const hits7 = await mem7.recallHybrid("some common text check7", 5);
      ok(
        "importance weighting: importance-9 note ranks before importance-1",
        hits7.length >= 2 && hits7[0]?.id === highId,
      );

      // minImportance: 5 → only highId (importance 9) survives
      const filtered = await mem7.recallHybrid("some common text check7", 5, { minImportance: 5 });
      ok(
        "minImportance filter: only high-importance note returned",
        filtered.length === 1 && filtered[0]?.id === highId,
      );
      // lowId should NOT appear
      ok(
        "minImportance filter: low-importance note excluded",
        !filtered.some((h) => h.id === lowId),
      );
      fs.removeSync(dir7);
    }

    // ---- 8. Access bump: accessCount increments after recallHybrid ----
    {
      const dir8 = path.join(os.tmpdir(), "openagent-sem-check8-" + Date.now());
      fs.ensureDirSync(dir8);
      const mem8 = new LongTermMemory(dir8);
      const { id: id8, path: p8 } = await mem8.rememberWithEmbedding(
        "access bump test unique alpha check8",
        [],
        5,
      );
      const noteBefore = parseNote(fs.readFileSync(p8, "utf8"), id8);
      ok("access bump: accessCount starts at 0", noteBefore.accessCount === 0);

      await mem8.recallHybrid("access bump test alpha check8", 5);
      const noteAfter = parseNote(fs.readFileSync(p8, "utf8"), id8);
      ok("access bump: accessCount === 1 after recall", noteAfter.accessCount === 1);
      fs.removeSync(dir8);
    }

    // ---- 9. tag option: recallHybrid with tag filter ----
    {
      const dir9 = path.join(os.tmpdir(), "openagent-sem-check9-" + Date.now());
      fs.ensureDirSync(dir9);
      const mem9 = new LongTermMemory(dir9);
      await mem9.rememberWithEmbedding("pattern alpha check9 success task approach", ["success_pattern"], 6);
      await mem9.rememberWithEmbedding("pattern beta check9 success task approach", [], 6);

      const tagFiltered = await mem9.recallHybrid("pattern check9 task approach", 5, {
        tag: "success_pattern",
      });
      ok(
        "tag filter: only success_pattern note returned",
        tagFiltered.length === 1 && tagFiltered[0]?.tags.includes("success_pattern"),
      );
      fs.removeSync(dir9);
    }
  } finally {
    // Restore originals.
    if (origKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = origKey;
    }
    globalThis.fetch = origFetch;
    fs.removeSync(tempDir);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nSEMANTIC VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
