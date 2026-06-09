/**
 * eval/tasks.ts — canned evaluation tasks for Open Agent.
 *
 * Each EvalTask has:
 *   - name:   short identifier used in the report.
 *   - prompt: the exact instruction sent to the agent loop.
 *   - check:  a synchronous predicate that inspects the workspace directory
 *             after the run and returns true on pass. Read errors are swallowed
 *             and produce false so a task that never wrote anything fails cleanly.
 */

import fs from "fs-extra";
import path from "node:path";

export interface EvalTask {
  name: string;
  prompt: string;
  /**
   * Inspect `workspaceDir` after the agent run and return true iff the task
   * produced the expected artefact. Must not throw.
   */
  check(workspaceDir: string): boolean;
}

/** Read a file under workspaceDir, trimming whitespace. Returns "" on any error. */
function readSafe(workspaceDir: string, relPath: string): string {
  try {
    const full = path.join(workspaceDir, relPath);
    return fs.readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

export const EVAL_TASKS: EvalTask[] = [
  {
    name: "create-file",
    prompt: "Create a file named hello.txt containing exactly: Hello World",
    check(workspaceDir: string): boolean {
      return readSafe(workspaceDir, "hello.txt").trim() === "Hello World";
    },
  },
  {
    name: "compute-and-write",
    prompt:
      "Compute 6 * 7 and write the numeric result to a file named answer.txt",
    check(workspaceDir: string): boolean {
      return readSafe(workspaceDir, "answer.txt").includes("42");
    },
  },
  {
    name: "list-then-summarize",
    prompt:
      'Create a file notes.md with a markdown heading "# Notes" and one bullet point.',
    check(workspaceDir: string): boolean {
      return readSafe(workspaceDir, "notes.md").includes("# Notes");
    },
  },
];
