/**
 * SessionMemory — holds the conversation history for the current session.
 *
 * The history is kept in memory (a private array). By default nothing is written
 * to disk. When a persistence path is bound via bindPersistence(), the history
 * is additionally mirrored to that file and re-written on every change, so a
 * session can be reloaded later. The durable, cross-session memory still lives
 * in AGENT.md (see agent-md.ts); on-disk sessions are an opt-in convenience.
 */

import fs from "fs-extra";
import { serializeMessages, deserializeMessages } from "./session-store.js";

/** A single entry in the session conversation history. */
export type Message = {
  role: "user" | "assistant" | "tool_result";
  content: string;
  timestamp: Date;
};

export class SessionMemory {
  // In-memory history. Mirrored to disk only when persistPath is set.
  private history: Message[] = [];

  // Absolute path of the session file to mirror to, or null for in-memory only.
  private persistPath: string | null = null;

  /** Append a fully-formed message to the history. */
  add(message: Message): void {
    this.history.push(message);
    this.persist();
  }

  /**
   * Convenience helper that stamps the current time and appends the message.
   * Returns the message that was stored so callers can reuse it if needed.
   */
  addMessage(role: Message["role"], content: string): Message {
    const message: Message = { role, content, timestamp: new Date() };
    this.history.push(message);
    this.persist();
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

  /**
   * Bind this session to a file on disk. From now on every change is mirrored
   * there. When options.load is true and the file already exists, the current
   * history is replaced by what was loaded from disk; otherwise the current
   * history is written out immediately so the file exists.
   */
  bindPersistence(filePath: string, options?: { load?: boolean }): void {
    this.persistPath = filePath;
    if (options?.load && fs.existsSync(filePath)) {
      this.loadFrom(filePath);
    } else {
      this.persist();
    }
  }

  /**
   * Replace the in-memory history with the contents of the given file. Any
   * read/parse error leaves the history unchanged. Does NOT alter persistPath.
   */
  loadFrom(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    try {
      const raw: unknown = fs.readJsonSync(filePath);
      this.history = deserializeMessages(raw);
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
}
