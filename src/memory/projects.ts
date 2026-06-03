/**
 * Project registry — groups agent sessions under named "projects".
 *
 * The registry is a flat list of projects persisted as ~/.openagent/projects.json.
 * Each project is tied to a directory on disk (its `path`): launching `openagent`
 * in a directory looks up the project whose path matches the current working
 * directory. Every read is defensive: a missing or corrupt projects.json yields
 * an empty list rather than throwing, and individual malformed entries are
 * dropped so one bad record can never take down the whole registry.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import { PROJECTS_PATH, ensureDataDir } from "../paths.js";

export { PROJECTS_PATH } from "../paths.js";

/** A named grouping of agent sessions, anchored to a directory on disk. */
export interface Project {
  id: string; // randomUUID()
  name: string;
  path: string; // absolute directory the project lives in (its workspace)
  createdAt: string; // ISO 8601 string
  lastOpenedAt: string; // ISO 8601 string
}

/**
 * Type guard for a stored project record. `path` is tolerated as missing (older
 * records predate it) and normalized to "" on read so legacy registries survive.
 */
function isProjectish(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.lastOpenedAt === "string"
  );
}

/** Coerce a validated-ish record into a Project, defaulting a missing path. */
function toProject(v: Record<string, unknown>): Project {
  return {
    id: String(v.id),
    name: String(v.name),
    path: typeof v.path === "string" ? v.path : "",
    createdAt: String(v.createdAt),
    lastOpenedAt: String(v.lastOpenedAt),
  };
}

/**
 * Read the full registry from disk. Never throws: a missing or corrupt file
 * returns []. Malformed entries are silently dropped during validation.
 */
function readAll(): Project[] {
  if (!fs.existsSync(PROJECTS_PATH)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = fs.readJsonSync(PROJECTS_PATH);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isProjectish).map(toProject);
}

/** Persist the full registry to disk, pretty-printed. */
function writeAll(projects: Project[]): void {
  ensureDataDir();
  fs.writeJsonSync(PROJECTS_PATH, projects, { spaces: 2 });
}

/**
 * List all projects sorted by lastOpenedAt DESCENDING (most-recently-opened
 * first). Never throws.
 */
export function listProjects(): Project[] {
  const all = readAll();
  return all.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

/** Look up a single project by id, or undefined if it does not exist. */
export function getProject(id: string): Project | undefined {
  return readAll().find((p) => p.id === id);
}

/** Normalize a directory path for comparison (absolute; lower-cased on Windows). */
function normalizeDir(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Find the project anchored to the given directory (typically process.cwd()),
 * or undefined if none matches. Comparison is case-insensitive on Windows.
 */
export function getProjectByPath(dir: string): Project | undefined {
  const target = normalizeDir(dir);
  return readAll().find((p) => p.path.length > 0 && normalizeDir(p.path) === target);
}

/**
 * Create a new project anchored to `projectPath` (defaults to process.cwd()).
 * The name is trimmed and falls back to "untitled" when empty. The new record is
 * appended to the registry, persisted, and returned.
 */
export function createProject(name: string, projectPath: string = process.cwd()): Project {
  const trimmed = name.trim();
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    name: trimmed.length > 0 ? trimmed : "untitled",
    path: path.resolve(projectPath),
    createdAt: now,
    lastOpenedAt: now,
  };
  const all = readAll();
  all.push(project);
  writeAll(all);
  return project;
}

/**
 * Mark a project as just-opened by stamping its lastOpenedAt with the current
 * time. No-op (does not write) when the id is not found.
 */
export function touchProject(id: string): void {
  const all = readAll();
  const project = all.find((p) => p.id === id);
  if (!project) {
    return;
  }
  project.lastOpenedAt = new Date().toISOString();
  writeAll(all);
}
