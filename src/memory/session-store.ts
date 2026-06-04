/**
 * Session store — on-disk locations and (de)serialization for session files.
 *
 * Sessions for a project live under ~/.openagent/sessions/<projectId>/<timestamp>.json.
 * JSON has no Date type, so timestamps are stored as ISO strings and converted
 * back to Date when loaded. Every parse is defensive: malformed input is skipped
 * rather than throwing.
 *
 * NOTE: the Message type is imported type-only to avoid a runtime import cycle —
 * session.ts imports the runtime helpers from this module.
 */

import path from "node:path";
import fs from "fs-extra";
import { SESSIONS_DIR } from "../paths.js";
import type { Message } from "./session.js";

export { SESSIONS_DIR } from "../paths.js";

/** Folder that holds all session files for one project. */
export function projectSessionDir(projectId: string): string {
  return path.join(SESSIONS_DIR, projectId);
}

/**
 * Absolute path for a brand-new session file for this project, named by the
 * current timestamp made filesystem-safe (replace ":" and "." with "-").
 * Ensures the project's session directory exists.
 */
export function newSessionFilePath(projectId: string): string {
  const dir = projectSessionDir(projectId);
  fs.ensureDirSync(dir);
  const safeStamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${safeStamp}.json`);
}

/** Absolute paths of existing session files for a project (newest first), or [] if none. */
export function listSessionFiles(projectId: string): string[] {
  const dir = projectSessionDir(projectId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a)) // timestamped names sort lexically = chronologically
    .map((name) => path.join(dir, name));
}

/** Summary metadata for one session file, used by the /sessions picker. */
export interface SessionInfo {
  path: string;
  when: Date;
  count: number;
}

/**
 * The most recent `limit` sessions for a project (newest first), each annotated
 * with its last-modified time and message count. Defensive: unreadable files are
 * reported with a zero count rather than dropped.
 */
export function listRecentSessions(projectId: string, limit = 10): SessionInfo[] {
  const files = listSessionFiles(projectId).slice(0, Math.max(0, limit));
  return files.map((filePath) => {
    let when = new Date(0);
    let count = 0;
    try {
      when = fs.statSync(filePath).mtime;
    } catch {
      // Keep the epoch default.
    }
    try {
      const raw: unknown = fs.readJsonSync(filePath);
      count = deserializeMessages(raw).length;
    } catch {
      // Keep count 0 for an unreadable/corrupt file.
    }
    return { path: filePath, when, count };
  });
}

/**
 * Delete session files whose last-modified time is older than `maxAgeDays`
 * across all projects. Empty project directories left behind are removed too.
 * Never throws; returns the number of session files deleted.
 */
export function pruneOldSessions(maxAgeDays = 30): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  if (!fs.existsSync(SESSIONS_DIR)) {
    return 0;
  }
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return 0;
  }
  for (const projectId of projectDirs) {
    const dir = path.join(SESSIONS_DIR, projectId);
    let files: string[];
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) {
        // Top-level file (e.g. a SessionManager state file like <sessionId>.json).
        // Prune it if it is old enough.
        if (projectId.endsWith(".json") && stat.mtimeMs < cutoff) {
          try {
            fs.removeSync(dir);
            removed += 1;
          } catch {
            // Skip files we cannot remove.
          }
        }
        continue;
      }
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(dir, name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) {
          fs.removeSync(filePath);
          removed += 1;
        }
      } catch {
        // Skip files we cannot stat/remove.
      }
    }
    // Clean up a now-empty project session directory.
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.removeSync(dir);
      }
    } catch {
      // Ignore.
    }
  }
  return removed;
}

/** The on-disk shape of a single message (timestamp as an ISO string). */
interface StoredMessage {
  role: Message["role"];
  content: string;
  timestamp: string;
}

/** Convert in-memory messages to the JSON-storable shape. */
export function serializeMessages(messages: Message[]): StoredMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp.toISOString(),
  }));
}

/** Type guard: is this value one of the valid Message roles? */
function isRole(value: unknown): value is Message["role"] {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "tool_result" ||
    value === "system"
  );
}

/** Parse a timestamp into a Date, falling back to now when unparseable. */
function parseTimestamp(value: unknown): Date {
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return new Date();
}

/**
 * Parse raw JSON (unknown) back into Message[]; tolerates malformed input by
 * skipping bad entries; converts ISO strings back to Date.
 */
export function deserializeMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const messages: Message[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (!isRole(e.role) || typeof e.content !== "string") {
      continue;
    }
    messages.push({
      role: e.role,
      content: e.content,
      timestamp: parseTimestamp(e.timestamp),
    });
  }
  return messages;
}
