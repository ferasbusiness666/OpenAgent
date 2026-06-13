import { Box, Text } from "ink";

/** Max diff lines rendered inline before we collapse the tail into a footer. */
const MAX_DIFF_LINES = 40;

interface DiffViewProps {
  path: string;
  diff: string;
}

/** Pick a color for a single unified-diff line based on its leading marker. */
function lineColor(line: string): { color: string; dim: boolean } {
  if (line.startsWith("+++") || line.startsWith("---")) {
    // File headers — keep them quiet so the +/- body stands out.
    return { color: "gray", dim: true };
  }
  if (line.startsWith("@@")) return { color: "cyan", dim: true };
  if (line.startsWith("+")) return { color: "green", dim: false };
  if (line.startsWith("-")) return { color: "red", dim: false };
  return { color: "gray", dim: false };
}

/**
 * Inline unified-diff view (IMP-27). Renders a compact bordered box with a
 * `± <path>` header, then +/- line-colored diff lines. Caps the rendered diff
 * at MAX_DIFF_LINES so a huge change can't flood the terminal.
 */
export function DiffView({ path, diff }: DiffViewProps): JSX.Element {
  const all = diff.split(/\r?\n/);
  // Drop a single trailing empty line produced by the diff's final "\n".
  if (all.length > 0 && all[all.length - 1] === "") {
    all.pop();
  }
  const shown = all.slice(0, MAX_DIFF_LINES);
  const hidden = Math.max(0, all.length - MAX_DIFF_LINES);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text color="magenta" bold>
        ± {path}
      </Text>
      {shown.map((line, i) => {
        const { color, dim } = lineColor(line);
        return (
          <Text key={i} color={color} dimColor={dim} wrap="truncate">
            {line.length > 0 ? line : " "}
          </Text>
        );
      })}
      {hidden > 0 ? (
        <Text color="gray" dimColor>
          … ({hidden} more diff line{hidden === 1 ? "" : "s"})
        </Text>
      ) : null}
    </Box>
  );
}
