import { Box, Text } from "ink";
import type { UIMessage } from "./App.js";
import { ToolOutput } from "./ToolOutput.js";
import { DiffView } from "./DiffView.js";

interface ChatViewProps {
  messages: UIMessage[];
}

/** Render a single message according to its kind. */
function renderMessage(message: UIMessage, index: number) {
  switch (message.kind) {
    case "user":
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text color="white" bold>
            You
          </Text>
          <Text color="white">{message.text}</Text>
        </Box>
      );

    case "thought":
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text color="gray" italic>
            thinking
          </Text>
          <Text color="gray" italic>
            {message.text}
          </Text>
        </Box>
      );

    case "toolCall":
      return (
        <Box key={index} marginTop={1}>
          <ToolOutput message={message} />
        </Box>
      );

    case "toolResult":
      return (
        <Box key={index}>
          <ToolOutput message={message} />
        </Box>
      );

    case "agent":
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text color="white" bold>
            Agent
          </Text>
          <Text color="white">{message.text}</Text>
        </Box>
      );

    case "diff":
      return (
        <Box key={index}>
          <DiffView path={message.path} diff={message.diff} />
        </Box>
      );

    case "done":
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text color="green" bold>
            ✓ Done
          </Text>
          <Text color="white" bold>
            {message.text}
          </Text>
        </Box>
      );

    case "stuck":
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>
            needs input
          </Text>
          <Text color="yellow">{message.text}</Text>
        </Box>
      );

    case "error":
      return (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text color="red" bold>
            error
          </Text>
          <Text color="red">{message.text}</Text>
        </Box>
      );
  }
}

/** Scrollable-style message list (Ink renders newest at the bottom). */
export function ChatView({ messages }: ChatViewProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((message, index) => renderMessage(message, index))}
    </Box>
  );
}
