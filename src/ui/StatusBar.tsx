import { Box, Text } from "ink";
import type { AgentStatus } from "./App.js";

interface StatusBarProps {
  status: AgentStatus;
  providerName: string;
  workspacePath: string;
}

/** Map a status to a label + color for the bar. */
function describe(status: AgentStatus): { label: string; color: string } {
  switch (status.state) {
    case "idle":
      return { label: "idle", color: "gray" };
    case "thinking":
      return { label: "thinking", color: "blue" };
    case "running":
      return { label: `running: ${status.tool}`, color: "yellow" };
    case "done":
      return { label: "done", color: "green" };
    case "stuck":
      return { label: "needs input", color: "yellow" };
    case "error":
      return { label: "error", color: "red" };
  }
}

/** Always-visible bottom bar: status | provider | workspace. */
export function StatusBar({ status, providerName, workspacePath }: StatusBarProps) {
  const { label, color } = describe(status);
  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text color={color} bold>
        ● {label}
      </Text>
      <Text color="cyan">provider: {providerName}</Text>
      <Text color="gray">ws: {workspacePath}</Text>
    </Box>
  );
}
