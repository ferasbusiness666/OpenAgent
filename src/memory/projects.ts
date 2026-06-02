/**
 * Project registry — groups agent sessions under named "projects".
 *
 * The registry is a flat list of projects persisted as projects.json at the
 * project root. Every read is defensive: a missing or corrupt projects.json
 * yields an empty list rather than throwing, and individual malformed entries
 * are dropped so one bad record can never take down the whole registry.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import { PROJECT_ROOT } from "../config/index.js";

export const PROJECTS_PATH = path.join(PROJECT_ROOT, "projects.json");

/** A named grouping of agent sessions. */
export interface Project {
  id: string; // randomUUID()
  name: string;
  createdAt: string; // ISO 8601 string
  lastOpenedAt: string; // ISO 8601 string
}

/** Type guard: is this unknown value a well-formed Project record? */
function isProject(value: unknown): value is Project {
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
  return raw.filter(isProject);
}

/** Persist the full registry to disk, pretty-printed. */
function writeAll(projects: Project[]): void {
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

/**
 * Create a new project. The name is trimmed and falls back to "untitled" when
 * empty. The new record is appended to the registry, persisted, and returned.
 */
export function createProject(name: string): Project {
  const trimmed = name.trim();
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    name: trimmed.length > 0 ? trimmed : "untitled",
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
