/**
 * Slash-command registry for the terminal UI. A single source of truth for the
 * command names + descriptions, shared by the inline command menu (what the
 * user sees while typing "/") and the dispatcher in App.tsx (what actually runs).
 */

export interface SlashCommand {
  name: string; // includes the leading slash, e.g. "/settings"
  description: string;
}

/** Every command the UI understands, in display order. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/settings", description: "View and edit all configuration" },
  { name: "/tools", description: "List the agent's available tools" },
  { name: "/model", description: "Switch the active model (keeps the conversation)" },
  { name: "/provider", description: "Switch the active provider (keeps the conversation)" },
  { name: "/history", description: "Show this session's message history" },
  { name: "/sessions", description: "List and load a recent session for this project" },
  { name: "/clear", description: "Clear the conversation (stays in the same project)" },
  { name: "/help", description: "Show the list of commands" },
];

/** Extract the leading "/token" from raw input (lowercased), or "" if none. */
export function commandToken(input: string): string {
  const token = input.trim().split(/\s+/)[0] ?? "";
  return token.toLowerCase();
}

/**
 * Commands whose name starts with the typed token. A bare "/" matches all.
 * Used to render the live command menu as the user types.
 */
export function matchCommands(input: string): SlashCommand[] {
  const token = commandToken(input);
  if (!token.startsWith("/")) {
    return [];
  }
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(token));
}

/**
 * Resolve the typed input to a single command: an exact name match wins,
 * otherwise a unique prefix match (so "/se" resolves to "/settings"). Returns
 * undefined when the token is ambiguous or unknown.
 */
export function resolveCommand(input: string): SlashCommand | undefined {
  const token = commandToken(input);
  const exact = SLASH_COMMANDS.find((cmd) => cmd.name === token);
  if (exact) {
    return exact;
  }
  const matches = matchCommands(input);
  return matches.length === 1 ? matches[0] : undefined;
}
