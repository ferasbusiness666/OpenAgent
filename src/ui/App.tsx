import { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { AgentLoop } from "../agent/loop.js";
import { ChatView } from "./ChatView.js";
import { StatusBar } from "./StatusBar.js";

/** A single rendered entry in the chat transcript. */
export type UIMessage =
  | { kind: "user"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "toolCall"; tool: string; params: Record<string, unknown> }
  | { kind: "toolResult"; tool: string; result: string; success: boolean }
  | { kind: "agent"; text: string }
  | { kind: "done"; text: string }
  | { kind: "stuck"; text: string }
  | { kind: "error"; text: string };

/** Status shown in the bottom bar. */
export type AgentStatus =
  | { state: "idle" }
  | { state: "thinking" }
  | { state: "running"; tool: string }
  | { state: "done" }
  | { state: "stuck" }
  | { state: "error" };

interface AppProps {
  agentLoop: AgentLoop;
  providerName: string;
  workspacePath: string;
  initialTask?: string;
}

export function App({ agentLoop, providerName, workspacePath, initialTask }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: "idle" });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const push = useCallback((message: UIMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  // Subscribe to agent loop events once and translate them into UI state.
  useEffect(() => {
    const onThought = (thought: string) => {
      push({ kind: "thought", text: thought });
      setStatus({ state: "thinking" });
    };
    const onToolCall = (data: { tool: string; params: Record<string, unknown> }) => {
      push({ kind: "toolCall", tool: data.tool, params: data.params });
      setStatus({ state: "running", tool: data.tool });
    };
    const onToolResult = (data: { tool: string; result: string; success: boolean }) => {
      push({ kind: "toolResult", tool: data.tool, result: data.result, success: data.success });
    };
    const onMessage = (message: string) => push({ kind: "agent", text: message });
    const onDone = (finalMessage: string) => {
      push({ kind: "done", text: finalMessage });
      setStatus({ state: "done" });
      setBusy(false);
    };
    const onStuck = (question: string) => {
      push({ kind: "stuck", text: question });
      setStatus({ state: "stuck" });
      setBusy(false);
    };
    const onError = (message: string) => {
      push({ kind: "error", text: message });
      setStatus({ state: "error" });
      setBusy(false);
    };

    agentLoop.on("thought", onThought);
    agentLoop.on("toolCall", onToolCall);
    agentLoop.on("toolResult", onToolResult);
    agentLoop.on("message", onMessage);
    agentLoop.on("done", onDone);
    agentLoop.on("stuck", onStuck);
    agentLoop.on("error", onError);

    return () => {
      agentLoop.off("thought", onThought);
      agentLoop.off("toolCall", onToolCall);
      agentLoop.off("toolResult", onToolResult);
      agentLoop.off("message", onMessage);
      agentLoop.off("done", onDone);
      agentLoop.off("stuck", onStuck);
      agentLoop.off("error", onError);
    };
  }, [agentLoop, push]);

  const submitTask = useCallback(
    (task: string) => {
      const trimmed = task.trim();
      if (trimmed.length === 0 || busy) return;
      push({ kind: "user", text: trimmed });
      setStatus({ state: "thinking" });
      setBusy(true);
      // Fire and forget — events drive all further UI updates.
      void agentLoop.run(trimmed);
    },
    [agentLoop, busy, push],
  );

  // Kick off an initial task passed on the command line, if any.
  useEffect(() => {
    if (initialTask && initialTask.trim().length > 0) {
      submitTask(initialTask);
    }
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Minimal controlled text input via raw key events (no extra dependency).
  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      exit();
      return;
    }
    if (busy) {
      // Ignore typing while the agent is working.
      return;
    }
    if (key.return) {
      const task = input;
      setInput("");
      submitTask(task);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    // Append printable characters only.
    if (value && !key.ctrl && !key.meta) {
      setInput((prev) => prev + value);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          Open Agent
        </Text>
        <Text color="gray"> — autonomous local agent</Text>
      </Box>

      <ChatView messages={messages} />

      <Box marginTop={1}>
        {busy ? (
          <Text color="yellow">working… (type Ctrl+C to quit)</Text>
        ) : (
          <Text color="white">
            <Text color="green">› </Text>
            {input}
            <Text color="gray">▏</Text>
          </Text>
        )}
      </Box>

      <StatusBar status={status} providerName={providerName} workspacePath={workspacePath} />
    </Box>
  );
}
