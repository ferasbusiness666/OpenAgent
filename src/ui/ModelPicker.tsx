import { useState } from "react";
import { Box, Text, useInput } from "ink";

interface ModelPickerProps {
  /** The currently configured model (may be empty = provider default). */
  current: string;
  /** Commit the new model name. */
  onSubmit: (model: string) => void;
  onClose: () => void;
}

/**
 * Switch the active model without losing the conversation. A plain text prompt:
 * type the model name and press Enter. Submitting an empty value clears the
 * override so the provider falls back to its default model.
 */
export function ModelPicker({ current, onSubmit, onClose }: ModelPickerProps) {
  const [buffer, setBuffer] = useState(current);

  useInput((value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      onSubmit(buffer.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((prev) => prev.slice(0, -1));
      return;
    }
    if (value && !key.ctrl && !key.meta && !key.tab) {
      setBuffer((prev) => prev + value);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Switch model
      </Text>
      <Text color="gray">
        current: {current.length > 0 ? current : "(provider default)"}
      </Text>
      <Box marginTop={1}>
        <Text color="white">model: </Text>
        <Text color="yellow">{buffer}</Text>
        <Text color="gray">▏</Text>
      </Box>
      <Text color="gray">
        Examples: gpt-4o · claude-sonnet-4-20250514 · gemini-2.0-flash · llama3
      </Text>
      <Text color="gray">Enter to apply (conversation is kept) · Esc to cancel</Text>
    </Box>
  );
}
