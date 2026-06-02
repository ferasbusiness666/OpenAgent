import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Config } from "../config/index.js";

interface SettingsScreenProps {
  config: Config;
  detectedClis: string[];
  /** Persist a single edited field. Validated against the schema in App. */
  onSave: (patch: Record<string, string>) => void;
  onClose: () => void;
}

type FieldType = "text" | "secret" | "enum";

interface Field {
  key: keyof Config;
  label: string;
  type: FieldType;
  options?: readonly string[];
}

/** Editable settings, in display order (workspace, provider, model, telegram). */
const FIELDS: Field[] = [
  { key: "workspacePath", label: "Workspace path", type: "text" },
  { key: "providerMode", label: "Provider mode", type: "enum", options: ["cli", "api"] },
  { key: "activeCliName", label: "Active CLI", type: "text" },
  { key: "apiProvider", label: "API provider", type: "enum", options: ["openai", "anthropic", "google"] },
  { key: "apiKey", label: "API key", type: "secret" },
  { key: "activeModel", label: "Active model", type: "text" },
  { key: "telegramToken", label: "Telegram token", type: "secret" },
  { key: "telegramChatId", label: "Telegram chat ID", type: "text" },
];

/** Mask a secret for display so credentials never appear on screen at rest. */
function maskSecret(value: string): string {
  if (value.length === 0) {
    return "(empty)";
  }
  return "•".repeat(Math.min(value.length, 16));
}

/** Contextual hint shown under the selected field. */
function helpFor(field: Field, detected: string[]): string {
  switch (field.key) {
    case "providerMode":
      return "cli = drive a local AI CLI · api = call a hosted API";
    case "activeCliName":
      return detected.length > 0 ? `detected: ${detected.join(", ")}` : "no AI CLIs detected on PATH";
    case "apiProvider":
      return "used when provider mode is 'api'";
    case "apiKey":
      return "used when provider mode is 'api' — stored in config.json";
    case "activeModel":
      return "model name/id (e.g. gpt-4o, claude-sonnet-4, gemini-2.0-flash, llama3); blank = provider default";
    case "telegramToken":
      return "optional remote control; leave blank to disable Telegram";
    default:
      return "";
  }
}

/**
 * Full settings editor overlay. Up/down to choose a field, Enter to edit (text)
 * or cycle (enum), Enter again to commit (saved to config.json immediately via
 * onSave), Esc to cancel an edit or close the screen.
 */
export function SettingsScreen({ config, detectedClis, onSave, onClose }: SettingsScreenProps) {
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState("");

  const field = FIELDS[selected];

  const commit = (value: string): void => {
    const patch: Record<string, string> = {};
    patch[field.key] = value;
    onSave(patch);
  };

  useInput((value, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        setBuffer("");
        return;
      }
      if (key.return) {
        commit(buffer);
        setEditing(false);
        setBuffer("");
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (value && !key.ctrl && !key.meta && !key.tab) {
        setBuffer((prev) => prev + value);
      }
      return;
    }

    // Navigation mode.
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((prev) => (prev <= 0 ? FIELDS.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((prev) => (prev >= FIELDS.length - 1 ? 0 : prev + 1));
      return;
    }
    if (key.return) {
      if (field.type === "enum" && field.options) {
        const current = String(config[field.key]);
        const idx = field.options.indexOf(current);
        const next = field.options[(idx + 1) % field.options.length];
        commit(next);
      } else {
        setEditing(true);
        setBuffer(String(config[field.key]));
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text color="magenta" bold>
        Settings
      </Text>
      <Text color="gray">
        ↑/↓ choose · Enter {field.type === "enum" ? "cycles" : "edits"} · Esc{" "}
        {editing ? "cancels edit" : "closes"}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {FIELDS.map((f, index) => {
          const active = index === selected;
          const raw = String(config[f.key]);
          let shown: string;
          if (active && editing) {
            shown = f.type === "secret" ? buffer : buffer;
          } else if (f.type === "secret") {
            shown = maskSecret(raw);
          } else {
            shown = raw.length > 0 ? raw : "(empty)";
          }
          return (
            <Box key={String(f.key)}>
              <Text color={active ? "greenBright" : "white"} bold={active}>
                {active ? "› " : "  "}
                {f.label}:
              </Text>
              <Text color={active && editing ? "yellow" : "cyan"}>
                {" "}
                {shown}
                {active && editing ? <Text color="gray">▏</Text> : null}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">{helpFor(field, detectedClis)}</Text>
      </Box>
    </Box>
  );
}
