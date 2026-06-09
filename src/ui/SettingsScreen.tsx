import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Config } from "../config/index.js";
import type { ValidationResult } from "../config/validate.js";

interface SettingsScreenProps {
  config: Config;
  detectedClis: string[];
  /** Validate + persist a single edited field. Resolves with the outcome to show. */
  onSave: (patch: Record<string, string>) => Promise<ValidationResult>;
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
  { key: "apiProvider", label: "API provider", type: "enum", options: ["openai", "anthropic", "google", "groq", "openrouter"] },
  { key: "apiKey", label: "API key", type: "secret" },
  { key: "activeModel", label: "Active model", type: "text" },
  { key: "telegramToken", label: "Telegram token", type: "secret" },
  { key: "telegramChatId", label: "Telegram chat ID", type: "text" },
  { key: "tavilyApiKey", label: "Tavily API key", type: "secret" },
  { key: "requireCommandApproval", label: "Require command approval", type: "enum", options: ["true", "false"] },
  { key: "enableVision", label: "Vision (see screenshots)", type: "enum", options: ["true", "false"] },
  { key: "enableReflection", label: "Self-check before done", type: "enum", options: ["true", "false"] },
  { key: "permSuggestEdits", label: "Allow file edits", type: "enum", options: ["true", "false"] },
  { key: "permReadFiles", label: "Allow reading files", type: "enum", options: ["true", "false"] },
  { key: "onboardingCompleted", label: "Onboarding completed", type: "enum", options: ["true", "false"] },
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
    case "workspacePath":
      return "blank = the launch directory (cwd); a non-empty path must exist and be writable";
    case "providerMode":
      return "cli = drive a local AI CLI · api = call a hosted API";
    case "activeCliName":
      return detected.length > 0 ? `detected: ${detected.join(", ")}` : "no AI CLIs detected on PATH";
    case "apiProvider":
      return "used when provider mode is 'api'";
    case "apiKey":
      return "validated with a live request before saving";
    case "activeModel":
      return "model name/id (e.g. gpt-4o, claude-sonnet-4, gemini-2.0-flash, llama3); blank = provider default";
    case "telegramToken":
      return "validated via getMe; leave blank to disable Telegram";
    case "tavilyApiKey":
      return "API key for the web-research tool (tavily.com); or set TAVILY_API_KEY in the environment";
    case "requireCommandApproval":
      return "when true, the agent pauses for your y/n approval before running shell commands (TUI only)";
    case "enableVision":
      return "when true, screenshots the agent takes are sent to a vision-capable model so it can see pages";
    case "enableReflection":
      return "when true, the agent reviews its work against the goal before stopping and keeps going if it isn't done";
    case "permSuggestEdits":
      return "when false, the agent cannot write/delete/mkdir files (it can still read)";
    case "permReadFiles":
      return "informational; the agent always needs to read the workspace to be useful";
    case "onboardingCompleted":
      return "set to false (or run /onboarding) to replay the first-run walkthrough";
    default:
      return "";
  }
}

/** Color the result line by its leading status glyph. */
function statusColor(message: string): string {
  if (message.startsWith("❌")) return "red";
  if (message.startsWith("✅")) return "green";
  if (message.startsWith("⚠")) return "yellow";
  return "gray";
}

/**
 * Full settings editor overlay. Up/down to choose a field, Enter to edit (text)
 * or cycle (enum), Enter again to validate + commit (saved to config.json on
 * success), Esc to cancel an edit or close. Values are validated live and the
 * outcome is shown; invalid values are not saved.
 */
export function SettingsScreen({ config, detectedClis, onSave, onClose }: SettingsScreenProps) {
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState("");
  const [pending, setPending] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const field = FIELDS[selected];

  const commit = (value: string): void => {
    const patch: Record<string, string> = {};
    patch[field.key] = value;
    setPending(true);
    setStatusMsg("validating…");
    void onSave(patch).then((res) => {
      setStatusMsg(res.message);
      setPending(false);
    });
  };

  useInput((value, key) => {
    // While a validation request is in flight, ignore input so we don't fire
    // overlapping saves.
    if (pending) {
      return;
    }

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
      setStatusMsg("");
      return;
    }
    if (key.downArrow) {
      setSelected((prev) => (prev >= FIELDS.length - 1 ? 0 : prev + 1));
      setStatusMsg("");
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
            shown = buffer;
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
      {statusMsg.length > 0 ? (
        <Box>
          <Text color={statusColor(statusMsg)}>{statusMsg}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
