import { Box, Text } from "ink";
import type { WorkerStatus, WorkerState } from "../workers/types.js";

interface WorkerPanelProps {
  workers: WorkerStatus[];
}

/** Glyph + color for a worker's lifecycle state. */
function workerGlyph(state: WorkerState): { glyph: string; color: string } {
  switch (state) {
    case "running":
      return { glyph: "▶", color: "yellow" };
    case "completed":
      return { glyph: "✓", color: "green" };
    case "failed":
      return { glyph: "✗", color: "red" };
    default:
      return { glyph: "○", color: "gray" };
  }
}

/** Elapsed milliseconds for a worker that has started (live or finished). */
function elapsedMs(worker: WorkerStatus): number | null {
  if (worker.startedAt === undefined) return null;
  const end = worker.endedAt ?? Date.now();
  return Math.max(0, end - worker.startedAt);
}

/**
 * WorkerPanel — compact, live view of jobs in the {@link WorkerPool}. Mirrors
 * the visual style of PlanView (rounded border, paddingX 1, marginTop 1).
 * Renders nothing when there are no workers to show.
 */
export function WorkerPanel({ workers }: WorkerPanelProps) {
  if (workers.length === 0) return null;

  const activeCount = workers.filter((w) => w.state === "running").length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginTop={1}
    >
      <Text color="magenta" bold>
        Workers ({activeCount} active)
      </Text>
      {workers.map((worker) => {
        const { glyph, color } = workerGlyph(worker.state);
        const ms = elapsedMs(worker);
        return (
          <Box key={worker.jobId}>
            <Text color={color}>
              {"  "}
              {glyph} {worker.kind} {worker.label}
            </Text>
            {ms !== null ? <Text color="gray"> ({ms}ms)</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
