import { Box, Text } from "ink";
import { matchCommands, resolveCommand, SLASH_COMMANDS } from "./commands.js";

interface CommandMenuProps {
  /** The current raw input (starts with "/" when the menu is shown). */
  filter: string;
}

/**
 * Inline, presentational slash-command menu. Shows the commands matching what
 * the user has typed so far and marks the one that Enter will run (the exact or
 * unique-prefix match). Purely visual — dispatch happens in App.tsx.
 */
export function CommandMenu({ filter }: CommandMenuProps) {
  const matches = matchCommands(filter);
  const list = matches.length > 0 ? matches : SLASH_COMMANDS;
  const target = resolveCommand(filter);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginTop={1}
    >
      <Text color="cyan" bold>
        commands
      </Text>
      {matches.length === 0 ? (
        <Text color="gray">no matching command — press Esc or keep typing</Text>
      ) : null}
      {list.map((cmd) => {
        const active = target !== undefined && cmd.name === target.name;
        return (
          <Box key={cmd.name}>
            <Text color={active ? "greenBright" : "cyan"} bold={active}>
              {active ? "› " : "  "}
              {cmd.name}
            </Text>
            <Text color="gray"> — {cmd.description}</Text>
          </Box>
        );
      })}
      <Text color="gray">Enter to run · Tab to complete · Esc to cancel</Text>
    </Box>
  );
}
