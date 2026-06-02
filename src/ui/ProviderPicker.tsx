import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Config } from "../config/index.js";

interface ProviderPickerProps {
  config: Config;
  detectedClis: string[];
  /** Commit the chosen provider settings (validated against the schema in App). */
  onSubmit: (patch: Record<string, string>) => void;
  onClose: () => void;
}

type Step = "mode" | "cli" | "apiProvider" | "apiKey";

const MODES = ["cli", "api"] as const;
const API_PROVIDERS = ["openai", "anthropic", "google"] as const;

/**
 * Switch the active provider mid-conversation without losing history. A small
 * wizard: pick cli vs api, then either choose a detected CLI or pick an API
 * provider and enter its key. Esc steps back, or closes from the first step.
 */
export function ProviderPicker({ config, detectedClis, onSubmit, onClose }: ProviderPickerProps) {
  const [step, setStep] = useState<Step>("mode");
  const [selected, setSelected] = useState(0);
  const [apiProvider, setApiProvider] = useState(config.apiProvider);
  const [keyBuffer, setKeyBuffer] = useState(config.apiKey);

  /** Move selection within a list of `length` items. */
  const move = (delta: number, length: number): void => {
    if (length === 0) {
      return;
    }
    setSelected((prev) => (prev + delta + length) % length);
  };

  useInput((value, key) => {
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
        onSubmit({ providerMode: "cli", activeCliName: cli });
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
        setApiProvider(API_PROVIDERS[selected]);
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
      onSubmit({ providerMode: "api", apiProvider, apiKey: keyBuffer.trim() });
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
            <Text key={provider} color={index === selected ? "greenBright" : "white"} bold={index === selected}>
              {index === selected ? "› " : "  "}
              {provider}
            </Text>
          ))}
        </Box>
      ) : null}

      {step === "apiKey" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">API provider: {apiProvider}</Text>
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
    </Box>
  );
}
