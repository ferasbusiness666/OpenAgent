/**
 * working-memory.ts — structured durable task state (IMP-08).
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent loop operates over a conversation history (SessionMemory) that grows
 * linearly and is eventually truncated or summarised for cost control. That means
 * key facts the agent discovered five turns ago — a file path it wrote, an API
 * constraint it learned, a variable it resolved — can fall out of the effective
 * context window just when the agent needs them most.
 *
 * WorkingMemory is the solution: a *typed*, *bounded* store of durable task state
 * that accumulates throughout a run and is injected — via {@link render} — into
 * the *volatile* final user turn of every provider call. It is deliberately NOT
 * placed in the cacheable system prefix, because its content changes every step
 * and we do not want to bust a prompt cache on every tool call.
 *
 * The model drives updates through a dedicated "note" action in the agent loop.
 * The loop also auto-records artifacts (files written, URLs produced, etc.).
 * At run end the entire state is serialised with {@link data} and stored by the
 * run-store so a restored session picks up exactly where it left off via
 * {@link WorkingMemory.from}.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * - Pure TypeScript, zero imports — this file is loaded by every test and by the
 *   loop hot-path; it must not drag in Node.js modules.
 * - Hard caps with FIFO eviction prevent unbounded growth in long-running tasks.
 * - Deduplication keeps render() concise; redundant notes are free no-ops.
 * - All mutations sanitise input (trim, truncate, drop empty) so callers need not.
 */

// ---------------------------------------------------------------------------
// Public data shape
// ---------------------------------------------------------------------------

/** Serialisable snapshot of the working memory — safe to JSON.stringify. */
export interface WorkingMemoryData {
  facts: string[];
  constraints: string[];
  artifacts: string[];
  variables: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal limits
// ---------------------------------------------------------------------------

const CAP_FACTS = 15;
const CAP_CONSTRAINTS = 10;
const CAP_ARTIFACTS = 20;
const CAP_VARIABLES = 15;

const MAX_ENTRY_LEN = 200;
const MAX_VAR_NAME_LEN = 50;
const MAX_VAR_VALUE_LEN = 200;

// ---------------------------------------------------------------------------
// Sanitisation helpers
// ---------------------------------------------------------------------------

/** Trim + truncate a plain entry to MAX_ENTRY_LEN; returns "" for blank input. */
function sanitise(raw: string): string {
  const s = raw.trim();
  return s.length > MAX_ENTRY_LEN ? s.slice(0, MAX_ENTRY_LEN) : s;
}

/** Sanitise a variable name (shorter limit). */
function sanitiseName(raw: string): string {
  const s = raw.trim();
  return s.length > MAX_VAR_NAME_LEN ? s.slice(0, MAX_VAR_NAME_LEN) : s;
}

/** Sanitise a variable value. */
function sanitiseValue(raw: string): string {
  const s = raw.trim();
  return s.length > MAX_VAR_VALUE_LEN ? s.slice(0, MAX_VAR_VALUE_LEN) : s;
}

// ---------------------------------------------------------------------------
// Type guards for from() and applyNote()
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (item) => typeof item === "string"
  );
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Typed, bounded store of durable task state accumulated during one agent run.
 *
 * The four buckets serve distinct roles in multi-step consistency:
 * - **facts**: things the agent has discovered about the world (e.g. "the repo
 *   uses pnpm, not npm").
 * - **constraints**: rules or limits that must not be violated (e.g. "never
 *   write outside ./workspace").
 * - **artifacts**: outputs produced so far — file paths, URLs, identifiers.
 * - **variables**: named values the agent resolves and reuses (e.g. projectId,
 *   baseUrl).
 *
 * The loop injects {@link render} into the final (volatile) user turn of every
 * provider call so the model always sees current task state without busting the
 * system-prefix prompt cache.
 */
export class WorkingMemory {
  private readonly facts: string[] = [];
  private readonly constraints: string[] = [];
  private readonly artifacts: string[] = [];
  /** Ordered array of variable names for FIFO eviction. */
  private readonly varOrder: string[] = [];
  private readonly vars: Map<string, string> = new Map();

  // -------------------------------------------------------------------------
  // Static factory
  // -------------------------------------------------------------------------

  /**
   * Restore from a persisted snapshot produced by {@link data}.
   * Tolerates partial or unknown input — any malformed field is silently skipped
   * so a corrupt or old snapshot never crashes the loop.
   *
   * @param data - Any value; typically the parsed JSON from the run-store.
   */
  static from(data: unknown): WorkingMemory {
    const mem = new WorkingMemory();
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return mem;
    }
    const obj = data as Record<string, unknown>;

    if (isStringArray(obj["facts"])) {
      for (const f of obj["facts"]) mem.addFact(f);
    }
    if (isStringArray(obj["constraints"])) {
      for (const c of obj["constraints"]) mem.addConstraint(c);
    }
    if (isStringArray(obj["artifacts"])) {
      for (const a of obj["artifacts"]) mem.addArtifact(a);
    }
    if (isStringRecord(obj["variables"])) {
      for (const [k, v] of Object.entries(obj["variables"])) {
        mem.setVariable(k, v);
      }
    }
    return mem;
  }

  // -------------------------------------------------------------------------
  // Mutation methods — all sanitise and deduplicate before touching state
  // -------------------------------------------------------------------------

  /**
   * Record a discovered fact.
   * No-op when the identical (trimmed, case-sensitive) fact is already stored.
   * Evicts the oldest fact when the cap would be exceeded.
   */
  addFact(fact: string): void {
    const s = sanitise(fact);
    if (s === "") return;
    if (this.facts.includes(s)) return;
    if (this.facts.length >= CAP_FACTS) this.facts.shift();
    this.facts.push(s);
  }

  /**
   * Record a constraint the agent must respect.
   * No-op when identical constraint is already stored.
   * Evicts the oldest constraint when the cap would be exceeded.
   */
  addConstraint(constraint: string): void {
    const s = sanitise(constraint);
    if (s === "") return;
    if (this.constraints.includes(s)) return;
    if (this.constraints.length >= CAP_CONSTRAINTS) this.constraints.shift();
    this.constraints.push(s);
  }

  /**
   * Record a produced artifact (file path, URL, identifier, etc.).
   * No-op when identical artifact is already stored.
   * Evicts the oldest artifact when the cap would be exceeded.
   */
  addArtifact(artifact: string): void {
    const s = sanitise(artifact);
    if (s === "") return;
    if (this.artifacts.includes(s)) return;
    if (this.artifacts.length >= CAP_ARTIFACTS) this.artifacts.shift();
    this.artifacts.push(s);
  }

  /**
   * Set a named variable.
   * No-op when the variable already holds the exact same (sanitised) value.
   * Moves the name to the end of the LRU order on every real update.
   * Evicts the least-recently-set variable when the cap would be exceeded.
   *
   * @param name  - Variable name; truncated to {@link MAX_VAR_NAME_LEN}.
   * @param value - Variable value; truncated to {@link MAX_VAR_VALUE_LEN}.
   */
  setVariable(name: string, value: string): void {
    const n = sanitiseName(name);
    if (n === "") return;
    const v = sanitiseValue(value);
    if (this.vars.get(n) === v) return; // no-op — identical value

    // Evict least-recently-set entry if at cap and this is a new name
    if (!this.vars.has(n) && this.varOrder.length >= CAP_VARIABLES) {
      const evict = this.varOrder.shift()!;
      this.vars.delete(evict);
    }

    // Remove name from current position in order (if updating existing)
    const idx = this.varOrder.indexOf(n);
    if (idx !== -1) this.varOrder.splice(idx, 1);

    this.vars.set(n, v);
    this.varOrder.push(n);
  }

  /**
   * Apply a batch of updates from a model "note" action's params object.
   * Reads `facts`, `constraints`, `artifacts`, and `variables` tolerantly from
   * an `unknown` params bag — any key that is absent or has the wrong type is
   * silently ignored.
   *
   * @returns The number of entries that were actually added or updated (i.e.
   *   deduplicated no-ops and sanitisation drops do NOT count toward the total).
   */
  applyNote(params: Record<string, unknown>): number {
    let count = 0;

    const rawFacts = params["facts"];
    if (isStringArray(rawFacts)) {
      const before = this.facts.length;
      for (const f of rawFacts) {
        const s = sanitise(f);
        if (s !== "" && !this.facts.includes(s)) {
          this.addFact(s);
          count++;
        }
      }
      // Avoid double-counting via length diff (addFact may evict; use explicit count above)
      void before;
    }

    const rawConstraints = params["constraints"];
    if (isStringArray(rawConstraints)) {
      for (const c of rawConstraints) {
        const s = sanitise(c);
        if (s !== "" && !this.constraints.includes(s)) {
          this.addConstraint(s);
          count++;
        }
      }
    }

    const rawArtifacts = params["artifacts"];
    if (isStringArray(rawArtifacts)) {
      for (const a of rawArtifacts) {
        const s = sanitise(a);
        if (s !== "" && !this.artifacts.includes(s)) {
          this.addArtifact(s);
          count++;
        }
      }
    }

    const rawVars = params["variables"];
    if (isStringRecord(rawVars)) {
      for (const [k, v] of Object.entries(rawVars)) {
        const n = sanitiseName(k);
        const sv = sanitiseValue(v);
        if (n !== "" && this.vars.get(n) !== sv) {
          this.setVariable(n, v);
          count++;
        }
      }
    }

    return count;
  }

  // -------------------------------------------------------------------------
  // Read / query methods
  // -------------------------------------------------------------------------

  /** True when all four buckets are empty. */
  isEmpty(): boolean {
    return (
      this.facts.length === 0 &&
      this.constraints.length === 0 &&
      this.artifacts.length === 0 &&
      this.vars.size === 0
    );
  }

  /**
   * Deep copy of the current state, safe for serialisation.
   * Use this to persist state to the run-store; pass the result to
   * {@link WorkingMemory.from} to restore it.
   */
  get data(): WorkingMemoryData {
    const variables: Record<string, string> = {};
    for (const name of this.varOrder) {
      variables[name] = this.vars.get(name)!;
    }
    return {
      facts: [...this.facts],
      constraints: [...this.constraints],
      artifacts: [...this.artifacts],
      variables,
    };
  }

  /**
   * Compact, deterministic plain-text block suitable for injection into a
   * provider prompt turn.  Sections with no entries are omitted entirely so
   * the block stays concise for simple tasks.  Returns `""` when
   * {@link isEmpty} is true.
   *
   * Format example:
   * ```
   * Facts:
   * - repo uses pnpm
   * Constraints:
   * - never write outside ./workspace
   * Artifacts:
   * - ./workspace/output.json
   * Variables:
   * - baseUrl = https://api.example.com
   * ```
   */
  render(): string {
    if (this.isEmpty()) return "";

    const lines: string[] = [];

    if (this.facts.length > 0) {
      lines.push("Facts:");
      for (const f of this.facts) lines.push(`- ${f}`);
    }

    if (this.constraints.length > 0) {
      lines.push("Constraints:");
      for (const c of this.constraints) lines.push(`- ${c}`);
    }

    if (this.artifacts.length > 0) {
      lines.push("Artifacts:");
      for (const a of this.artifacts) lines.push(`- ${a}`);
    }

    if (this.vars.size > 0) {
      lines.push("Variables:");
      for (const name of this.varOrder) {
        lines.push(`- ${name} = ${this.vars.get(name)!}`);
      }
    }

    return lines.join("\n");
  }

  /** Reset all buckets to empty (e.g. between task runs on the same instance). */
  clear(): void {
    this.facts.length = 0;
    this.constraints.length = 0;
    this.artifacts.length = 0;
    this.varOrder.length = 0;
    this.vars.clear();
  }
}
