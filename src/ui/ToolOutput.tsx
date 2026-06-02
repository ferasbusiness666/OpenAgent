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

/** First 3 lines of a result, with an ellipsis marker if there is more. */
function previewResult(result: string): { lines: string[]; more: boolean } {
  const all = result.split(/\r?\n/);
  const lines = all.slice(0, 3);
  return { lines, more: all.length > 3 };
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

  const { lines, more } = previewResult(message.result);
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
        {more ? <Text color="gray">… (output truncated)</Text> : null}
      </Box>
    </Box>
  );
}
