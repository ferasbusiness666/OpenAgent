/**
 * longterm.ts — Phase-3 local long-term memory with from-scratch BM25 search.
 *
 * Notes are stored as one Markdown file per note under ~/.openagent/memory/
 * (overridable for tests). Each file carries a small YAML-ish frontmatter block
 * (id, tags, createdAt) followed by the note body. Recall is keyword search
 * implemented with the Okapi BM25 ranking function — no vector database, no
 * embeddings, and no third-party dependency.
 */

import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import { MEMORY_DIR } from "../paths.js";

/** A fully-parsed note loaded from disk. */
export interface MemoryNote {
  id: string;
  tags: string[];
  createdAt: string;
  content: string;
}

/** A single ranked recall result. */
export interface RecallHit {
  id: string;
  score: number;
  excerpt: string;
  tags: string[];
}

/** BM25 term-frequency saturation parameter. */
const BM25_K1 = 1.5;
/** BM25 length-normalization parameter. */
const BM25_B = 0.75;

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
 * Local, disk-backed long-term memory store with BM25 keyword recall.
 *
 * Storage layout (one file per note):
 *   <epochMs>-<rand>.md
 *   ---
 *   id: <id>
 *   tags: tag1, tag2
 *   createdAt: <ISO>
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
   * @param content The note body.
   * @param tags    Optional tags (trimmed; empties dropped).
   */
  remember(content: string, tags: string[] = []): { id: string; path: string } {
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

    const file = serializeNote({ id, tags: cleanTags, createdAt, content: body });
    fs.writeFileSync(filePath, file, "utf8");

    return { id, path: filePath };
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
    const N = corpus.length;
    if (N === 0) {
      return [];
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

    const scored: RecallHit[] = [];
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
 * Tags are stored as a comma-separated list.
 */
function serializeNote(note: MemoryNote): string {
  const tagLine = note.tags.join(", ");
  return (
    "---\n" +
    `id: ${note.id}\n` +
    `tags: ${tagLine}\n` +
    `createdAt: ${note.createdAt}\n` +
    "---\n" +
    note.content +
    "\n"
  );
}

/**
 * Parse a note file back into a MemoryNote. Tolerant of a missing/garbled
 * frontmatter block: in that case the entire file is treated as the content and
 * tags default to []. `fallbackId`/`fallbackCreatedAt` fill any field the
 * frontmatter omits.
 */
export function parseNote(raw: string, fallbackId: string): MemoryNote {
  const text = typeof raw === "string" ? raw : String(raw);

  // Frontmatter must start at the very top: "---\n ... \n---\n".
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      id: fallbackId,
      tags: [],
      createdAt: new Date(0).toISOString(),
      content: text.trim(),
    };
  }

  const frontmatter = fmMatch[1];
  const content = fmMatch[2] ?? "";

  let id = fallbackId;
  let tags: string[] = [];
  let createdAt = new Date(0).toISOString();

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
    }
  }

  return { id, tags, createdAt, content: content.replace(/\n+$/, "") };
}
