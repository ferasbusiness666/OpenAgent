/**
 * SessionMemory — holds the conversation history for the current session.
 *
 * The history is kept in memory (a private array). When a persistence path is
 * bound via bindPersistence(), the history is also mirrored to that file and
 * re-written on every change, so a session can be reloaded later.
 *
 * Sessions are capped at SESSION_MAX messages. When the cap is reached the full
 * transcript on disk becomes an archive, the oldest SESSION_SUMMARIZE messages
 * are condensed into a single "system" note (so no context is lost), and the
 * session continues in a fresh file with [note, ...recent tail]. Durable
 * cross-session memory still lives in AGENT.md (see agent-md.ts).
 */

import fs from "fs-extra";
import {
  serializeMessages,
  deserializeMessages,
  newSessionFilePath,
} from "./session-store.js";

/** A single entry in the session conversation history. */
export type Message = {
  role: "user" | "assistant" | "tool_result" | "system";
  content: string;
  timestamp: Date;
};

/** Hard cap on messages kept in a single session file before rolling over. */
export const SESSION_MAX = 500;
/** How many of the oldest messages are summarized into one note on rollover. */
export const SESSION_SUMMARIZE = 250;

/** Conservative default context budget (tokens) across supported models. */
export const CONTEXT_TOKEN_LIMIT = 100_000;
/** Fraction of the limit at which token compaction triggers (IMP-03's 70%). */
export const COMPACT_THRESHOLD = 0.7;

/** Tool-result messages this many positions back are eligible for pruning
 *  (the most recent N are always kept verbatim). */
export const PRUNE_KEEP_RECENT_RESULTS = 5;

/** Default relevance score below which a stale tool_result may be pruned. */
const PRUNE_DEFAULT_THRESHOLD = 0.08;
/** Default minimum content length (chars) before a tool_result is prunable. */
const PRUNE_DEFAULT_MIN_CHARS = 600;

/**
 * Lowercased, deduplicated word set used for Jaccard relevance scoring.
 * Tokens shorter than 3 chars are dropped as low-signal (articles, "to", etc.).
 */
function tokenSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 3) {
      set.add(token);
    }
  }
  return set;
}

/**
 * Jaccard overlap (|A ∩ B| / |A ∪ B|) between two texts' token sets. Returns 0
 * when either side has no qualifying tokens, so empty focus text prunes nothing.
 */
function jaccardOverlap(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Rough token estimate for messages: ceil(content chars / 4), summed. */
export function estimateTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += Math.ceil(m.content.length / 4);
  }
  return total;
}

/** Build a compact, deterministic summary note from archived messages.
 *  `reason` explains WHY the archive happened (message cap vs. token budget). */
function summarizeArchived(messages: Message[], reason: string): string {
  const firstLine = (text: string): string => {
    const line = text.split(/\r?\n/)[0] ?? "";
    return line.length > 120 ? `${line.slice(0, 120)}…` : line;
  };
  const userTasks = messages
    .filter((m) => m.role === "user")
    .map((m) => `- ${firstLine(m.content)}`);
  const tail = userTasks.slice(-12);
  const counts = messages.reduce<Record<string, number>>((acc, m) => {
    acc[m.role] = (acc[m.role] ?? 0) + 1;
    return acc;
  }, {});
  const countStr = Object.entries(counts)
    .map(([role, n]) => `${n} ${role}`)
    .join(", ");
  return [
    `[Earlier conversation summary] ${messages.length} earlier messages ` +
      `(${countStr}) were archived ${reason}. ` +
      `The full transcript is preserved in the previous session file.`,
    userTasks.length > 0
      ? `Requests handled so far${tail.length < userTasks.length ? " (most recent)" : ""}:\n${tail.join("\n")}`
      : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

export class SessionMemory {
  // In-memory history. Mirrored to disk only when persistPath is set.
  private history: Message[] = [];

  // Absolute path of the session file to mirror to, or null for in-memory only.
  private persistPath: string | null = null;

  // Owning project id, used to allocate a fresh file on rollover.
  private projectId: string | null = null;

  /** Append a fully-formed message to the history. */
  add(message: Message): void {
    this.history.push(message);
    this.persist();
    this.maybeRollover();
  }

  /**
   * Convenience helper that stamps the current time and appends the message.
   * Returns the message that was stored so callers can reuse it if needed.
   */
  addMessage(role: Message["role"], content: string): Message {
    const message: Message = { role, content, timestamp: new Date() };
    this.history.push(message);
    this.persist();
    this.maybeRollover();
    return message;
  }

  /** Return a shallow copy of the full history (never the internal reference). */
  getHistory(): Message[] {
    return [...this.history];
  }

  /** Wipe the entire session history. */
  clear(): void {
    this.history = [];
    this.persist();
  }

  /**
   * Replace the entire history with a copy of `messages` and mirror it to disk.
   * Used to seed a resumed session from a persisted AgentState snapshot.
   */
  replaceHistory(messages: Message[]): void {
    this.history = messages.map((m) => ({ ...m }));
    this.persist();
  }

  /**
   * Return the last `n` messages as a copy. Non-positive `n` yields an empty
   * array; values larger than the history simply return the whole history.
   */
  getLast(n: number): Message[] {
    if (n <= 0) {
      return [];
    }
    return this.history.slice(-n);
  }

  /** Absolute path of the file this session currently mirrors to, if any. */
  getPersistPath(): string | null {
    return this.persistPath;
  }

  /**
   * Bind this session to a file on disk. From now on every change is mirrored
   * there. When options.load is true and the file already exists, the current
   * history is replaced by what was loaded; otherwise the current history is
   * written out immediately so the file exists. options.projectId enables
   * rollover into a fresh file once the message cap is reached.
   */
  bindPersistence(
    filePath: string,
    options?: { load?: boolean; projectId?: string },
  ): void {
    this.persistPath = filePath;
    if (options?.projectId) {
      this.projectId = options.projectId;
    }
    if (options?.load && fs.existsSync(filePath)) {
      this.loadFrom(filePath);
    } else {
      this.persist();
    }
  }

  /**
   * Replace the in-memory history with the contents of the given file and start
   * mirroring future changes to it. Any read/parse error leaves the history
   * unchanged.
   */
  loadFrom(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    try {
      const raw: unknown = fs.readJsonSync(filePath);
      this.history = deserializeMessages(raw);
      this.persistPath = filePath;
    } catch {
      // Leave history untouched on any failure.
    }
  }

  /**
   * Mirror the current history to disk when a persistence path is bound.
   * A persistence failure must never crash the agent, so all errors are
   * swallowed. No-op when no path is bound.
   */
  private persist(): void {
    if (this.persistPath === null) {
      return;
    }
    try {
      fs.writeJsonSync(this.persistPath, serializeMessages(this.history), {
        spaces: 2,
      });
    } catch {
      // Swallow — persistence is best-effort.
    }
  }

  /** Estimated tokens of the current history (chars / 4). */
  estimateTokens(): number {
    return estimateTokens(this.history);
  }

  /**
   * IMP-03: token-based context compaction. When the estimated history tokens
   * exceed `limitTokens × COMPACT_THRESHOLD`, summarize the OLDEST HALF of the
   * history into one system note and keep the recent tail — same mechanics as
   * the message-count rollover, so the previous session file stays intact as
   * the archive. The loop calls this before every provider request; one pass
   * per call (no internal loop), so a still-large tail compacts again next turn.
   *
   * @returns true when compaction happened.
   */
  compactIfNeeded(limitTokens = CONTEXT_TOKEN_LIMIT): boolean {
    if (this.history.length < 4) {
      return false;
    }
    if (this.estimateTokens() <= limitTokens * COMPACT_THRESHOLD) {
      return false;
    }
    this.archiveOldest(
      Math.floor(this.history.length / 2),
      `to keep this session within its context-token budget`,
    );
    return true;
  }

  /**
   * IMP-20: relevance-prune stale tool_result messages against `focusText` (the
   * current phase goal / recent turns). For each tool_result OLDER than the last
   * PRUNE_KEEP_RECENT_RESULTS tool_results: score its relevance to focusText with
   * lightweight token-overlap (Jaccard over lowercased word sets, ignoring tokens
   * <3 chars). When score < threshold AND the message is large (> minChars), replace
   * its content with a one-line stub: "[pruned low-relevance <tool> observation —
   * N chars omitted]" (preserve the leading "[toolname]" tag if present). NEVER
   * touch user / assistant / system messages, and never prune the kept-recent tail.
   * Returns the number of messages pruned. Best-effort; persists once if anything changed.
   */
  pruneToolResults(
    focusText: string,
    options?: { threshold?: number; minChars?: number },
  ): number {
    const threshold = options?.threshold ?? PRUNE_DEFAULT_THRESHOLD;
    const minChars = options?.minChars ?? PRUNE_DEFAULT_MIN_CHARS;

    // Indices of every tool_result entry, in order.
    const resultIndices: number[] = [];
    for (let i = 0; i < this.history.length; i += 1) {
      if (this.history[i]?.role === "tool_result") {
        resultIndices.push(i);
      }
    }

    // Keep the most recent N tool_results verbatim; only the rest are eligible.
    const eligible =
      resultIndices.length > PRUNE_KEEP_RECENT_RESULTS
        ? resultIndices.slice(0, resultIndices.length - PRUNE_KEEP_RECENT_RESULTS)
        : [];

    let pruned = 0;
    for (const index of eligible) {
      const message = this.history[index];
      if (message === undefined) {
        continue;
      }
      const content = message.content;
      // Idempotent: a message already stubbed is skipped.
      if (content.startsWith("[pruned")) {
        continue;
      }
      if (content.length <= minChars) {
        continue;
      }
      if (jaccardOverlap(focusText, content) >= threshold) {
        continue;
      }

      // Preserve a leading "[toolname]" tag if the content carries one.
      const tagMatch = /^\[([^\]]+)\]/.exec(content);
      const tool = tagMatch?.[1] ?? "tool";
      const prefix = tagMatch ? `[${tool}] ` : "";
      message.content = `${prefix}[pruned low-relevance ${tool} observation — ${content.length} chars omitted]`;
      pruned += 1;
    }

    if (pruned > 0) {
      this.persist();
    }
    return pruned;
  }

  /**
   * When the history reaches the cap, archive it (the current file already holds
   * the full transcript), summarize the oldest messages into one system note,
   * keep the recent tail, and continue in a fresh session file.
   */
  private maybeRollover(): void {
    if (this.history.length < SESSION_MAX) {
      return;
    }
    this.archiveOldest(
      SESSION_SUMMARIZE,
      `to keep this session within its ${SESSION_MAX}-message limit`,
    );
  }

  /**
   * Shared archive mechanics for BOTH rollover paths (message cap + token
   * budget), so the two can never drift: summarize the oldest `count` messages
   * into one system note, keep the tail, and continue in a fresh session file
   * (the previous file remains as the full-transcript archive).
   */
  private archiveOldest(count: number, reason: string): void {
    const archived = this.history.slice(0, count);
    const tail = this.history.slice(count);
    const note: Message = {
      role: "system",
      content: summarizeArchived(archived, reason),
      timestamp: new Date(),
    };
    this.history = [note, ...tail];

    // Continue in a brand-new file so the prior one stays intact as the archive.
    if (this.projectId) {
      try {
        this.persistPath = newSessionFilePath(this.projectId);
      } catch {
        // Keep writing to the existing path if a new one can't be allocated.
      }
    }
    this.persist();
  }
}
