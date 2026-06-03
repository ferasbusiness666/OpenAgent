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

/** Build a compact, deterministic summary note from archived messages. */
function summarizeArchived(messages: Message[]): string {
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
      `(${countStr}) were archived to keep this session within its ${SESSION_MAX}-message limit. ` +
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

  /**
   * When the history reaches the cap, archive it (the current file already holds
   * the full transcript), summarize the oldest messages into one system note,
   * keep the recent tail, and continue in a fresh session file.
   */
  private maybeRollover(): void {
    if (this.history.length < SESSION_MAX) {
      return;
    }
    const archived = this.history.slice(0, SESSION_SUMMARIZE);
    const tail = this.history.slice(SESSION_SUMMARIZE);
    const note: Message = {
      role: "system",
      content: summarizeArchived(archived),
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
