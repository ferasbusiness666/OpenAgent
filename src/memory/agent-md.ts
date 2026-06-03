import fs from "fs-extra";
import path from "node:path";
import { GLOBAL_AGENT_MD_PATH } from "../paths.js";
import { getActiveWorkspace } from "../config/index.js";

/**
 * AgentMemory — durable, cross-session memory backed by TWO AGENT.md files that
 * are merged into the system prompt:
 *
 *   1. ~/.openagent/AGENT.md — global memory (preferences, general info about
 *      the user) that applies to every project.
 *   2. <workspace>/AGENT.md — project-specific memory for the current directory.
 *
 * Either file is created from a default template the first time it is needed.
 * The planner injects getContent() (the merged view) into the system prompt;
 * persistent updates the agent makes are written to the project-level file.
 */

/** Default contents for the global memory file. */
export const DEFAULT_GLOBAL_AGENT_MD = `# Global Agent Memory

Durable facts that apply across every project.

## About the User
(nothing yet)

## Preferences
(nothing yet)

## Notes
(nothing yet)
`;

/** Default contents for a project's memory file. */
export const DEFAULT_PROJECT_AGENT_MD = `# Project Agent Memory

Durable facts specific to this project / directory.

## About this Project
(nothing yet)

## Conventions
(nothing yet)

## Notes
(nothing yet)
`;

interface AgentMemoryOptions {
  /** Override the global AGENT.md location (defaults to ~/.openagent/AGENT.md). */
  globalPath?: string;
  /** Override the project directory (defaults to the active workspace). */
  projectDir?: string;
  /** Read both files on construction (default true). */
  load?: boolean;
}

/** Read a file, creating it from `template` (and any missing parent dir) if absent. */
function readOrCreate(filePath: string, template: string): string {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, template, "utf8");
    return template;
  } catch {
    // If we cannot read or create it, fall back to the in-memory template so the
    // planner still has something coherent to inject.
    return template;
  }
}

export class AgentMemory {
  private readonly globalPath: string;
  private readonly projectDirOverride: string | null;
  private globalContent = "";
  private projectContent = "";
  private loaded = false;

  constructor(options: AgentMemoryOptions = {}) {
    this.globalPath = options.globalPath ?? GLOBAL_AGENT_MD_PATH;
    this.projectDirOverride = options.projectDir ?? null;
    if (options.load !== false) {
      this.load();
    }
  }

  /** Resolve the project AGENT.md path against the (current) active workspace. */
  private projectPath(): string {
    const dir = this.projectDirOverride ?? getActiveWorkspace();
    return path.join(dir, "AGENT.md");
  }

  /** Read both memory files into memory, creating either from its template if missing. */
  load(): void {
    this.globalContent = readOrCreate(this.globalPath, DEFAULT_GLOBAL_AGENT_MD);
    this.projectContent = readOrCreate(this.projectPath(), DEFAULT_PROJECT_AGENT_MD);
    this.loaded = true;
  }

  /**
   * The merged memory injected into the system prompt: global memory first, then
   * the current project's memory, each under a labeled heading.
   */
  getContent(): string {
    if (!this.loaded) {
      this.load();
    }
    return [
      "## Global memory (applies to every project)",
      this.globalContent.trim(),
      "",
      `## Project memory (${this.projectPath()})`,
      this.projectContent.trim(),
    ].join("\n");
  }

  /** Current project AGENT.md contents (loads on first access). */
  getProjectContent(): string {
    if (!this.loaded) {
      this.load();
    }
    return this.projectContent;
  }

  /** Current global AGENT.md contents (loads on first access). */
  getGlobalContent(): string {
    if (!this.loaded) {
      this.load();
    }
    return this.globalContent;
  }

  /** Rewrite the PROJECT AGENT.md entirely, persisting and keeping memory in sync. */
  update(newContent: string): void {
    this.projectContent = newContent;
    this.loaded = true;
    const filePath = this.projectPath();
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, newContent, "utf8");
  }

  /** Append a section to the PROJECT AGENT.md, persisting the combined content. */
  append(section: string): void {
    if (!this.loaded) {
      this.load();
    }
    const base =
      this.projectContent.endsWith("\n") || this.projectContent.length === 0
        ? this.projectContent
        : `${this.projectContent}\n`;
    const addition = section.endsWith("\n") ? section : `${section}\n`;
    this.update(`${base}${addition}`);
  }

  /** Rewrite the GLOBAL AGENT.md entirely, persisting and keeping memory in sync. */
  updateGlobal(newContent: string): void {
    this.globalContent = newContent;
    this.loaded = true;
    fs.ensureDirSync(path.dirname(this.globalPath));
    fs.writeFileSync(this.globalPath, newContent, "utf8");
  }
}
