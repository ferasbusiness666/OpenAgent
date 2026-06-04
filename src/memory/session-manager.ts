/**
 * SessionManager — file-based persistence for the agent's full run state.
 *
 * While SessionMemory mirrors only the message transcript (under
 * sessions/<projectId>/<timestamp>.json), the SessionManager stores a complete
 * AgentState snapshot — goal, plan phases, and history — as a single top-level
 * file at sessions/<sessionId>.json. This is what `--resume <sessionId>` reloads.
 *
 * JSON has no Date type, so history timestamps are stored as ISO strings and
 * converted back to Date on load. Every operation is best-effort: save never
 * throws, and load/list return null/[] on any read or parse failure.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import { SESSIONS_DIR, ensureDataDir } from "../paths.js";
import type { Phase } from "../agent/plan.js";
import type { Message } from "./session.js";

/** A complete, resumable snapshot of an agent run. */
export interface AgentState {
  sessionId: string;
  goal: string;
  phases: Phase[];
  history: Message[];
  metadata: Record<string, unknown>;
  updatedAt: string;
}

/** On-disk shape: history timestamps are ISO strings, not Date objects. */
interface StoredHistoryMessage {
  role: Message["role"];
  content: string;
  timestamp: string;
}

interface StoredAgentState {
  sessionId: string;
  goal: string;
  phases: Phase[];
  history: StoredHistoryMessage[];
  metadata: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Safely coerce a raw (possibly incomplete/malformed) value read from disk into
 * a well-formed Phase. Returns null for any value that is not an object, so the
 * caller can filter nulls with a type predicate.
 */
function normalizePhase(value: unknown, index: number): Phase | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const status = v.status;
  const validStatus =
    status === "pending" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "failed"
      ? status
      : "pending";
  return {
    id: typeof v.id === "number" ? v.id : index + 1,
    title: typeof v.title === "string" ? v.title : "",
    description: typeof v.description === "string" ? v.description : "",
    status: validStatus,
    findings: Array.isArray(v.findings)
      ? v.findings.filter((f): f is string => typeof f === "string")
      : [],
  };
}

/** Type guard for the Message role union. */
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

export class SessionManager {
  /** Allocate a fresh, unique session id. */
  newSessionId(): string {
    return randomUUID();
  }

  /** Absolute path of the state file for a session id. */
  private filePath(sessionId: string): string {
    return path.join(SESSIONS_DIR, `${sessionId}.json`);
  }

  /**
   * Write the full AgentState to disk (pretty JSON), stamping updatedAt with the
   * current time. History timestamps are serialized as ISO strings. Best-effort:
   * any failure is swallowed so persistence never crashes a run.
   */
  save(state: AgentState): void {
    try {
      ensureDataDir();
      fs.ensureDirSync(SESSIONS_DIR);
      const stored: StoredAgentState = {
        sessionId: state.sessionId,
        goal: state.goal,
        phases: state.phases,
        history: state.history.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp.toISOString(),
        })),
        metadata: state.metadata,
        updatedAt: new Date().toISOString(),
      };
      fs.writeJsonSync(this.filePath(state.sessionId), stored, { spaces: 2 });
    } catch {
      // Swallow — persistence is best-effort.
    }
  }

  /**
   * Load an AgentState by id. Returns null when the file is missing or corrupt.
   * History timestamps are converted back to Date (NaN → now). Defensive about
   * every field so a partially-written file never throws.
   */
  load(sessionId: string): AgentState | null {
    const file = this.filePath(sessionId);
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const raw: unknown = fs.readJsonSync(file);
      if (typeof raw !== "object" || raw === null) {
        return null;
      }
      const r = raw as Record<string, unknown>;
      const history: Message[] = Array.isArray(r.history)
        ? r.history.reduce<Message[]>((acc, entry) => {
            if (typeof entry !== "object" || entry === null) {
              return acc;
            }
            const e = entry as Record<string, unknown>;
            if (!isRole(e.role) || typeof e.content !== "string") {
              return acc;
            }
            acc.push({
              role: e.role,
              content: e.content,
              timestamp: parseTimestamp(e.timestamp),
            });
            return acc;
          }, [])
        : [];
      const phases: Phase[] = Array.isArray(r.phases)
        ? r.phases.map((p, i) => normalizePhase(p, i)).filter((p): p is Phase => p !== null)
        : [];
      const metadata: Record<string, unknown> =
        typeof r.metadata === "object" && r.metadata !== null
          ? (r.metadata as Record<string, unknown>)
          : {};
      return {
        sessionId: typeof r.sessionId === "string" ? r.sessionId : sessionId,
        goal: typeof r.goal === "string" ? r.goal : "",
        phases,
        history,
        metadata,
        updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * List all stored agent-state sessions (top-level *.json files), newest first.
   * Project transcript folders are subdirectories and are skipped. Defensive:
   * unreadable/corrupt files are omitted rather than throwing.
   */
  list(): Array<{ sessionId: string; goal: string; updatedAt: string }> {
    if (!fs.existsSync(SESSIONS_DIR)) {
      return [];
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(SESSIONS_DIR);
    } catch {
      return [];
    }
    const results: Array<{ sessionId: string; goal: string; updatedAt: string }> = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const full = path.join(SESSIONS_DIR, name);
      try {
        if (fs.statSync(full).isDirectory()) {
          continue;
        }
        const raw: unknown = fs.readJsonSync(full);
        if (typeof raw !== "object" || raw === null) {
          continue;
        }
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== "string") {
          continue;
        }
        results.push({
          sessionId: r.sessionId,
          goal: typeof r.goal === "string" ? r.goal : "",
          updatedAt:
            typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
        });
      } catch {
        // Skip unreadable/corrupt files.
      }
    }
    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return results;
  }
}
