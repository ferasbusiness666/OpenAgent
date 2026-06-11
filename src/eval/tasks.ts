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

/** Check that a path exists under workspaceDir. Returns false on any error. */
function existsSafe(workspaceDir: string, relPath: string): boolean {
  try {
    return fs.existsSync(path.join(workspaceDir, relPath));
  } catch {
    return false;
  }
}

/** Count the number of non-empty lines in text. */
function countLines(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

export const EVAL_TASKS: EvalTask[] = [
  // ---- original 3 (unchanged) -------------------------------------------------
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

  // ---- 9 new tasks ------------------------------------------------------------

  {
    name: "write-json",
    prompt:
      'Create a file named config.json containing a JSON object with a key "name" whose value is the string "openagent".',
    check(workspaceDir: string): boolean {
      const raw = readSafe(workspaceDir, "config.json");
      if (raw.trim().length === 0) return false;
      try {
        const obj = JSON.parse(raw) as unknown;
        return (
          typeof obj === "object" &&
          obj !== null &&
          !Array.isArray(obj) &&
          (obj as Record<string, unknown>)["name"] === "openagent"
        );
      } catch {
        return false;
      }
    },
  },

  {
    name: "make-directory",
    prompt:
      'Create a folder named "src" inside the workspace, then create an empty file named index.js inside that folder.',
    check(workspaceDir: string): boolean {
      return (
        existsSafe(workspaceDir, "src") &&
        existsSafe(workspaceDir, path.join("src", "index.js"))
      );
    },
  },

  {
    name: "multi-file",
    prompt:
      'Create two files: a.txt containing exactly "alpha" and b.txt containing exactly "beta".',
    check(workspaceDir: string): boolean {
      return (
        readSafe(workspaceDir, "a.txt").trim() === "alpha" &&
        readSafe(workspaceDir, "b.txt").trim() === "beta"
      );
    },
  },

  {
    name: "append-or-edit",
    prompt:
      'First create a file named version.txt containing "1.0.0". Then update the file so it contains "1.0.1" instead.',
    check(workspaceDir: string): boolean {
      return readSafe(workspaceDir, "version.txt").trim() === "1.0.1";
    },
  },

  {
    name: "count-lines",
    prompt:
      'Create a file named data.txt with exactly 5 lines, where each line contains "line N" (N = 1 through 5, e.g. "line 1", "line 2", … "line 5"). Then count the number of lines in data.txt and write that count as a number into a file named count.txt.',
    check(workspaceDir: string): boolean {
      const data = readSafe(workspaceDir, "data.txt");
      const count = readSafe(workspaceDir, "count.txt");
      return countLines(data) === 5 && count.includes("5");
    },
  },

  {
    name: "find-pattern",
    prompt:
      'Create three markdown files: "apple.md" containing only "fruit", "needle.md" containing only the word "needle", and "carrot.md" containing only "vegetable". Then find which file contains the word "needle" and write that filename (just the filename, e.g. needle.md) into a file named found.txt.',
    check(workspaceDir: string): boolean {
      const found = readSafe(workspaceDir, "found.txt");
      return found.includes("needle.md");
    },
  },

  {
    name: "html-page",
    prompt:
      'Create a directory named "site" and inside it create an HTML file named index.html. The file must contain a <title>Eval</title> element and an <h1> element with any text.',
    check(workspaceDir: string): boolean {
      const html = readSafe(workspaceDir, path.join("site", "index.html"));
      return html.includes("<title>Eval</title>") && html.includes("<h1>");
    },
  },

  {
    name: "csv-summary",
    prompt:
      'Create a file named scores.csv with the header line "name,score" followed by exactly three data rows: "alice,10", "bob,20", "carol,30". Then compute the sum of the scores (10 + 20 + 30 = 60) and write that number into a file named total.txt.',
    check(workspaceDir: string): boolean {
      const csv = readSafe(workspaceDir, "scores.csv");
      const total = readSafe(workspaceDir, "total.txt");
      return (
        csv.includes("name,score") &&
        csv.includes("alice,10") &&
        total.includes("60")
      );
    },
  },

  {
    name: "rename-file",
    prompt:
      'Create a file named draft.txt with the content "v1". Then rename it so that the content lives in a file named final.txt and draft.txt no longer exists.',
    check(workspaceDir: string): boolean {
      return (
        readSafe(workspaceDir, "final.txt").includes("v1") &&
        !existsSafe(workspaceDir, "draft.txt")
      );
    },
  },
];
