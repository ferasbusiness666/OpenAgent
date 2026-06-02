/**
 * SessionMemory — holds the conversation history for the current session.
 *
 * The history lives entirely in memory (a private array) and is NEVER
 * persisted to disk. When the session ends, the history is gone. This is by
 * design: the durable, cross-session memory lives in AGENT.md (see agent-md.ts).
 */

/** A single entry in the session conversation history. */
export type Message = {
  role: "user" | "assistant" | "tool_result";
  content: string;
  timestamp: Date;
};

export class SessionMemory {
  // In-memory only. Intentionally never written to disk.
  private history: Message[] = [];

  /** Append a fully-formed message to the history. */
  add(message: Message): void {
    this.history.push(message);
  }

  /**
   * Convenience helper that stamps the current time and appends the message.
   * Returns the message that was stored so callers can reuse it if needed.
   */
  addMessage(role: Message["role"], content: string): Message {
    const message: Message = { role, content, timestamp: new Date() };
    this.history.push(message);
    return message;
  }

  /** Return a shallow copy of the full history (never the internal reference). */
  getHistory(): Message[] {
    return [...this.history];
  }

  /** Wipe the entire session history. */
  clear(): void {
    this.history = [];
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
}
