import { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { AgentLoop, ApprovalRequest } from "../agent/loop.js";
import type { Phase } from "../agent/plan.js";
import {
  saveConfig,
  getConfig,
  resolveWorkspacePath,
  setActiveWorkspace as applyWorkspaceRoot,
  type Config,
} from "../config/index.js";
import {
  validateApiKey,
  validateTelegramToken,
  validateWorkspacePath,
  type ValidationResult,
} from "../config/validate.js";
import { getProvider, detectClis } from "../providers/index.js";
import { isApiProviderName, API_PROVIDER_IDS } from "../providers/catalog.js";
import {
  listProjects,
  createProject,
  touchProject,
  type Project,
} from "../memory/projects.js";
import { newSessionFilePath, type SessionInfo } from "../memory/session-store.js";
import type { SessionMemory, Message } from "../memory/session.js";
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
import { SessionsPanel } from "./SessionsPanel.js";
import { Onboarding, type OnboardingResult } from "./Onboarding.js";
import { WorkerPanel } from "./WorkerPanel.js";
import { getWorkerPool } from "../workers/pool.js";
import type { WorkerStatus } from "../workers/types.js";
import { LongTermMemory } from "../memory/longterm.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { Schedule, ScheduleTrigger } from "../scheduler/types.js";
import { RunStore, type RunRecord, type RunEvent } from "../agent/run-store.js";
import { launchBackgroundRun } from "../agent/runner.js";

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
type Mode = "onboarding" | "projects" | "chat";

/** Which (if any) overlay is open on top of the chat. */
type Overlay =
  | "none"
  | "settings"
  | "model"
  | "provider"
  | "tools"
  | "history"
  | "sessions"
  | "workers"
  | "memory"
  | "schedule"
  | "runs"
  | "help";

interface AppProps {
  agentLoop: AgentLoop;
  providerName: string;
  workspacePath: string;
  /** Shared session memory (used for /clear, /history, /sessions, persistence). */
  session?: SessionMemory;
  /** The project the agent was launched into (skips the project selector). */
  project?: Project;
  /** Whether the Playwright browser tool is available this run. */
  browserAvailable?: boolean;
  /** When set, skip project selection and immediately run this task (headless/tests). */
  initialTask?: string;
  /** Shared scheduler instance (the same one the background poller drives). */
  scheduler?: Scheduler;
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
      case "tavilyApiKey":
        partial.tavilyApiKey = value;
        break;
      case "providerMode":
        if (value !== "cli" && value !== "api") {
          return { error: "providerMode must be 'cli' or 'api'." };
        }
        partial.providerMode = value;
        break;
      case "apiProvider":
        if (!isApiProviderName(value)) {
          return { error: "apiProvider must be one of: " + API_PROVIDER_IDS.join(", ") };
        }
        partial.apiProvider = value;
        break;
      case "onboardingCompleted":
        if (value !== "true" && value !== "false") return { error: "onboardingCompleted must be 'true' or 'false'." };
        partial.onboardingCompleted = value === "true";
        break;
      case "permReadFiles":
        if (value !== "true" && value !== "false") return { error: "permReadFiles must be 'true' or 'false'." };
        partial.permReadFiles = value === "true";
        break;
      case "permSuggestEdits":
        if (value !== "true" && value !== "false") return { error: "permSuggestEdits must be 'true' or 'false'." };
        partial.permSuggestEdits = value === "true";
        break;
      case "requireCommandApproval":
        if (value !== "true" && value !== "false") return { error: "requireCommandApproval must be 'true' or 'false'." };
        partial.requireCommandApproval = value === "true";
        break;
      case "enableVision":
        if (value !== "true" && value !== "false") return { error: "enableVision must be 'true' or 'false'." };
        partial.enableVision = value === "true";
        break;
      default:
        // Ignore unknown keys.
        break;
    }
  }
  return partial;
}

/** Best-effort render of a stored session's history back into chat messages. */
function historyToUI(history: Message[]): UIMessage[] {
  const out: UIMessage[] = [];
  for (const m of history) {
    if (m.role === "user") {
      out.push({ kind: "user", text: m.content });
    } else if (m.role === "system") {
      out.push({ kind: "agent", text: m.content });
    } else if (m.role === "tool_result") {
      const failed = /\bFAILED\b|^\s*Error:/i.test(m.content);
      out.push({ kind: "toolResult", tool: "saved", result: m.content, success: !failed });
    } else {
      // assistant — its content is the JSON response it emitted.
      try {
        const parsed = JSON.parse(m.content) as {
          thought?: string;
          message?: string;
          action?: string;
        };
        if (parsed.thought && parsed.thought.length > 0) {
          out.push({ kind: "thought", text: parsed.thought });
        }
        if (parsed.message && parsed.message.length > 0) {
          const kind =
            parsed.action === "done" ? "done" : parsed.action === "stuck" ? "stuck" : "agent";
          out.push({ kind, text: parsed.message });
        }
      } catch {
        out.push({ kind: "agent", text: m.content });
      }
    }
  }
  return out;
}

/**
 * Parse a `/schedule add` spec into a trigger:
 *   "HH:MM"        → daily at that local time
 *   "30s"/"5m"/"2h"/"500" → repeating interval (bare number = milliseconds)
 *   an ISO date/time → one-shot at that instant
 * Returns null when the spec is not recognized.
 */
function parseScheduleSpec(spec: string): ScheduleTrigger | null {
  const s = spec.trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    return { type: "daily", time: s };
  }
  const dur = /^(\d+)(ms|s|m|h)?$/.exec(s);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2] ?? "ms";
    const mult = unit === "h" ? 3600000 : unit === "m" ? 60000 : unit === "s" ? 1000 : 1;
    const everyMs = n * mult;
    return everyMs > 0 ? { type: "interval", everyMs } : null;
  }
  const at = Date.parse(s);
  if (!Number.isNaN(at)) {
    return { type: "once", at: new Date(at).toISOString() };
  }
  return null;
}

/** Format a millisecond duration as a compact human string (e.g. "5m", "1h 30m"). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  return parts.length > 0 ? parts.join(" ") : "0s";
}

/** One-line human description of a schedule trigger. */
function describeTrigger(t: ScheduleTrigger): string {
  switch (t.type) {
    case "interval":
      return `every ${formatDuration(t.everyMs)}`;
    case "once":
      return `once at ${new Date(t.at).toLocaleString()}`;
    case "daily":
      return `daily at ${t.time}`;
  }
}

export function App({
  agentLoop,
  providerName,
  workspacePath,
  session,
  project,
  browserAvailable = true,
  initialTask,
  scheduler,
}: AppProps) {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>(() => {
    // First-run onboarding takes precedence in interactive mode. A headless/test
    // run (initialTask set) always skips straight to chat.
    if (!initialTask && !getConfig().onboardingCompleted) {
      return "onboarding";
    }
    return project || initialTask ? "chat" : "projects";
  });
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: "idle" });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [config, setConfig] = useState<Config>(() => getConfig());
  const [activeProviderName, setActiveProviderName] = useState(providerName);
  const [activeWorkspace, setActiveWorkspace] = useState(workspacePath);
  const [projects, setProjects] = useState<Project[]>(() => listProjects());
  const [currentProject, setCurrentProject] = useState<Project | null>(project ?? null);
  // The agent's multi-phase plan (populated by the loop's plan/phaseUpdate events;
  // seeded from a resumed session via the loop's current plan).
  const [phases, setPhases] = useState<Phase[]>(() => agentLoop.plan);
  // Live snapshot of the parallel worker pool (Phase 4 visualization).
  const [workers, setWorkers] = useState<WorkerStatus[]>([]);
  // Pending shell-command approval request (onboarding Step 6 "stay in control").
  const [approval, setApproval] = useState<{ summary: string; resolve: (ok: boolean) => void } | null>(null);
  // Bumped on terminal resize purely to force a re-render (Ink reflows on it).
  const [, setResizeTick] = useState(0);
  // Live-tailing state for /attach: tracks which background run we're following
  // and how many events have already been appended to the message list.
  const [attached, setAttached] = useState<{ runId: string; shown: number } | null>(null);

  const detectedClis = useMemo(() => detectClis(), []);

  const push = useCallback((message: UIMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  // ---- Background run helpers -----------------------------------------------

  /** Convert a RunEvent to a UIMessage. Returns null for events we skip. */
  function runEventToUI(ev: RunEvent): UIMessage | null {
    switch (ev.type) {
      case "thought": {
        const text = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
        return { kind: "thought", text };
      }
      case "toolCall": {
        const d = ev.data as { tool?: unknown; params?: unknown };
        const tool = typeof d.tool === "string" ? d.tool : "unknown";
        const params =
          d.params !== null && typeof d.params === "object" && !Array.isArray(d.params)
            ? (d.params as Record<string, unknown>)
            : {};
        return { kind: "toolCall", tool, params };
      }
      case "toolResult": {
        const d = ev.data as { tool?: unknown; result?: unknown; success?: unknown };
        const tool = typeof d.tool === "string" ? d.tool : "unknown";
        const result = typeof d.result === "string" ? d.result : JSON.stringify(d.result);
        const success = d.success === true;
        return { kind: "toolResult", tool, result, success };
      }
      case "message": {
        const text = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
        return { kind: "agent", text };
      }
      case "done": {
        const text = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
        return { kind: "done", text };
      }
      case "stuck": {
        const text = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
        return { kind: "stuck", text };
      }
      case "error": {
        const text = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
        return { kind: "error", text };
      }
      case "plan":
      case "phaseUpdate":
        // Could call setPhases here; for background runs we skip live plan rendering.
        return null;
      default:
        return null;
    }
  }

  /** Load an existing background run's history into the chat and begin live-tailing. */
  const attachToRun = useCallback((rec: RunRecord) => {
    const store = new RunStore();
    const events = store.readEvents(rec.runId);
    const historyMsgs: UIMessage[] = [
      { kind: "agent", text: `Attached to background run ${rec.runId.slice(0, 8)} (${rec.status}).` },
    ];
    for (const ev of events) {
      const msg = runEventToUI(ev);
      if (msg !== null) historyMsgs.push(msg);
    }
    setMessages(historyMsgs);
    setAttached({ runId: rec.runId, shown: events.length });
    setOverlay("none");
    setMode("chat");
  // runEventToUI is defined in the same render scope — no dep needed
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-tailing effect: polls the run's event log every 800ms and appends new
  // events as UIMessages. Uses functional setState to avoid stale closures.
  useEffect(() => {
    if (attached === null) return;
    const { runId } = attached;
    const store = new RunStore();
    const terminal: ReadonlySet<string> = new Set(["done", "stuck", "error"]);

    const id = setInterval(() => {
      let events: RunEvent[];
      try {
        events = store.readEvents(runId);
      } catch {
        events = [];
      }

      setAttached((prev) => {
        if (prev === null || prev.runId !== runId) return prev;
        const newEvents = events.slice(prev.shown);
        if (newEvents.length === 0) return prev;

        const newMsgs: UIMessage[] = [];
        for (const ev of newEvents) {
          const msg = runEventToUI(ev);
          if (msg !== null) newMsgs.push(msg);
        }
        if (newMsgs.length > 0) {
          setMessages((prevMsgs) => [...prevMsgs, ...newMsgs]);
        }
        return { runId, shown: events.length };
      });

      // Check for terminal status and stop polling when the run ends.
      let rec: RunRecord | null = null;
      try {
        rec = store.get(runId);
      } catch {
        rec = null;
      }
      if (rec !== null && terminal.has(rec.status)) {
        const statusLine = rec.finalMessage
          ? `Run ${runId.slice(0, 8)} ${rec.status}: ${rec.finalMessage}`
          : `Run ${runId.slice(0, 8)} finished with status: ${rec.status}.`;
        setMessages((prev) => [
          ...prev,
          rec!.status === "done"
            ? { kind: "done" as const, text: statusLine }
            : rec!.status === "stuck"
              ? { kind: "stuck" as const, text: statusLine }
              : { kind: "error" as const, text: statusLine },
        ]);
        setAttached(null);
        clearInterval(id);
      }
    }, 800);

    return () => clearInterval(id);
  // runEventToUI is stable (defined at render scope); only re-run when attached runId changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached?.runId]);

  // Re-render on terminal resize (SIGWINCH) so the UI reflows without crashing.
  useEffect(() => {
    const onResize = (): void => setResizeTick((t) => t + 1);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  // When launched straight into a project, replay any saved session history.
  useEffect(() => {
    if (project && session) {
      const history = session.getHistory();
      if (history.length > 0) {
        setMessages(historyToUI(history));
      }
    }
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to agent loop events once and translate them into UI state.
  useEffect(() => {
    const onThought = (thought: string) => {
      push({ kind: "thought", text: thought });
      setStatus({ state: "thinking" });
      // Reflect activity even for runs the UI didn't start (e.g. a scheduled
      // task), so the prompt shows "working…" and user submits are blocked.
      setBusy(true);
    };
    const onToolCall = (data: { tool: string; params: Record<string, unknown> }) => {
      push({ kind: "toolCall", tool: data.tool, params: data.params });
      setStatus({ state: "running", tool: data.tool });
      setBusy(true);
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
    const onPlan = (next: Phase[]) => setPhases(next);
    const onPhaseUpdate = (next: Phase[]) => setPhases(next);

    agentLoop.on("thought", onThought);
    agentLoop.on("toolCall", onToolCall);
    agentLoop.on("toolResult", onToolResult);
    agentLoop.on("message", onMessage);
    agentLoop.on("done", onDone);
    agentLoop.on("stuck", onStuck);
    agentLoop.on("error", onError);
    agentLoop.on("plan", onPlan);
    agentLoop.on("phaseUpdate", onPhaseUpdate);

    return () => {
      agentLoop.off("thought", onThought);
      agentLoop.off("toolCall", onToolCall);
      agentLoop.off("toolResult", onToolResult);
      agentLoop.off("message", onMessage);
      agentLoop.off("done", onDone);
      agentLoop.off("stuck", onStuck);
      agentLoop.off("error", onError);
      agentLoop.off("plan", onPlan);
      agentLoop.off("phaseUpdate", onPhaseUpdate);
    };
  }, [agentLoop, push]);

  // Subscribe to the worker pool so the UI reflects parallel job activity live.
  useEffect(() => {
    const pool = getWorkerPool();
    const onSnapshot = (all: WorkerStatus[]) => setWorkers(all);
    pool.on("snapshot", onSnapshot);
    // Seed with whatever is already known.
    setWorkers(pool.getStatuses());
    return () => {
      pool.off("snapshot", onSnapshot);
    };
  }, []);

  // Register an approval handler so the loop can pause shell commands for the
  // user (when "require command approval" is on). The handler returns a promise
  // resolved by the y/n prompt below. Cleared on unmount so a headless/teardown
  // path stays autonomous.
  useEffect(() => {
    const handler = (req: ApprovalRequest): Promise<boolean> =>
      new Promise<boolean>((resolve) => setApproval({ summary: req.summary, resolve }));
    agentLoop.setApprovalHandler(handler);
    return () => agentLoop.setApprovalHandler(undefined);
  }, [agentLoop]);

  // ---- Onboarding completion / skip -----------------------------------------

  const finishOnboarding = useCallback(
    (result: OnboardingResult) => {
      try {
        saveConfig({
          onboardingCompleted: true,
          permReadFiles: result.permissions.readFiles,
          permSuggestEdits: result.permissions.suggestEdits,
          requireCommandApproval: result.permissions.requireCommandApproval,
        });
        setConfig(getConfig());
      } catch (err) {
        push({ kind: "error", text: `Could not save setup: ${errText(err)}` });
      }
      // Workspace routing: current-dir continues straight into chat; the other
      // two open the project selector (which handles open + create).
      setMode(result.workspaceMode === "current-dir" ? "chat" : "projects");
      if (result.starter) {
        setInput(result.starter);
      }
    },
    [push],
  );

  const skipOnboarding = useCallback(() => {
    try {
      saveConfig({ onboardingCompleted: true });
      setConfig(getConfig());
    } catch {
      // Non-fatal: worst case onboarding shows again next launch.
    }
    setMode(currentProject ? "chat" : "projects");
  }, [currentProject]);

  const submitTask = useCallback(
    (task: string) => {
      const trimmed = task.trim();
      if (trimmed.length === 0 || busy) return;
      // Stop tailing any background run when the user starts a new foreground task.
      setAttached(null);
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

  /** Reflect a saved config: update local state and hot-swap provider/workspace. */
  const applySaved = useCallback(
    (built: Partial<Config>, saved: Config) => {
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
        applyWorkspaceRoot(saved.workspacePath);
        agentLoop.refreshWorkspace();
        setActiveWorkspace(resolveWorkspacePath(saved));
      }
    },
    [agentLoop, push],
  );

  /** Save without validation (used for the model override, which can't be invalid). */
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
      applySaved(built, saved);
    },
    [applySaved, push],
  );

  /**
   * Validate a settings change with live checks (API key / Telegram token /
   * workspace path), and only persist when everything passes. Returns the
   * outcome so the editing overlay can show ✅/❌.
   */
  const validateAndApply = useCallback(
    async (raw: Record<string, string>): Promise<ValidationResult> => {
      const built = buildPartial(raw);
      if ("error" in built) {
        return { ok: false, message: `❌ ${built.error}` };
      }
      const effective: Config = { ...config, ...built };
      const okMessages: string[] = [];

      const touchesApi =
        "apiKey" in built || "apiProvider" in built || "providerMode" in built;
      if (touchesApi && effective.providerMode === "api" && effective.apiKey.trim().length > 0) {
        const res = await validateApiKey(effective.apiProvider, effective.apiKey, effective.activeModel);
        if (!res.ok) return res;
        okMessages.push(res.message);
      }

      if ("telegramToken" in built && effective.telegramToken.trim().length > 0) {
        const res = await validateTelegramToken(effective.telegramToken);
        if (!res.ok) return res;
        okMessages.push(res.message);
      }

      if ("workspacePath" in built) {
        const res = validateWorkspacePath(effective.workspacePath);
        if (!res.ok) return res;
        okMessages.push(res.message);
      }

      let saved: Config;
      try {
        saved = saveConfig(built);
      } catch (err) {
        return { ok: false, message: `❌ Could not save: ${errText(err)}` };
      }
      applySaved(built, saved);
      return { ok: true, message: okMessages.length > 0 ? okMessages.join("  ") : "✅ Saved." };
    },
    [config, applySaved],
  );

  // ---- Project selection (fallback path / no launch project) ----------------

  const openProject = useCallback(
    (proj: Project) => {
      touchProject(proj.id);
      if (session) {
        session.bindPersistence(newSessionFilePath(proj.id), { projectId: proj.id });
      }
      setCurrentProject(proj);
      setMessages([]);
      setPhases([]);
      setStatus({ state: "idle" });
      setMode("chat");
      setProjects(listProjects());
    },
    [session],
  );

  const createAndOpen = useCallback(
    (name: string) => {
      const proj = createProject(name);
      openProject(proj);
    },
    [openProject],
  );

  // ---- Slash command dispatch ----------------------------------------------

  const runCommand = useCallback(
    (name: string, args: string) => {
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
        case "/sessions":
          setOverlay("sessions");
          break;
        case "/model":
          setOverlay("model");
          break;
        case "/provider":
          setOverlay("provider");
          break;
        case "/workers":
          setOverlay("workers");
          break;
        case "/memory": {
          const query = args.trim();
          if (query.length === 0) {
            setOverlay("memory");
            break;
          }
          // Guard: LongTermMemory's ctor touches the filesystem (ensureDirSync);
          // a failure here must not escape the input handler and crash the TUI.
          try {
            const hits = new LongTermMemory().recall(query, 5);
            if (hits.length === 0) {
              push({ kind: "agent", text: `No stored memories matched "${query}".` });
            } else {
              const body = hits
                .map((h, i) => `${i + 1}. (${h.score.toFixed(2)}) ${h.excerpt}`)
                .join("\n");
              push({ kind: "agent", text: `Memory matches for "${query}":\n${body}` });
            }
          } catch (err) {
            push({ kind: "error", text: `Could not search memory: ${errText(err)}` });
          }
          break;
        }
        case "/schedule": {
          if (!scheduler) {
            push({ kind: "error", text: "Scheduling isn't available in this context." });
            break;
          }
          const rest = args.trim();
          if (rest.length === 0) {
            setOverlay("schedule");
            break;
          }
          const sub = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
          const tail = rest.slice(sub.length).trim();
          if (sub === "remove" || sub === "rm") {
            const ok = tail.length > 0 && scheduler.remove(tail);
            push({
              kind: ok ? "agent" : "error",
              text: ok ? `Removed schedule ${tail}.` : `No schedule with id "${tail}".`,
            });
          } else if (sub === "add") {
            let spec = tail.split(/\s+/)[0] ?? "";
            let task = tail.slice(spec.length).trim();
            // Support a space-separated ISO datetime ("2026-06-10 15:00"): fold a
            // trailing HH:MM[:SS] token into the date so it parses as one instant.
            if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
              const timeTok = task.split(/\s+/)[0] ?? "";
              if (/^\d{2}:\d{2}(:\d{2})?$/.test(timeTok)) {
                spec = `${spec}T${timeTok}`;
                task = task.slice(timeTok.length).trim();
              }
            }
            const trigger = parseScheduleSpec(spec);
            if (trigger === null || task.length === 0) {
              push({
                kind: "error",
                text: 'Usage: /schedule add <HH:MM | 30s/5m/2h | ISO-time> <task>',
              });
            } else {
              const created = scheduler.add({ task, trigger });
              push({
                kind: "agent",
                text: `Scheduled "${task}" (${describeTrigger(created.trigger)}) — id ${created.id}.`,
              });
            }
          } else {
            setOverlay("schedule");
          }
          break;
        }
        case "/background": {
          const task = args.trim();
          if (task.length === 0) {
            push({ kind: "error", text: "Usage: /background <task>" });
            break;
          }
          if (!currentProject) {
            push({ kind: "error", text: "Open a project first." });
            break;
          }
          try {
            const { runId } = launchBackgroundRun(task, currentProject.path);
            push({
              kind: "agent",
              text: `Started background run ${runId.slice(0, 8)}. Use /runs to list, /attach ${runId.slice(0, 8)} to follow.`,
            });
          } catch (err) {
            push({ kind: "error", text: `Could not start background run: ${errText(err)}` });
          }
          break;
        }
        case "/runs":
          setOverlay("runs");
          break;
        case "/attach": {
          const id = args.trim();
          if (id.length === 0) {
            push({ kind: "error", text: "Usage: /attach <runId>" });
            break;
          }
          const allRuns = (() => {
            try {
              return new RunStore().list();
            } catch {
              return [] as RunRecord[];
            }
          })();
          const match = allRuns.find((r) => r.runId === id || r.runId.startsWith(id));
          if (!match) {
            push({ kind: "error", text: `No run matching "${id}".` });
          } else {
            attachToRun(match);
          }
          break;
        }
        case "/onboarding":
          setOverlay("none");
          setMode("onboarding");
          break;
        case "/help":
          setOverlay("help");
          break;
        case "/clear":
          session?.clear();
          agentLoop.reset();
          setAttached(null);
          setMessages([{ kind: "agent", text: "Conversation cleared. Same project, fresh start." }]);
          setPhases([]);
          setStatus({ state: "idle" });
          break;
        default:
          push({ kind: "error", text: `Unknown command: ${name}. Type /help.` });
      }
    },
    [session, push, agentLoop, scheduler, currentProject, attachToRun],
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
    async (raw: Record<string, string>): Promise<ValidationResult> => {
      const res = await validateAndApply(raw);
      if (res.ok) {
        setOverlay("none");
        push({ kind: "agent", text: "Provider switched. Conversation preserved." });
      }
      return res;
    },
    [validateAndApply, push],
  );

  const onLoadSession = useCallback(
    (info: SessionInfo) => {
      if (session) {
        session.loadFrom(info.path);
        setMessages(historyToUI(session.getHistory()));
      }
      setOverlay("none");
      setStatus({ state: "idle" });
      push({
        kind: "agent",
        text: `Loaded session from ${info.when.toLocaleString()} (${info.count} message${info.count === 1 ? "" : "s"}).`,
      });
    },
    [session, push],
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
            const firstSpace = text.indexOf(" ");
            const args = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
            runCommand(cmd.name, args);
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
    { isActive: mode === "chat" && overlay === "none" && approval === null },
  );

  // Shell-command approval prompt: y approves, n / Esc denies.
  useInput(
    (value, key) => {
      if (!approval) return;
      if (value === "y" || value === "Y") {
        approval.resolve(true);
        setApproval(null);
      } else if (value === "n" || value === "N" || key.escape) {
        approval.resolve(false);
        setApproval(null);
      }
    },
    { isActive: approval !== null },
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
    {
      isActive:
        overlay === "tools" ||
        overlay === "history" ||
        overlay === "help" ||
        overlay === "workers" ||
        overlay === "memory" ||
        overlay === "schedule" ||
        overlay === "runs",
    },
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

      {mode === "onboarding" ? (
        <Onboarding
          initialPermissions={{
            readFiles: config.permReadFiles,
            suggestEdits: config.permSuggestEdits,
            requireCommandApproval: config.requireCommandApproval,
          }}
          onComplete={finishOnboarding}
          onSkip={skipOnboarding}
        />
      ) : mode === "projects" ? (
        <ProjectSelector projects={projects} onOpen={openProject} onCreate={createAndOpen} />
      ) : (
        <>
          <ChatView messages={messages} />

          {phases.length > 0 ? <PlanView phases={phases} /> : null}

          {workers.length > 0 && overlay === "none" ? <WorkerPanel workers={workers} /> : null}

          {approval ? (
            <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
              <Text color="yellow" bold>
                Approve shell command?
              </Text>
              <Text color="white">{"  "}{approval.summary}</Text>
              <Text color="gray">{"  y approve · n deny — nothing runs without your OK"}</Text>
            </Box>
          ) : null}

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
              onSave={validateAndApply}
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

          {overlay === "sessions" ? (
            <SessionsPanel
              projectId={currentProject?.id ?? null}
              onLoad={onLoadSession}
              onClose={() => setOverlay("none")}
            />
          ) : null}

          {overlay === "tools" ? <ToolsPanel browserAvailable={browserAvailable} /> : null}
          {overlay === "history" ? <HistoryPanel session={session} /> : null}
          {overlay === "workers" ? <WorkersOverlay workers={workers} /> : null}
          {overlay === "memory" ? <MemoryPanel /> : null}
          {overlay === "schedule" ? <SchedulePanel scheduler={scheduler} /> : null}
          {overlay === "runs" ? <RunsPanel /> : null}
          {overlay === "help" ? <HelpPanel /> : null}

          {!browserAvailable && overlay === "none" ? (
            <Text color="gray" dimColor>
              Browser tool unavailable — run npx playwright install chromium to enable
            </Text>
          ) : null}
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

// ---- Plan view --------------------------------------------------------------

interface PlanViewProps {
  phases: Phase[];
}

/** Glyph + color for a phase status. */
function phaseGlyph(status: Phase["status"]): { glyph: string; color: string } {
  switch (status) {
    case "completed":
      return { glyph: "✓", color: "green" };
    case "in_progress":
      return { glyph: "▶", color: "yellow" };
    case "failed":
      return { glyph: "✗", color: "red" };
    default:
      return { glyph: "○", color: "gray" };
  }
}

/** Compact, live-updating view of the agent's multi-phase plan. */
function PlanView({ phases }: PlanViewProps) {
  const done = phases.filter((p) => p.status === "completed").length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Text color="blue" bold>
        Plan ({done}/{phases.length} complete)
      </Text>
      {phases.map((phase) => {
        const { glyph, color } = phaseGlyph(phase.status);
        return (
          <Box key={phase.id}>
            <Text color={color}>
              {"  "}
              {glyph} {phase.id}. {phase.title}
            </Text>
            {phase.findings.length > 0 ? (
              <Text color="gray"> — {phase.findings[phase.findings.length - 1]}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

// ---- Read-only info panels --------------------------------------------------

/** Overlay variant of the worker view (/workers): shows a hint when idle. */
function WorkersOverlay({ workers }: { workers: WorkerStatus[] }) {
  if (workers.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
        <Text color="magenta" bold>
          Workers
        </Text>
        <Text color="gray">{"  (no worker activity yet — the code tool runs JS jobs here)"}</Text>
        <Text color="gray">Press any key to close.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <WorkerPanel workers={workers} />
      <Text color="gray">Press any key to close.</Text>
    </Box>
  );
}

/** Long-term memory listing (/memory). */
function MemoryPanel() {
  const notes = useMemo(() => {
    try {
      return new LongTermMemory().list();
    } catch {
      return [];
    }
  }, []);
  const recent = notes.slice(0, 12);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Long-term memory ({notes.length} note{notes.length === 1 ? "" : "s"})
      </Text>
      {recent.length === 0 ? (
        <Text color="gray">{"  (nothing remembered yet — the agent stores notes via the memory tool)"}</Text>
      ) : (
        recent.map((n) => (
          <Box key={n.id}>
            <Text color="white">
              {"  • "}
              {n.excerpt}
            </Text>
            {n.tags.length > 0 ? <Text color="gray"> [{n.tags.join(", ")}]</Text> : null}
          </Box>
        ))
      )}
      <Text color="gray">{"Tip: /memory <query> to search. Press any key to close."}</Text>
    </Box>
  );
}

/** Schedule listing (/schedule). */
function SchedulePanel({ scheduler }: { scheduler?: Scheduler }) {
  const schedules: Schedule[] = useMemo(() => (scheduler ? scheduler.list() : []), [scheduler]);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Schedules ({schedules.length})
      </Text>
      {schedules.length === 0 ? (
        <Text color="gray">{"  (none yet — add one with /schedule add <spec> <task>)"}</Text>
      ) : (
        schedules.map((s) => (
          <Box key={s.id} flexDirection="column">
            <Text color={s.enabled ? "white" : "gray"}>
              {"  "}
              {s.enabled ? "●" : "○"} {describeTrigger(s.trigger)} — {s.task}
            </Text>
            <Text color="gray">
              {"      id "}
              {s.id}
            </Text>
          </Box>
        ))
      )}
      <Text color="gray">
        {"add: /schedule add 30s|5m|HH:MM <task> · remove: /schedule remove <id>. Press any key to close."}
      </Text>
    </Box>
  );
}

interface ToolsPanelProps {
  browserAvailable: boolean;
}

/** Static reference of the agent's available tools (/tools). */
function ToolsPanel({ browserAvailable }: ToolsPanelProps) {
  const tools: Array<{ name: string; detail: string }> = [
    { name: "shell", detail: "run shell commands in the working directory (30s timeout)" },
    { name: "filesystem", detail: "read / write / list / delete / mkdir (workspace-relative)" },
    {
      name: "browser",
      detail: browserAvailable
        ? "navigate / click / type / screenshot (vision) / readText / waitFor / scroll / press (headless Chromium)"
        : "unavailable — run npx playwright install chromium to enable",
    },
    {
      name: "github",
      detail: "repos / files / issues + create/comment/close issues & pull requests (needs GITHUB_TOKEN)",
    },
    {
      name: "research",
      detail: "web research via the Tavily API — search + digest top results (needs TAVILY_API_KEY)",
    },
    { name: "code", detail: "run code (js sandbox / python / node / bash / powershell) in resource-limited workers" },
    { name: "memory", detail: "long-term memory — remember / recall with BM25 keyword search" },
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

/** Background runs listing (/runs). */
function RunsPanel() {
  const runs = useMemo(() => {
    try {
      return new RunStore().list();
    } catch {
      return [] as RunRecord[];
    }
  }, []);

  function statusGlyph(status: RunRecord["status"]): { glyph: string; color: string } {
    switch (status) {
      case "running":
        return { glyph: "▶", color: "yellow" };
      case "done":
        return { glyph: "✓", color: "green" };
      case "stuck":
        return { glyph: "⚠", color: "yellow" };
      case "error":
        return { glyph: "✗", color: "red" };
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>
        Background runs ({runs.length})
      </Text>
      {runs.length === 0 ? (
        <Text color="gray">{"  (none — start one with /background <task>)"}</Text>
      ) : (
        runs.map((rec) => {
          const { glyph, color } = statusGlyph(rec.status);
          const shortId = rec.runId.slice(0, 8);
          const taskPreview = rec.task.length > 60 ? `${rec.task.slice(0, 60)}…` : rec.task;
          return (
            <Box key={rec.runId}>
              <Text color={color}>{`  ${glyph} `}</Text>
              <Text color="white" bold>
                {shortId}
              </Text>
              <Text color="gray">{` [${rec.status}] `}</Text>
              <Text color="white">{taskPreview}</Text>
            </Box>
          );
        })
      )}
      <Text color="gray">/attach &lt;id&gt; to follow · press any key to close.</Text>
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
            message.role === "user"
              ? "white"
              : message.role === "assistant"
                ? "green"
                : message.role === "system"
                  ? "magenta"
                  : "gray";
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
