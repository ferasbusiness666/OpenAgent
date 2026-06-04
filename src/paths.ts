/**
 * paths.ts — the single source of truth for where Open Agent keeps user data.
 *
 * ALL persistent data lives under ~/.openagent/ (resolved via os.homedir()), so
 * nothing the user accumulates is ever written inside the app's installation
 * folder. This is what makes the `openagent` command safe to install globally
 * and run from any directory.
 *
 *   ~/.openagent/
 *     config.json        provider, api keys, settings
 *     AGENT.md           global persistent memory
 *     projects.json      registry of known projects
 *     sessions/
 *       <projectId>/<timestamp>.json
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";

/** Root of all persistent user data. */
export const DATA_DIR = path.join(os.homedir(), ".openagent");

export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const PROJECTS_PATH = path.join(DATA_DIR, "projects.json");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
/** Global, cross-project AGENT.md memory. */
export const GLOBAL_AGENT_MD_PATH = path.join(DATA_DIR, "AGENT.md");
/** Long-term, BM25-searchable knowledge store (one Markdown file per note). */
export const MEMORY_DIR = path.join(DATA_DIR, "memory");
/** Local scheduling store, polled by the in-process scheduler. */
export const SCHEDULES_PATH = path.join(DATA_DIR, "schedules.json");

// This module is src/paths.ts, so the install root is one level up from src/.
// Used only to migrate data that older builds wrote into the app folder.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INSTALL_ROOT = path.resolve(__dirname, "..");

/** Create ~/.openagent/ (and the sessions folder) if they do not exist. Idempotent. */
export function ensureDataDir(): void {
  fs.ensureDirSync(DATA_DIR);
  fs.ensureDirSync(SESSIONS_DIR);
  fs.ensureDirSync(MEMORY_DIR);
}

/**
 * Move config.json and projects.json out of the app installation folder and
 * into ~/.openagent/ when an older build left them there. Non-destructive: a
 * legacy file is only moved when the new location does not already hold one, and
 * any failure is swallowed so a migration hiccup never blocks startup.
 */
export function migrateLegacyData(): void {
  ensureDataDir();
  const moves: Array<[string, string]> = [
    [path.join(INSTALL_ROOT, "config.json"), CONFIG_PATH],
    [path.join(INSTALL_ROOT, "projects.json"), PROJECTS_PATH],
  ];
  for (const [from, to] of moves) {
    try {
      if (from === to) {
        continue;
      }
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copySync(from, to);
        // Remove the legacy copy now that it lives in the canonical location.
        fs.removeSync(from);
      }
    } catch {
      // Best-effort migration — never crash startup over it.
    }
  }
  // Older builds also kept sessions/ in the app folder; bring them along.
  try {
    const legacySessions = path.join(INSTALL_ROOT, "sessions");
    if (
      legacySessions !== SESSIONS_DIR &&
      fs.existsSync(legacySessions) &&
      fs.readdirSync(SESSIONS_DIR).length === 0
    ) {
      fs.copySync(legacySessions, SESSIONS_DIR);
      fs.removeSync(legacySessions);
    }
  } catch {
    // Best-effort.
  }
}
