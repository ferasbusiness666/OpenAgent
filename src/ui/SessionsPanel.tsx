import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { listRecentSessions, type SessionInfo } from "../memory/session-store.js";

interface SessionsPanelProps {
  /** Project whose sessions to list, or null when no project is open. */
  projectId: string | null;
  /** Load the chosen session file (replaces the in-memory history). */
  onLoad: (info: SessionInfo) => void;
  onClose: () => void;
}

/** Short, friendly timestamp for a session's last-modified time. */
function formatWhen(when: Date): string {
  if (Number.isNaN(when.getTime()) || when.getTime() === 0) {
    return "unknown date";
  }
  return when.toLocaleString();
}

/**
 * The /sessions picker: lists the last 10 saved sessions for the current project
 * with their dates and message counts; Enter loads the selected one (keeping the
 * conversation going from where it left off), Esc closes.
 */
export function SessionsPanel({ projectId, onLoad, onClose }: SessionsPanelProps) {
  const sessions = useMemo<SessionInfo[]>(
    () => (projectId ? listRecentSessions(projectId, 10) : []),
    [projectId],
  );
  const [selected, setSelected] = useState(0);

  useInput((_value, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (sessions.length === 0) {
      return;
    }
    if (key.upArrow) {
      setSelected((prev) => (prev <= 0 ? sessions.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((prev) => (prev >= sessions.length - 1 ? 0 : prev + 1));
      return;
    }
    if (key.return) {
      const info = sessions[selected];
      if (info) {
        onLoad(info);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Recent sessions
      </Text>
      {projectId === null ? (
        <Text color="gray">No project is open.</Text>
      ) : sessions.length === 0 ? (
        <Text color="gray">No saved sessions for this project yet.</Text>
      ) : (
        sessions.map((info, index) => {
          const active = index === selected;
          return (
            <Box key={info.path}>
              <Text color={active ? "greenBright" : "white"} bold={active}>
                {active ? "› " : "  "}
                {formatWhen(info.when)}
              </Text>
              <Text color="gray"> — {info.count} message{info.count === 1 ? "" : "s"}</Text>
            </Box>
          );
        })
      )}
      <Text color="gray">↑/↓ choose · Enter load · Esc close</Text>
    </Box>
  );
}
