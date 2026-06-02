import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Project } from "../memory/projects.js";

interface ProjectSelectorProps {
  projects: Project[];
  /** Open an existing project. */
  onOpen: (project: Project) => void;
  /** Create a new project with the given name, then open it. */
  onCreate: (name: string) => void;
}

/** Format an ISO timestamp as a short, friendly relative-ish label. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

/**
 * The project picker shown before the chat. Arrow keys move the selection over
 * the existing projects plus a final "Create a new project" entry; Enter opens
 * a project or, on the create entry, switches to a name prompt.
 */
export function ProjectSelector({ projects, onOpen, onCreate }: ProjectSelectorProps) {
  // The selectable rows are [ ...projects, createRow ]; createIndex is the last.
  const createIndex = projects.length;
  const [selected, setSelected] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useInput((value, key) => {
    if (naming) {
      // Name-entry sub-mode.
      if (key.escape) {
        setNaming(false);
        setName("");
        return;
      }
      if (key.return) {
        const trimmed = name.trim();
        if (trimmed.length > 0) {
          onCreate(trimmed);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setName((prev) => prev.slice(0, -1));
        return;
      }
      if (value && !key.ctrl && !key.meta && !key.tab) {
        setName((prev) => prev + value);
      }
      return;
    }

    // Navigation mode.
    if (key.upArrow) {
      setSelected((prev) => (prev <= 0 ? createIndex : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((prev) => (prev >= createIndex ? 0 : prev + 1));
      return;
    }
    if (key.return) {
      if (selected === createIndex) {
        setNaming(true);
        setName("");
      } else {
        const project = projects[selected];
        if (project) {
          onOpen(project);
        }
      }
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta" bold>
        Which project are you working on?
      </Text>
      <Text color="gray">
        ↑/↓ to choose · Enter to open · pick &quot;Create a new project&quot; to start fresh
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {projects.length === 0 ? (
          <Text color="gray">  (no projects yet — create your first one below)</Text>
        ) : (
          projects.map((project, index) => {
            const active = index === selected;
            return (
              <Box key={project.id}>
                <Text color={active ? "greenBright" : "white"} bold={active}>
                  {active ? "› " : "  "}
                  {project.name}
                </Text>
                <Text color="gray"> — last opened {formatWhen(project.lastOpenedAt)}</Text>
              </Box>
            );
          })
        )}

        <Box>
          <Text color={selected === createIndex ? "greenBright" : "cyan"} bold={selected === createIndex}>
            {selected === createIndex ? "› " : "  "}
            ＋ Create a new project
          </Text>
        </Box>
      </Box>

      {naming ? (
        <Box marginTop={1}>
          <Text color="cyan">New project name: </Text>
          <Text color="white">{name}</Text>
          <Text color="gray">▏</Text>
          <Text color="gray">  (Enter to create · Esc to cancel)</Text>
        </Box>
      ) : null}
    </Box>
  );
}
