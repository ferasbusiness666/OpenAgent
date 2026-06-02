import { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { AgentLoop } from "../agent/loop.js";
import {
  saveConfig,
  getConfig,
  resolveWorkspacePath,
  type Config,
} from "../config/index.js";
import { getProvider, detectClis } from "../providers/index.js";
import {
  listProjects,
  createProject,
  touchProject,
  type Project,
} from "../memory/projects.js";
import { newSessionFilePath } from "../memory/session-store.js";
import type { SessionMemory } from "../memory/session.js";
import {
  SLASH_COMMANDS,
  matchCommands,
  resolveCommand,
  commandToken,
} from "./commands.js";
import { ChatView } from "./ChatView.js";
import { StatusBar } from "./StatusBar.js";
import { CommandMenu } from "./CommandMenu.js";
import { ProjectSelector } from "./ProjectSelector.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { ModelPicker } from "./ModelPicker.js";
import { ProviderPicker } from "./ProviderPicker.js";

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

/** Which screen mode the app is in. */
type Mode = "projects" | "chat";

/** Which (if any) overlay is open on top of the chat. */
type Overlay = "none" | "settings" | "model" | "provider" | "tools" | "history" | "help";

interface AppProps {
  agentLoop: AgentLoop;
  providerName: string;
  workspacePath: string;
  /** Shared session memory (used for /clear, /history, and disk persistence). */
  session?: SessionMemory;
  /** When set, skip project selection and immediately run this task (headless/tests). */
  initialTask?: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a type-safe Partial<Config> from raw string edits, validating the two
 * enum fields. Unknown keys are ignored. Returns an error string for invalid
 * enum values. (saveConfig re-validates the whole merged config too.)
 */
function buildPartial(raw: Record<string, string>): Partial<Config> | { error: string } {
  const partial: Partial<Config> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "workspacePath":
        partial.workspacePath = value;
        break;
      case "activeCliName":
        partial.activeCliName = value;
        break;
      case "apiKey":
        partial.apiKey = value;
        break;
      case "activeModel":
        partial.activeModel = value;
        break;
      case "telegramToken":
        partial.telegramToken = value;
        break;
      case "telegramChatId":
        partial.telegramChatId = value;
        break;
      case "providerMode":
        if (value !== "cli" && value !== "api") {
          return { error: "providerMode must be 'cli' or 'api'." };
        }
        partial.providerMode = value;
        break;
      case "apiProvider":
        if (value !== "openai" && value !== "anthropic" && value !== "google") {
          return { error: "apiProvider must be openai, anthropic, or google." };
        }
        partial.apiProvider = value;
        break;
      default:
        // Ignore unknown keys.
        break;
    }
  }
  return partial;
}

export function App({ agentLoop, providerName, workspacePath, session, initialTask }: AppProps) {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>(initialTask ? "chat" : "projects");
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: "idle" });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [config, setConfig] = useState<Config>(() => getConfig());
  const [activeProviderName, setActiveProviderName] = useState(providerName);
  const [activeWorkspace, setActiveWorkspace] = useState(workspacePath);
  const [projects, setProjects] = useState<Project[]>(() => listProjects());
  const [currentProject, setCurrentProject] = useState<Project | null>(null);

  const detectedClis = useMemo(() => detectClis(), []);

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

  // Kick off an initial task (headless/test path), if any.
  useEffect(() => {
    if (initialTask && initialTask.trim().length > 0) {
      submitTask(initialTask);
    }
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Config changes (settings / model / provider) -------------------------

  const applyConfigChange = useCallback(
    (raw: Record<string, string>) => {
      const built = buildPartial(raw);
      if ("error" in built) {
        push({ kind: "error", text: `Invalid setting: ${built.error}` });
        return;
      }
      let saved: Config;
      try {
        saved = saveConfig(built);
      } catch (err) {
        push({ kind: "error", text: `Could not save settings: ${errText(err)}` });
        return;
      }
      setConfig(saved);

      const providerFields: (keyof Config)[] = [
        "providerMode",
        "activeCliName",
        "apiKey",
        "apiProvider",
        "activeModel",
      ];
      if (providerFields.some((field) => field in built)) {
        try {
          const next = getProvider(saved);
          agentLoop.setProvider(next);
          setActiveProviderName(next.name);
        } catch (err) {
          push({ kind: "error", text: `Provider not switched: ${errText(err)}` });
        }
      }
      if ("workspacePath" in built) {
        agentLoop.refreshWorkspace();
        setActiveWorkspace(resolveWorkspacePath(saved));
      }
    },
    [agentLoop, push],
  );

  // ---- Project selection ----------------------------------------------------

  const openProject = useCallback(
    (project: Project) => {
      touchProject(project.id);
      // A fresh session file per open; history mirrors to it on every change.
      if (session) {
        session.bindPersistence(newSessionFilePath(project.id));
      }
      setCurrentProject(project);
      setMessages([]);
      setStatus({ state: "idle" });
      setMode("chat");
      setProjects(listProjects());
    },
    [session],
  );

  const createAndOpen = useCallback(
    (name: string) => {
      const project = createProject(name);
      openProject(project);
    },
    [openProject],
  );

  // ---- Slash command dispatch ----------------------------------------------

  const runCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "/settings":
          setOverlay("settings");
          break;
        case "/tools":
          setOverlay("tools");
          break;
        case "/history":
          setOverlay("history");
          break;
        case "/model":
          setOverlay("model");
          break;
        case "/provider":
          setOverlay("provider");
          break;
        case "/help":
          setOverlay("help");
          break;
        case "/clear":
          session?.clear();
          setMessages([{ kind: "agent", text: "Conversation cleared. Same project, fresh start." }]);
          setStatus({ state: "idle" });
          break;
        default:
          push({ kind: "error", text: `Unknown command: ${name}. Type /help.` });
      }
    },
    [session, push],
  );

  // ---- Overlay submit handlers ---------------------------------------------

  const onModelSubmit = useCallback(
    (model: string) => {
      applyConfigChange({ activeModel: model });
      setOverlay("none");
      push({
        kind: "agent",
        text:
          model.length > 0
            ? `Model switched to "${model}". Conversation preserved.`
            : "Model override cleared (provider default). Conversation preserved.",
      });
    },
    [applyConfigChange, push],
  );

  const onProviderSubmit = useCallback(
    (raw: Record<string, string>) => {
      applyConfigChange(raw);
      setOverlay("none");
      push({ kind: "agent", text: "Provider switched. Conversation preserved." });
    },
    [applyConfigChange, push],
  );

  // ---- Input handling -------------------------------------------------------

  const showMenu = input.startsWith("/");

  // Main chat input — active only in chat mode with no overlay open.
  useInput(
    (value, key) => {
      if (key.ctrl && value === "c") {
        exit();
        return;
      }
      if (busy) {
        // Ignore typing (and command entry) while the agent is working.
        return;
      }
      if (key.tab) {
        if (input.startsWith("/")) {
          const matches = matchCommands(input);
          if (matches.length === 1) {
            setInput(`${matches[0].name} `);
          }
        }
        return;
      }
      if (key.return) {
        const text = input.trim();
        setInput("");
        if (text.length === 0) return;
        if (text.startsWith("/")) {
          const cmd = resolveCommand(text);
          if (cmd) {
            runCommand(cmd.name);
          } else {
            push({ kind: "error", text: `Unknown command: ${commandToken(text)}. Type /help.` });
          }
          return;
        }
        submitTask(text);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }
      if (value && !key.ctrl && !key.meta) {
        setInput((prev) => prev + value);
      }
    },
    { isActive: mode === "chat" && overlay === "none" },
  );

  // Info panels (tools/history/help) close on any key.
  useInput(
    (value, key) => {
      if (key.ctrl && value === "c") {
        exit();
        return;
      }
      setOverlay("none");
    },
    { isActive: overlay === "tools" || overlay === "history" || overlay === "help" },
  );

  // ---- Render ---------------------------------------------------------------

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          Open Agent
        </Text>
        <Text color="gray"> — autonomous local agent</Text>
      </Box>

      {mode === "projects" ? (
        <ProjectSelector projects={projects} onOpen={openProject} onCreate={createAndOpen} />
      ) : (
        <>
          <ChatView messages={messages} />

          {overlay === "none" ? (
            <>
              {showMenu ? <CommandMenu filter={input} /> : null}
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
              {!busy && !showMenu ? (
                <Text color="gray">Type a task, or &quot;/&quot; for commands.</Text>
              ) : null}
            </>
          ) : null}

          {overlay === "settings" ? (
            <SettingsScreen
              config={config}
              detectedClis={detectedClis}
              onSave={applyConfigChange}
              onClose={() => setOverlay("none")}
            />
          ) : null}

          {overlay === "model" ? (
            <ModelPicker
              current={config.activeModel}
              onSubmit={onModelSubmit}
              onClose={() => setOverlay("none")}
            />
          ) : null}

          {overlay === "provider" ? (
            <ProviderPicker
              config={config}
              detectedClis={detectedClis}
              onSubmit={onProviderSubmit}
              onClose={() => setOverlay("none")}
            />
          ) : null}

          {overlay === "tools" ? <ToolsPanel /> : null}
          {overlay === "history" ? <HistoryPanel session={session} /> : null}
          {overlay === "help" ? <HelpPanel /> : null}
        </>
      )}

      <StatusBar
        status={status}
        providerName={activeProviderName}
        workspacePath={activeWorkspace}
        projectName={currentProject?.name}
      />
    </Box>
  );
}

// ---- Read-only info panels --------------------------------------------------

/** Static reference of the agent's available tools (/tools). */
function ToolsPanel() {
  const tools: Array<{ name: string; detail: string }> = [
    { name: "shell", detail: "run shell commands inside the workspace (30s timeout)" },
    { name: "filesystem", detail: "read / write / list / delete / mkdir (workspace-relative)" },
    { name: "browser", detail: "navigate / click / type / screenshot / extractText / getHtml (headless Chromium)" },
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Available tools
      </Text>
      {tools.map((tool) => (
        <Box key={tool.name}>
          <Text color="cyan" bold>
            {"  "}
            {tool.name}
          </Text>
          <Text color="gray"> — {tool.detail}</Text>
        </Box>
      ))}
      <Text color="gray">Press any key to close.</Text>
    </Box>
  );
}

/** The list of slash commands (/help). */
function HelpPanel() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Commands
      </Text>
      {SLASH_COMMANDS.map((cmd) => (
        <Box key={cmd.name}>
          <Text color="cyan" bold>
            {"  "}
            {cmd.name}
          </Text>
          <Text color="gray"> — {cmd.description}</Text>
        </Box>
      ))}
      <Text color="gray">Press any key to close.</Text>
    </Box>
  );
}

interface HistoryPanelProps {
  session?: SessionMemory;
}

/** The current session's message history (/history). */
function HistoryPanel({ session }: HistoryPanelProps) {
  const history = session ? session.getHistory() : [];
  const recent = history.slice(-12);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Session history ({history.length} message{history.length === 1 ? "" : "s"})
      </Text>
      {recent.length === 0 ? (
        <Text color="gray">  (no messages yet)</Text>
      ) : (
        recent.map((message, index) => {
          const firstLine = message.content.split(/\r?\n/)[0] ?? "";
          const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
          const color =
            message.role === "user" ? "white" : message.role === "assistant" ? "green" : "gray";
          return (
            <Box key={index}>
              <Text color={color} bold>
                {"  "}
                {message.role}:
              </Text>
              <Text color={color}> {preview}</Text>
            </Box>
          );
        })
      )}
      <Text color="gray">Press any key to close.</Text>
    </Box>
  );
}
