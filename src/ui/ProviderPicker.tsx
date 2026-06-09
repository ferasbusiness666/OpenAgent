import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Config } from "../config/index.js";
import type { ValidationResult } from "../config/validate.js";
import {
  API_PROVIDERS,
  defaultModelFor,
  providerMeta,
  type ApiProviderName,
} from "../providers/catalog.js";

interface ProviderPickerProps {
  config: Config;
  detectedClis: string[];
  /** Validate + commit the chosen provider settings; resolves with the outcome. */
  onSubmit: (patch: Record<string, string>) => Promise<ValidationResult>;
  onClose: () => void;
}

type Step = "mode" | "cli" | "apiProvider" | "apiKey";

const MODES = ["cli", "api"] as const;

/** Color the result line by its leading status glyph. */
function statusColor(message: string): string {
  if (message.startsWith("❌")) return "red";
  if (message.startsWith("✅")) return "green";
  if (message.startsWith("⚠")) return "yellow";
  return "gray";
}

/**
 * Switch the active provider mid-conversation without losing history. A small
 * wizard: pick cli vs api, then either choose a detected CLI or pick an API
 * provider and enter its key. The key is validated before saving. Esc steps
 * back, or closes from the first step.
 */
export function ProviderPicker({ config, detectedClis, onSubmit, onClose }: ProviderPickerProps) {
  const [step, setStep] = useState<Step>("mode");
  const [selected, setSelected] = useState(0);
  const [apiProvider, setApiProvider] = useState<ApiProviderName>(config.apiProvider);
  const [keyBuffer, setKeyBuffer] = useState(config.apiKey);
  const [pending, setPending] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  /** Move selection within a list of `length` items. */
  const move = (delta: number, length: number): void => {
    if (length === 0) {
      return;
    }
    setSelected((prev) => (prev + delta + length) % length);
  };

  /** Validate + save; only the picker shows the error, App closes on success. */
  const submit = (patch: Record<string, string>): void => {
    setPending(true);
    setStatusMsg("validating…");
    void onSubmit(patch).then((res) => {
      setPending(false);
      if (!res.ok) {
        setStatusMsg(res.message);
      }
    });
  };

  useInput((value, key) => {
    if (pending) {
      return;
    }

    if (step === "mode") {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) return move(-1, MODES.length);
      if (key.downArrow) return move(1, MODES.length);
      if (key.return) {
        const mode = MODES[selected];
        setSelected(0);
        setStep(mode === "cli" ? "cli" : "apiProvider");
      }
      return;
    }

    if (step === "cli") {
      if (key.escape) {
        setStep("mode");
        setSelected(0);
        return;
      }
      if (detectedClis.length === 0) {
        return;
      }
      if (key.upArrow) return move(-1, detectedClis.length);
      if (key.downArrow) return move(1, detectedClis.length);
      if (key.return) {
        const cli = detectedClis[selected];
        submit({ providerMode: "cli", activeCliName: cli });
      }
      return;
    }

    if (step === "apiProvider") {
      if (key.escape) {
        setStep("mode");
        setSelected(0);
        return;
      }
      if (key.upArrow) return move(-1, API_PROVIDERS.length);
      if (key.downArrow) return move(1, API_PROVIDERS.length);
      if (key.return) {
        setApiProvider(API_PROVIDERS[selected].id);
        setStep("apiKey");
      }
      return;
    }

    // step === "apiKey"
    if (key.escape) {
      setStep("apiProvider");
      return;
    }
    if (key.return) {
      submit({
        providerMode: "api",
        apiProvider,
        apiKey: keyBuffer.trim(),
        activeModel: defaultModelFor(apiProvider),
      });
      return;
    }
    if (key.backspace || key.delete) {
      setKeyBuffer((prev) => prev.slice(0, -1));
      return;
    }
    if (value && !key.ctrl && !key.meta && !key.tab) {
      setKeyBuffer((prev) => prev + value);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Switch provider
      </Text>

      {step === "mode" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">How should the agent talk to a model?</Text>
          {MODES.map((mode, index) => (
            <Text key={mode} color={index === selected ? "greenBright" : "white"} bold={index === selected}>
              {index === selected ? "› " : "  "}
              {mode === "cli" ? "Local AI CLI" : "Hosted API (key)"}
            </Text>
          ))}
        </Box>
      ) : null}

      {step === "cli" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Choose a detected CLI:</Text>
          {detectedClis.length === 0 ? (
            <Text color="red">No AI CLIs found on PATH. Press Esc and try the API option.</Text>
          ) : (
            detectedClis.map((cli, index) => (
              <Text key={cli} color={index === selected ? "greenBright" : "white"} bold={index === selected}>
                {index === selected ? "› " : "  "}
                {cli}
              </Text>
            ))
          )}
        </Box>
      ) : null}

      {step === "apiProvider" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Choose an API provider:</Text>
          {API_PROVIDERS.map((provider, index) => (
            <Text key={provider.id} color={index === selected ? "greenBright" : "white"} bold={index === selected}>
              {index === selected ? "› " : "  "}
              {provider.label}
            </Text>
          ))}
        </Box>
      ) : null}

      {step === "apiKey" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">API provider: {apiProvider}</Text>
          {providerMeta(apiProvider) ? (
            <Text color="gray">Get a key: {providerMeta(apiProvider)?.keyHint}</Text>
          ) : null}
          <Box>
            <Text color="white">API key: </Text>
            <Text color="yellow">{keyBuffer.length > 0 ? "•".repeat(Math.min(keyBuffer.length, 24)) : ""}</Text>
            <Text color="gray">▏</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="gray">↑/↓ choose · Enter confirm · Esc back · conversation is kept</Text>
      </Box>
      {statusMsg.length > 0 ? <Text color={statusColor(statusMsg)}>{statusMsg}</Text> : null}
    </Box>
  );
}
