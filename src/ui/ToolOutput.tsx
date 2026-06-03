import { Box, Text } from "ink";
import type { UIMessage } from "./App.js";

interface ToolOutputProps {
  message: Extract<UIMessage, { kind: "toolCall" | "toolResult" }>;
}

/** One-line summary of tool params, truncated so the badge stays compact. */
function summarizeParams(params: Record<string, unknown>): string {
  const json = JSON.stringify(params);
  const max = 80;
  return json.length <= max ? json : `${json.slice(0, max)}…`;
}

/** Max lines of a tool result shown inline; the full text is in the session file. */
const MAX_RESULT_LINES = 20;

/** Up to MAX_RESULT_LINES of a result, flagging how many lines were hidden. */
function previewResult(result: string): { lines: string[]; hidden: number } {
  const all = result.split(/\r?\n/);
  const lines = all.slice(0, MAX_RESULT_LINES);
  return { lines, hidden: Math.max(0, all.length - MAX_RESULT_LINES) };
}

/** Compact display for a tool call or its result. */
export function ToolOutput({ message }: ToolOutputProps) {
  if (message.kind === "toolCall") {
    return (
      <Box flexDirection="row">
        <Text color="cyan">🔧 </Text>
        <Text color="cyan" bold>
          {message.tool}
        </Text>
        <Text color="cyan"> {summarizeParams(message.params)}</Text>
      </Box>
    );
  }

  const { lines, hidden } = previewResult(message.result);
  const color = message.success ? "green" : "red";
  const badge = message.success ? "✓" : "✗";
  return (
    <Box flexDirection="column">
      <Text color={color} bold>
        {badge} {message.tool}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => (
          <Text key={i} color={color}>
            {line.length > 0 ? line : " "}
          </Text>
        ))}
        {hidden > 0 ? (
          <Text color="gray">... [truncated {hidden} more line{hidden === 1 ? "" : "s"} — full output saved to the session file]</Text>
        ) : null}
      </Box>
    </Box>
  );
}
