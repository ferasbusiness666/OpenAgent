/**
 * Multi-phase planning. Before the main ReAct loop starts, the Planner asks the
 * provider to decompose the user's goal into an ordered list of phases. The loop
 * then works through them one at a time, marking each in_progress/completed/failed
 * and recording a short finding as it goes. This gives the agent (and the user) a
 * visible roadmap and keeps long tasks on track.
 */

import { z } from "zod";
import type { Provider } from "../providers/index.js";

/**
 * A single step of the plan. `description` is richer than the bare roadmap
 * interface and is injected into the system prompt; `findings` accumulate short
 * notes recorded as the phase progresses.
 */
export interface Phase {
  id: number;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  findings: string[];
}

/** Upper bound on phases — keeps the plan (and prompt) compact. */
const MAX_PHASES = 8;

/** Validates the raw `[{title, description}, ...]` array the model returns. */
const PlanArraySchema = z.array(
  z.object({
    title: z.string(),
    description: z.string().default(""),
  }),
);

/**
 * Extract the first balanced top-level JSON ARRAY from arbitrary text, honoring
 * string literals and escapes so brackets inside strings don't confuse the
 * matcher. Strips ```json / ``` fences first. Returns the JSON substring or null.
 *
 * This is the array-shaped sibling of util/json.ts's object extractor; it lives
 * here so this module owns its own parsing without touching the shared util.
 */
function extractJsonArray(raw: string): string | null {
  const stripped = raw.replace(/```json/gi, "```").replace(/```/g, "");
  const start = stripped.indexOf("[");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** The prompt that asks the model to decompose a goal into ordered phases. */
function buildPlanningPrompt(goal: string): string {
  return `You are the planning module of Open Agent, an autonomous AI agent.
Break the following goal down into an ordered list of 3 to 7 concrete, sequential phases that, completed in order, accomplish the goal end-to-end.

GOAL:
${goal}

Reply with ONLY a JSON array and nothing else — no prose, no markdown fences. Each element must be an object with a "title" (a few words) and a "description" (one sentence on what that phase achieves):
[{"title": "...", "description": "..."}, {"title": "...", "description": "..."}]`;
}

/**
 * Planner — turns a goal into a Phase[] using the provider. Never throws: on any
 * failure (no array, parse error, validation failure, empty result) it returns a
 * single fallback phase wrapping the whole goal so the loop can still run.
 */
export class Planner {
  constructor(private readonly provider: Provider) {}

  /** Decompose `goal` into 3–7 ordered phases. Falls back to one phase on error. */
  async decompose(goal: string): Promise<Phase[]> {
    const fallback = (): Phase[] => [
      {
        id: 1,
        title: goal.slice(0, 80),
        description: goal,
        status: "pending",
        findings: [],
      },
    ];

    let raw: string;
    try {
      raw = await this.provider.complete(buildPlanningPrompt(goal));
    } catch {
      return fallback();
    }

    const jsonText = extractJsonArray(raw);
    if (jsonText === null) {
      return fallback();
    }

    let data: unknown;
    try {
      data = JSON.parse(jsonText);
    } catch {
      return fallback();
    }

    const parsed = PlanArraySchema.safeParse(data);
    if (!parsed.success || parsed.data.length === 0) {
      return fallback();
    }

    return parsed.data.slice(0, MAX_PHASES).map((entry, index) => ({
      id: index + 1,
      title: entry.title,
      description: entry.description,
      status: "pending" as const,
      findings: [],
    }));
  }
}

/**
 * Render the plan as plain text for injection into the system prompt, e.g.
 *   Phase 1 [completed] Set up — initialise the project (file created)
 */
export function renderPlan(phases: Phase[]): string {
  if (phases.length === 0) {
    return "(no plan yet)";
  }
  return phases
    .map((phase) => {
      const desc = phase.description.trim().length > 0 ? ` — ${phase.description}` : "";
      const findings =
        phase.findings.length > 0 ? ` (${phase.findings.join("; ")})` : "";
      return `Phase ${phase.id} [${phase.status}] ${phase.title}${desc}${findings}`;
    })
    .join("\n");
}
