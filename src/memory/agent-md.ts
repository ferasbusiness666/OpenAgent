import fs from "fs-extra";
import path from "node:path";
import { PROJECT_ROOT } from "../config/index.js";

/**
 * AgentMemory — durable, cross-session memory backed by AGENT.md at the
 * project root. The planner injects this content into the system prompt, and
 * the agent updates it when it learns persistent facts about the user.
 */

/** Absolute path to the AGENT.md file at the project root. */
export const AGENT_MD_PATH = path.join(PROJECT_ROOT, "AGENT.md");

/** Default contents written when AGENT.md does not yet exist. */
export const DEFAULT_AGENT_MD = `# Agent Memory

## About the User
(nothing yet)

## Preferences
(nothing yet)

## Notes
(nothing yet)
`;

export class AgentMemory {
  // In-memory mirror of the on-disk AGENT.md content, kept in sync on writes.
  private content = "";
  private loaded = false;

  /**
   * If `load` is true (the default), the AGENT.md file is read immediately on
   * construction, creating it from the default template when missing.
   */
  constructor(load = true) {
    if (load) {
      this.load();
    }
  }

  /**
   * Read AGENT.md from the project root into memory. If the file does not
   * exist, it is created from the default template first, then loaded.
   */
  load(): string {
    if (!fs.existsSync(AGENT_MD_PATH)) {
      fs.writeFileSync(AGENT_MD_PATH, DEFAULT_AGENT_MD, "utf8");
      this.content = DEFAULT_AGENT_MD;
      this.loaded = true;
      return this.content;
    }

    this.content = fs.readFileSync(AGENT_MD_PATH, "utf8");
    this.loaded = true;
    return this.content;
  }

  /**
   * Return the current AGENT.md content. Loads from disk on first access if it
   * has not been loaded yet (e.g. when constructed with `load = false`).
   */
  getContent(): string {
    if (!this.loaded) {
      this.load();
    }
    return this.content;
  }

  /**
   * Rewrite AGENT.md entirely with `newContent`, persisting to disk and keeping
   * the in-memory copy in sync.
   */
  update(newContent: string): void {
    this.content = newContent;
    this.loaded = true;
    fs.writeFileSync(AGENT_MD_PATH, newContent, "utf8");
  }

  /**
   * Append a section/text under the existing content. Ensures the existing
   * content ends with a newline before appending so sections stay separated,
   * then persists the combined content to disk.
   */
  append(section: string): void {
    if (!this.loaded) {
      this.load();
    }

    const base = this.content.endsWith("\n") || this.content.length === 0
      ? this.content
      : `${this.content}\n`;
    const addition = section.endsWith("\n") ? section : `${section}\n`;
    const combined = `${base}${addition}`;

    this.update(combined);
  }
}
