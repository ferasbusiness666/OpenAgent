/**
 * Session store — on-disk locations and (de)serialization for session files.
 *
 * Sessions for a project live under sessions/<projectId>/<timestamp>.json at the
 * project root. JSON has no Date type, so timestamps are stored as ISO strings
 * and converted back to Date when loaded. Every parse is defensive: malformed
 * input is skipped rather than throwing.
 *
 * NOTE: the Message type is imported type-only to avoid a runtime import cycle —
 * session.ts imports the runtime helpers from this module.
 */

import path from "node:path";
import fs from "fs-extra";
import { PROJECT_ROOT } from "../config/index.js";
import type { Message } from "./session.js";

export const SESSIONS_DIR = path.join(PROJECT_ROOT, "sessions");

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
  return value === "user" || value === "assistant" || value === "tool_result";
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
