import readline from "node:readline";
import path from "node:path";
import {
  getProjectByPath,
  createProject,
  touchProject,
  type Project,
} from "./memory/projects.js";

/**
 * Interactive startup flow that runs (in readline, before the Ink UI) every time
 * `openagent` launches:
 *
 *   A. Trust prompt for the current directory — declining exits immediately.
 *   B. Known-project detection by matching the cwd against projects.json — a
 *      match offers "welcome back, continue?".
 *   C. Otherwise (or if the user declines B) set up a new project for the cwd.
 *
 * The provider wizard (Step D) runs separately in index.ts only when no provider
 * is configured. Returns the chosen project plus whether to reload its last
 * saved session, or null when the user does not trust the directory.
 */

export interface StartupResult {
  project: Project;
  /** Reload the project's most recent saved session into memory when true. */
  loadLastSession: boolean;
}

function makeAsker(rl: readline.Interface) {
  return (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

/**
 * Ask a yes/no question. An empty answer returns `defaultValue`; anything
 * starting with y/n is decisive; otherwise we re-ask.
 */
async function askYesNo(
  ask: (prompt: string) => Promise<string>,
  prompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  for (;;) {
    const raw = (await ask(prompt)).toLowerCase();
    if (raw.length === 0) {
      return defaultValue;
    }
    if (raw.startsWith("y")) {
      return true;
    }
    if (raw.startsWith("n")) {
      return false;
    }
    console.log("  Please answer y or n.");
  }
}

export async function runStartupFlow(): Promise<StartupResult | null> {
  const cwd = process.cwd();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl);

  try {
    console.log("");
    console.log("──────────────────────────────────────────────");
    console.log("  Open Agent");
    console.log("──────────────────────────────────────────────");
    console.log("");

    // Step A — Trust prompt. Default NO so trust is always an explicit choice.
    const trusted = await askYesNo(ask, `Do you trust the files in ${cwd}? (y/N) `, false);
    if (!trusted) {
      console.log("Not trusted — exiting. Run Open Agent from a directory you trust.");
      return null;
    }

    // Step B — Known project for this directory?
    const existing = getProjectByPath(cwd);
    if (existing) {
      const cont = await askYesNo(
        ask,
        `Welcome back to "${existing.name}". Continue? (Y/n) `,
        true,
      );
      if (cont) {
        touchProject(existing.id);
        return { project: existing, loadLastSession: true };
      }
      console.log("Starting a new project here instead.");
    }

    // Step C — New project setup. The workspace IS this directory (cwd).
    console.log(`Starting new project in ${cwd}.`);
    const suggested = path.basename(cwd) || "untitled";
    let name = await ask(`Project name [${suggested}]: `);
    if (name.length === 0) {
      name = suggested;
    }
    const project = createProject(name, cwd);
    return { project, loadLastSession: false };
  } finally {
    rl.close();
  }
}
