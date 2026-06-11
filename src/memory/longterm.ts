/**
 * longterm.ts — Phase-3 local long-term memory with from-scratch BM25 search,
 * now extended (IMP-07/IMP-10) with optional semantic recall and importance.
 *
 * Notes are stored as one Markdown file per note under ~/.openagent/memory/
 * (overridable for tests). Each file carries a small YAML-ish frontmatter block
 * (id, tags, createdAt, plus the optional importance/lastAccessed/accessCount/
 * embedding fields) followed by the note body.
 *
 * Recall comes in two flavors:
 *   - recall()       — synchronous Okapi BM25 keyword search (the UI uses this).
 *   - recallHybrid()  — BM25 blended 50/50 with cosine similarity over per-note
 *                      embeddings, weighted by importance-with-decay. Degrades
 *                      gracefully to keyword-only when no embedding backend is
 *                      available or a note has no stored vector.
 *
 * No vector database — brute-force cosine over a personal-scale corpus is exact
 * and cheap, and stored vectors keep zero third-party runtime dependencies.
 */

import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import { MEMORY_DIR } from "../paths.js";
import {
  embedTexts,
  embeddingBackendTag,
  cosineSimilarity,
} from "./embeddings.js";

/** A fully-parsed note loaded from disk. */
export interface MemoryNote {
  id: string;
  tags: string[];
  createdAt: string;
  content: string;
  /** Subjective importance, 1–10 (default 5). */
  importance: number;
  /** ISO timestamp of the last time recall surfaced this note (default createdAt). */
  lastAccessed: string;
  /** How many times recall has surfaced this note (default 0). */
  accessCount: number;
  /** Stored embedding vector, or null when none has been computed yet. */
  embedding: number[] | null;
  /** Which model produced the vector (e.g. "openai-256", "local-384"); vectors
   *  are only compared when this matches the current query backend. */
  embeddingBackend: string | null;
}

/** A single ranked recall result. */
export interface RecallHit {
  id: string;
  score: number;
  excerpt: string;
  tags: string[];
  /** IMP-10: the note's effective importance at query time (recallHybrid only). */
  importance?: number;
}

/** BM25 term-frequency saturation parameter. */
const BM25_K1 = 1.5;
/** BM25 length-normalization parameter. */
const BM25_B = 0.75;

/** Default importance when a note doesn't specify one. */
const DEFAULT_IMPORTANCE = 5;
/** Importance bounds. */
const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 10;

/** Clamp an arbitrary number into the [1, 10] importance range (NaN → default). */
function clampImportance(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_IMPORTANCE;
  }
  return Math.max(MIN_IMPORTANCE, Math.min(MAX_IMPORTANCE, Math.round(value)));
}

/** Tokenize text for indexing/search: lowercase, split on non-alphanumerics, drop <2-char tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2);
}

/** Collapse all runs of whitespace to single spaces and trim. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A note plus its precomputed token stats, used internally during recall. */
interface IndexedNote {
  note: MemoryNote;
  termFreq: Map<string, number>;
  length: number;
}

/**
 * IMP-10: importance with decay.
 *
 * Starts from the note's base importance, adds a retrieval-frequency boost
 * (accessCount * 0.5, capped at +2), and subtracts a staleness penalty (−1 per
 * full 30 days since lastAccessed, capped at −3). The result is clamped to
 * [1, 10]. Pure and exported so verification can assert it directly.
 */
export function effectiveImportance(
  note: Pick<MemoryNote, "importance" | "accessCount" | "lastAccessed" | "createdAt">,
  now: Date = new Date(),
): number {
  const base = clampImportance(note.importance);

  const accessCount =
    Number.isFinite(note.accessCount) && note.accessCount > 0
      ? note.accessCount
      : 0;
  const boost = Math.min(2, accessCount * 0.5);

  // Staleness: full 30-day periods elapsed since lastAccessed (fallback createdAt).
  const ref = Date.parse(note.lastAccessed) || Date.parse(note.createdAt);
  let penalty = 0;
  if (Number.isFinite(ref)) {
    const ageMs = now.getTime() - ref;
    if (ageMs > 0) {
      const periods = Math.floor(ageMs / (30 * 24 * 60 * 60 * 1000));
      penalty = Math.min(3, periods);
    }
  }

  const effective = base + boost - penalty;
  return Math.max(MIN_IMPORTANCE, Math.min(MAX_IMPORTANCE, effective));
}

/**
 * Local, disk-backed long-term memory store with BM25 keyword recall and
 * optional embedding-based semantic recall.
 *
 * Storage layout (one file per note):
 *   <epochMs>-<rand>.md
 *   ---
 *   id: <id>
 *   tags: tag1, tag2
 *   createdAt: <ISO>
 *   importance: 5
 *   lastAccessed: <ISO>
 *   accessCount: 0
 *   embedding: 0.01234,-0.05678,...   (optional)
 *   ---
 *   <content>
 */
export class LongTermMemory {
  private readonly dir: string;

  /**
   * @param dir Directory to store notes in. Defaults to the global MEMORY_DIR;
   *            pass a temp dir to make the store unit-testable in isolation.
   */
  constructor(dir?: string) {
    this.dir = dir ?? MEMORY_DIR;
    fs.ensureDirSync(this.dir);
  }

  /**
   * Persist a new note and return its id and absolute file path.
   *
   * @param content    The note body.
   * @param tags       Optional tags (trimmed; empties dropped).
   * @param importance Optional importance 1–10 (clamped; default 5).
   */
  remember(
    content: string,
    tags: string[] = [],
    importance?: number,
  ): { id: string; path: string } {
    const body = typeof content === "string" ? content : String(content);
    const cleanTags = Array.isArray(tags)
      ? tags
          .map((t) => (typeof t === "string" ? t.trim() : String(t).trim()))
          .filter((t) => t.length > 0)
      : [];

    const epochMs = Date.now();
    const rand = crypto.randomBytes(4).toString("hex");
    const id = `${epochMs}-${rand}`;
    const fileName = `${id}.md`;
    const filePath = path.join(this.dir, fileName);
    const createdAt = new Date(epochMs).toISOString();

    const note: MemoryNote = {
      id,
      tags: cleanTags,
      createdAt,
      content: body,
      importance:
        importance === undefined
          ? DEFAULT_IMPORTANCE
          : clampImportance(importance),
      lastAccessed: createdAt,
      accessCount: 0,
      embedding: null,
      embeddingBackend: null,
    };
    fs.writeFileSync(filePath, serializeNote(note), "utf8");

    return { id, path: filePath };
  }

  /**
   * IMP-07: persist a note (immediately, without a vector) and then best-effort
   * embed its content, rewriting the file with the embedding when it arrives.
   * Never throws — if embedding is unavailable the note simply stays vector-less
   * and will be recalled by keywords only.
   */
  async rememberWithEmbedding(
    content: string,
    tags: string[] = [],
    importance?: number,
  ): Promise<{ id: string; path: string }> {
    const result = this.remember(content, tags, importance);

    try {
      const body = typeof content === "string" ? content : String(content);
      const vectors = await embedTexts([body]);
      const vec = vectors?.[0];
      if (vec && vec.length > 0) {
        const note = this.readNoteFile(result.path);
        if (note !== null) {
          note.embedding = vec;
          note.embeddingBackend = embeddingBackendTag();
          fs.writeFileSync(result.path, serializeNote(note), "utf8");
        }
      }
    } catch {
      // Best-effort only — keep the (already-written) vector-less note.
    }

    return result;
  }

  /**
   * Rank stored notes against `query` using BM25 and return the top hits.
   *
   * @param query The search query.
   * @param topK  Maximum number of hits to return (default 5).
   * @returns Hits with score > 0, sorted by descending score. [] if the corpus
   *          is empty or the query has no usable terms / no matches.
   */
  recall(query: string, topK = 5): RecallHit[] {
    const queryTerms = tokenize(typeof query === "string" ? query : "");
    if (queryTerms.length === 0) {
      return [];
    }

    const corpus = this.loadIndexed();
    if (corpus.length === 0) {
      return [];
    }

    const bm25 = this.scoreBm25(corpus, queryTerms);

    const scored: RecallHit[] = [];
    for (const doc of corpus) {
      const score = bm25.get(doc.note.id) ?? 0;
      if (score > 0) {
        scored.push({
          id: doc.note.id,
          score,
          excerpt: collapseWhitespace(doc.note.content).slice(0, 200),
          tags: doc.note.tags,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const k = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 5;
    return scored.slice(0, k);
  }

  /**
   * IMP-07 hybrid recall: normalized BM25 (divided by the max BM25 score this
   * query) blended 50/50 with the cosine similarity (clamped to [0,1]) of the
   * query embedding against each note's stored vector. A note with no vector —
   * or when the query itself can't be embedded — scores on its normalized BM25
   * alone. Each blended score is multiplied by an importance weight
   * (0.6 + 0.08 * effectiveImportance). Hits with final score > 0, sorted desc,
   * top K.
   *
   * Side effect: for the returned hits, bumps accessCount and lastAccessed and
   * rewrites those files (best-effort; errors swallowed).
   *
   * @param options.tag           Restrict to notes carrying this tag BEFORE ranking.
   * @param options.minImportance Drop notes whose effectiveImportance is below it.
   */
  async recallHybrid(
    query: string,
    topK = 5,
    options: { tag?: string; minImportance?: number } = {},
  ): Promise<RecallHit[]> {
    const q = typeof query === "string" ? query : "";
    const queryTerms = tokenize(q);

    let corpus = this.loadIndexed();
    if (corpus.length === 0) {
      return [];
    }

    const now = new Date();

    // Tag filter (pre-ranking).
    const tag = typeof options.tag === "string" ? options.tag.trim() : "";
    if (tag.length > 0) {
      corpus = corpus.filter((doc) => doc.note.tags.includes(tag));
    }

    // Importance floor (pre-ranking).
    if (
      typeof options.minImportance === "number" &&
      Number.isFinite(options.minImportance)
    ) {
      const floor = options.minImportance;
      corpus = corpus.filter(
        (doc) => effectiveImportance(doc.note, now) >= floor,
      );
    }

    if (corpus.length === 0) {
      return [];
    }

    // --- BM25 component (normalized by the max score in this query) ---
    const bm25 =
      queryTerms.length > 0
        ? this.scoreBm25(corpus, queryTerms)
        : new Map<string, number>();
    let maxBm25 = 0;
    for (const v of bm25.values()) {
      if (v > maxBm25) {
        maxBm25 = v;
      }
    }

    // --- Cosine component (best-effort; null query vector → keyword-only) ---
    let queryVec: number[] | null = null;
    const queryTag = embeddingBackendTag();
    try {
      const embedded = await embedTexts([q]);
      const candidate = embedded?.[0];
      if (candidate && candidate.length > 0) {
        queryVec = candidate;
      }
    } catch {
      queryVec = null;
    }

    // A note's vector is comparable only when the SAME model produced it.
    // Untagged vectors (written before backend tagging) are accepted when
    // their dimensionality matches the current backend's.
    const comparable = (note: MemoryNote): boolean =>
      note.embedding !== null &&
      queryVec !== null &&
      (note.embeddingBackend === queryTag ||
        (note.embeddingBackend === null && note.embedding.length === queryVec.length));

    const scored: RecallHit[] = [];
    for (const doc of corpus) {
      const rawBm25 = bm25.get(doc.note.id) ?? 0;
      const normBm25 = maxBm25 > 0 ? rawBm25 / maxBm25 : 0;

      let blended: number;
      if (queryVec !== null && doc.note.embedding !== null && comparable(doc.note)) {
        // Cosine in [-1,1] → clamp the negative half away to [0,1].
        const cos = Math.max(
          0,
          Math.min(1, cosineSimilarity(queryVec, doc.note.embedding)),
        );
        blended = 0.5 * normBm25 + 0.5 * cos;
      } else {
        // No usable vector on one side → keyword-only.
        blended = normBm25;
      }

      const eff = effectiveImportance(doc.note, now);
      const weight = 0.6 + 0.08 * eff;
      const final = blended * weight;

      if (final > 0) {
        scored.push({
          id: doc.note.id,
          score: final,
          excerpt: collapseWhitespace(doc.note.content).slice(0, 200),
          tags: doc.note.tags,
          importance: eff,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const k = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 5;
    const hits = scored.slice(0, k);

    // Side effect: bump access stats for the returned hits (best-effort).
    const nowIso = now.toISOString();
    for (const hit of hits) {
      try {
        const filePath = path.join(this.dir, `${hit.id}.md`);
        const note = this.readNoteFile(filePath);
        if (note !== null) {
          note.accessCount += 1;
          note.lastAccessed = nowIso;
          fs.writeFileSync(filePath, serializeNote(note), "utf8");
        }
      } catch {
        // Swallow — access-stat bumps must never fail a recall.
      }
    }

    return hits;
  }

  /** Full content of one note by id, or null if it does not exist / can't be read. */
  read(id: string): string | null {
    const safeId = typeof id === "string" ? id.trim() : "";
    if (safeId.length === 0) {
      return null;
    }
    const filePath = path.join(this.dir, `${safeId}.md`);
    const note = this.readNoteFile(filePath);
    return note === null ? null : note.content;
  }

  /**
   * List all stored notes, newest first (by createdAt descending).
   * Each entry includes a short (~120 char) whitespace-collapsed excerpt.
   */
  list(): Array<{ id: string; tags: string[]; createdAt: string; excerpt: string }> {
    const notes = this.loadAll();
    notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return notes.map((n) => ({
      id: n.id,
      tags: n.tags,
      createdAt: n.createdAt,
      excerpt: collapseWhitespace(n.content).slice(0, 120),
    }));
  }

  /**
   * Compute the BM25 score for every note in `corpus` against `queryTerms`,
   * keyed by note id. Notes that match no term are simply absent from the map.
   * The math here is intentionally identical to the original recall() so its
   * ranking behavior is unchanged.
   */
  private scoreBm25(
    corpus: IndexedNote[],
    queryTerms: string[],
  ): Map<string, number> {
    const N = corpus.length;
    const result = new Map<string, number>();
    if (N === 0 || queryTerms.length === 0) {
      return result;
    }

    // Document frequency per term across the corpus.
    const docFreq = new Map<string, number>();
    let totalLength = 0;
    for (const doc of corpus) {
      totalLength += doc.length;
      for (const term of doc.termFreq.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    const avgdl = totalLength / N;

    // Deduplicate query terms — repeating a term should not multiply its weight.
    const uniqueQueryTerms = Array.from(new Set(queryTerms));

    // Precompute IDF for each query term.
    const idf = new Map<string, number>();
    for (const term of uniqueQueryTerms) {
      const df = docFreq.get(term) ?? 0;
      // Okapi BM25 IDF; the +1 inside ln keeps it non-negative for all df.
      idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }

    for (const doc of corpus) {
      let score = 0;
      for (const term of uniqueQueryTerms) {
        const tf = doc.termFreq.get(term);
        if (tf === undefined || tf === 0) {
          continue;
        }
        const termIdf = idf.get(term) ?? 0;
        const denom =
          tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / (avgdl || 1)));
        score += termIdf * ((tf * (BM25_K1 + 1)) / (denom || 1));
      }
      if (score > 0) {
        result.set(doc.note.id, score);
      }
    }

    return result;
  }

  /** Absolute paths of all `.md` note files in the store (unreadable dirs -> []). */
  private noteFiles(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(this.dir, name));
  }

  /** Load and parse every note, skipping any file that cannot be read/parsed. */
  private loadAll(): MemoryNote[] {
    const notes: MemoryNote[] = [];
    for (const filePath of this.noteFiles()) {
      const note = this.readNoteFile(filePath);
      if (note !== null) {
        notes.push(note);
      }
    }
    return notes;
  }

  /** Load all notes with their BM25 token statistics precomputed. */
  private loadIndexed(): IndexedNote[] {
    const indexed: IndexedNote[] = [];
    for (const note of this.loadAll()) {
      const tokens = tokenize(note.content);
      const termFreq = new Map<string, number>();
      for (const tok of tokens) {
        termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
      }
      indexed.push({ note, termFreq, length: tokens.length });
    }
    return indexed;
  }

  /** Read one note file into a MemoryNote, or null if it cannot be read. */
  private readNoteFile(filePath: string): MemoryNote | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    const fallbackId = path.basename(filePath, ".md");
    return parseNote(raw, fallbackId);
  }
}

/**
 * Serialize a note into its on-disk Markdown-with-frontmatter representation.
 * Tags are stored as a comma-separated list. The optional importance/access/
 * embedding fields are always written so files round-trip cleanly, but old
 * files lacking them still parse (see parseNote).
 */
function serializeNote(note: MemoryNote): string {
  const tagLine = note.tags.join(", ");
  const lines = [
    "---",
    `id: ${note.id}`,
    `tags: ${tagLine}`,
    `createdAt: ${note.createdAt}`,
    `importance: ${clampImportance(note.importance)}`,
    `lastAccessed: ${note.lastAccessed}`,
    `accessCount: ${Number.isFinite(note.accessCount) ? Math.max(0, Math.floor(note.accessCount)) : 0}`,
  ];
  if (note.embedding !== null && note.embedding.length > 0) {
    const tagPrefix = note.embeddingBackend !== null ? `${note.embeddingBackend}|` : "";
    lines.push(`embedding: ${tagPrefix}${serializeEmbedding(note.embedding)}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n" + note.content + "\n";
}

/** Serialize a vector as comma-separated floats with 5 decimals of precision. */
function serializeEmbedding(vec: number[]): string {
  return vec.map((n) => n.toFixed(5)).join(",");
}

/**
 * Parse an `embedding:` frontmatter value into a vector + its backend tag,
 * tolerantly. Format: `[<backend>|]f1,f2,…` — the tag prefix is optional
 * (vectors written before tagging have none). Any non-finite component or an
 * empty value yields null (treated as "no embedding").
 */
function parseEmbedding(value: string): { vector: number[]; backend: string | null } | null {
  let trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let backend: string | null = null;
  const pipe = trimmed.indexOf("|");
  if (pipe > 0) {
    const tag = trimmed.slice(0, pipe).trim();
    if (tag.length > 0 && !tag.includes(",")) {
      backend = tag;
      trimmed = trimmed.slice(pipe + 1).trim();
    }
  }
  const parts = trimmed.split(",");
  if (parts.length < 2) {
    return null;
  }
  const vec: number[] = [];
  for (const part of parts) {
    const n = Number(part.trim());
    if (!Number.isFinite(n)) {
      return null;
    }
    vec.push(n);
  }
  return { vector: vec, backend };
}

/**
 * Parse a note file back into a MemoryNote. Tolerant of a missing/garbled
 * frontmatter block: in that case the entire file is treated as the content and
 * all fields default. `fallbackId` fills the id when the frontmatter omits it.
 *
 * Backward compatible: notes written before IMP-07/IMP-10 (no importance/
 * lastAccessed/accessCount/embedding) parse fine — importance→5,
 * lastAccessed→createdAt, accessCount→0, embedding→null.
 */
export function parseNote(raw: string, fallbackId: string): MemoryNote {
  const text = typeof raw === "string" ? raw : String(raw);

  // Frontmatter must start at the very top: "---\n ... \n---\n".
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    const createdAt = new Date(0).toISOString();
    return {
      id: fallbackId,
      tags: [],
      createdAt,
      content: text.trim(),
      importance: DEFAULT_IMPORTANCE,
      lastAccessed: createdAt,
      accessCount: 0,
      embedding: null,
      embeddingBackend: null,
    };
  }

  const frontmatter = fmMatch[1];
  const content = fmMatch[2] ?? "";

  let id = fallbackId;
  let tags: string[] = [];
  let createdAt = new Date(0).toISOString();
  let importance = DEFAULT_IMPORTANCE;
  let lastAccessed = "";
  let accessCount = 0;
  let embedding: number[] | null = null;
  let embeddingBackend: string | null = null;

  for (const line of frontmatter.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === "id" && value.length > 0) {
      id = value;
    } else if (key === "tags") {
      tags = value
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    } else if (key === "createdat" && value.length > 0) {
      createdAt = value;
    } else if (key === "importance" && value.length > 0) {
      importance = clampImportance(Number(value));
    } else if (key === "lastaccessed" && value.length > 0) {
      lastAccessed = value;
    } else if (key === "accesscount" && value.length > 0) {
      const n = Number(value);
      accessCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } else if (key === "embedding") {
      const parsed = parseEmbedding(value);
      embedding = parsed?.vector ?? null;
      embeddingBackend = parsed?.backend ?? null;
    }
  }

  return {
    id,
    tags,
    createdAt,
    content: content.replace(/\n+$/, ""),
    importance,
    // Missing lastAccessed defaults to createdAt.
    lastAccessed: lastAccessed.length > 0 ? lastAccessed : createdAt,
    accessCount,
    embedding,
    embeddingBackend,
  };
}
