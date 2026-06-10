import { Box, Text } from "ink";
import type { AgentStatus } from "./App.js";
import { formatTokens, type SessionUsage } from "../agent/usage.js";

interface StatusBarProps {
  status: AgentStatus;
  providerName: string;
  workspacePath: string;
  projectName?: string;
  /** Session token/cost totals; hidden until the first provider call reports usage. */
  usage?: SessionUsage;
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

/** Cost color: green while cheap, amber past $0.10, red past $1.00. */
function costColor(costUsd: number): string {
  if (costUsd >= 1) return "red";
  if (costUsd >= 0.1) return "yellow";
  return "green";
}

/** Always-visible bottom bar: status | project | tokens+cost | provider | workspace. */
export function StatusBar({ status, providerName, workspacePath, projectName, usage }: StatusBarProps) {
  const { label, color } = describe(status);
  const showUsage = usage !== undefined && usage.calls > 0;
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
      {projectName ? <Text color="magenta">project: {projectName}</Text> : null}
      {showUsage ? (
        <Text>
          <Text color="gray">
            {formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out
          </Text>
          <Text color={costColor(usage.costUsd)}> ~${usage.costUsd.toFixed(2)}</Text>
        </Text>
      ) : null}
      <Text color="cyan">provider: {providerName}</Text>
      <Text color="gray">ws: {workspacePath}</Text>
    </Box>
  );
}
