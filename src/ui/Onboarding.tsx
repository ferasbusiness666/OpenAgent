import { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface OnboardingPermissions {
  /** Informational (always allowed); shown as a toggle. */
  readFiles: boolean;
  /** Gates file writes/deletes elsewhere. */
  suggestEdits: boolean;
  /** Pauses shell commands for approval elsewhere. */
  requireCommandApproval: boolean;
}

export type WorkspaceStartMode = "open-existing" | "current-dir" | "create-new";

export interface OnboardingResult {
  permissions: OnboardingPermissions;
  workspaceMode: WorkspaceStartMode;
  /** The Step-7 starter prompt the user picked, or null. */
  starter: string | null;
}

export interface OnboardingProps {
  initialPermissions: OnboardingPermissions;
  /** Finish / Start. */
  onComplete: (result: OnboardingResult) => void;
  /** Skip onboarding. */
  onSkip: () => void;
}

// ---------------------------------------------------------------------------
// Step data
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 7;

/** Workspace start-mode cards for Step 5, in display order. */
const WORKSPACE_MODES: ReadonlyArray<{
  id: WorkspaceStartMode;
  title: string;
  note: string;
}> = [
  {
    id: "open-existing",
    title: "Open existing project",
    note: "Use OpenAgent with a folder you already have.",
  },
  {
    id: "current-dir",
    title: "Start in current directory",
    note: "Continue from the folder where OpenAgent is running.",
  },
  {
    id: "create-new",
    title: "Create new project",
    note: "Start fresh with OpenAgent helping from the beginning.",
  },
];

type PermissionKey = keyof OnboardingPermissions;

/** Permission rows for Step 6, in display order. */
const PERMISSION_ROWS: ReadonlyArray<{
  key: PermissionKey;
  label: string;
  note: string;
}> = [
  { key: "readFiles", label: "Read files", note: "Let OpenAgent read your workspace." },
  { key: "suggestEdits", label: "Suggest edits", note: "Let OpenAgent propose file changes." },
  {
    key: "requireCommandApproval",
    label: "Run commands with approval",
    note: "Ask you before running shell commands.",
  },
];

/** Starter prompts offered on Step 7, in display order. */
const STARTERS: readonly string[] = ["Explain this project", "Find bugs or issues", "Help me build a feature"];

/** Per-step delay (ms) between staggered row/item reveals. Calm, not blocking. */
const REVEAL_INTERVAL_MS = 90;

// ---------------------------------------------------------------------------
// Small presentational helpers (match the house style)
// ---------------------------------------------------------------------------

/** A faint divider used between header and body. */
function HeaderRule(): JSX.Element {
  return <Text color="gray">{"─".repeat(46)}</Text>;
}

/**
 * Staggered reveal: returns how many of `count` items should currently be
 * visible. Starts at 1 and ticks up to `count` on a timer. Resets whenever the
 * step (the `resetKey`) changes, and clears its timer on unmount / step change
 * so nothing leaks. Navigation never waits on this — callers always render the
 * full step; this only governs the gentle fade-in of sub-rows.
 */
function useStaggeredReveal(count: number, resetKey: number): number {
  const [visible, setVisible] = useState(1);

  useEffect(() => {
    // New step: show the first item immediately, then reveal the rest.
    setVisible(1);
    if (count <= 1) {
      return;
    }
    const timer = setInterval(() => {
      setVisible((prev) => {
        if (prev >= count) {
          clearInterval(timer);
          return prev;
        }
        return prev + 1;
      });
    }, REVEAL_INTERVAL_MS);
    return () => clearInterval(timer);
    // resetKey re-runs the effect (and clears the old timer) on step change.
  }, [count, resetKey]);

  return Math.min(visible, count);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * First-run 7-step onboarding, the terminal adaptation of the OpenAgent product
 * brief. Pure keyboard navigation via a single useInput.
 *
 * Keyboard scheme:
 *  - Global: Right / Enter = Next/Continue/Finish/Start (context-dependent);
 *    Left = Back (no-op on Step 1); `s` = Skip (onSkip).
 *  - Step 5: Up/Down move among the 3 cards; Enter continues only if a card is
 *    selected (else a hint is shown). Nothing is selected initially.
 *  - Step 6: Up/Down move among the 3 rows; Space toggles the highlighted
 *    permission; Enter finishes setup.
 *  - Step 7: Up/Down highlight a starter (optional); Enter starts.
 *
 * Starter selection: `starter` defaults to null. The user only enters the
 * starter list by pressing Up/Down on Step 7; doing so highlights an item.
 * Pressing Enter then resolves result.starter to the highlighted item. If the
 * user never moves into the list, no starter is highlighted and result.starter
 * stays null. Simple and predictable: move-then-Enter picks one, plain Enter
 * picks none.
 */
export function Onboarding({ initialPermissions, onComplete, onSkip }: OnboardingProps): JSX.Element | null {
  // Steps are 1-indexed to mirror the on-screen "Step N of 7".
  const [step, setStep] = useState(1);

  // Step 5 — workspace mode. null = nothing selected yet (Continue disabled).
  const [workspaceIndex, setWorkspaceIndex] = useState<number | null>(null);
  const [step5Hint, setStep5Hint] = useState(false);

  // Step 6 — permissions. Seeded from props; row 0 highlighted.
  const [permissions, setPermissions] = useState<OnboardingPermissions>(initialPermissions);
  const [permIndex, setPermIndex] = useState(0);

  // Step 7 — starter. -1 = the user has not moved into the list (null result).
  const [starterIndex, setStarterIndex] = useState(-1);

  const goNext = useCallback(() => {
    setStep((prev) => Math.min(prev + 1, TOTAL_STEPS));
  }, []);

  const goBack = useCallback(() => {
    // No-op on Step 1.
    setStep((prev) => Math.max(prev - 1, 1));
  }, []);

  const finish = useCallback(() => {
    const workspaceMode: WorkspaceStartMode =
      workspaceIndex === null ? "current-dir" : WORKSPACE_MODES[workspaceIndex].id;
    const starter = starterIndex >= 0 ? STARTERS[starterIndex] : null;
    onComplete({ permissions, workspaceMode, starter });
  }, [workspaceIndex, starterIndex, permissions, onComplete]);

  useInput((input, key) => {
    // Skip works on every step.
    if (input === "s" || input === "S") {
      onSkip();
      return;
    }

    // Left = Back everywhere (no-op on Step 1).
    if (key.leftArrow) {
      goBack();
      return;
    }

    if (step === 5) {
      if (key.upArrow) {
        setStep5Hint(false);
        setWorkspaceIndex((prev) => {
          if (prev === null) return WORKSPACE_MODES.length - 1;
          return (prev - 1 + WORKSPACE_MODES.length) % WORKSPACE_MODES.length;
        });
        return;
      }
      if (key.downArrow) {
        setStep5Hint(false);
        setWorkspaceIndex((prev) => {
          if (prev === null) return 0;
          return (prev + 1) % WORKSPACE_MODES.length;
        });
        return;
      }
      if (key.return || key.rightArrow) {
        if (workspaceIndex === null) {
          setStep5Hint(true);
          return;
        }
        goNext();
      }
      return;
    }

    if (step === 6) {
      if (key.upArrow) {
        setPermIndex((prev) => (prev - 1 + PERMISSION_ROWS.length) % PERMISSION_ROWS.length);
        return;
      }
      if (key.downArrow) {
        setPermIndex((prev) => (prev + 1) % PERMISSION_ROWS.length);
        return;
      }
      if (input === " ") {
        const rowKey = PERMISSION_ROWS[permIndex].key;
        setPermissions((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
        return;
      }
      if (key.return || key.rightArrow) {
        goNext();
      }
      return;
    }

    if (step === 7) {
      if (key.upArrow) {
        setStarterIndex((prev) => {
          if (prev <= 0) return STARTERS.length - 1;
          return prev - 1;
        });
        return;
      }
      if (key.downArrow) {
        setStarterIndex((prev) => {
          if (prev < 0) return 0;
          return (prev + 1) % STARTERS.length;
        });
        return;
      }
      if (key.return || key.rightArrow) {
        finish();
      }
      return;
    }

    // Steps 1–4: Right / Enter advance.
    if (key.return || key.rightArrow) {
      goNext();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Header step={step} />
      <HeaderRule />
      <Box flexDirection="column" marginTop={1}>
        <StepBody
          step={step}
          workspaceIndex={workspaceIndex}
          step5Hint={step5Hint}
          permissions={permissions}
          permIndex={permIndex}
          starterIndex={starterIndex}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{footerFor(step, workspaceIndex)}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Header + footer
// ---------------------------------------------------------------------------

function Header({ step }: { step: number }): JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Text color="magenta" bold>
        OpenAgent
      </Text>
      <Text color="cyan">
        Step {step} of {TOTAL_STEPS}
      </Text>
    </Box>
  );
}

/** Footer hint line — the available keys for the current step. */
function footerFor(step: number, workspaceIndex: number | null): string {
  const skip = "s Skip";
  switch (step) {
    case 1:
      return `Enter Get started   ·   ${skip}`;
    case 5: {
      const cont = workspaceIndex === null ? "Enter Continue (select first)" : "Enter Continue";
      return `↑/↓ Choose · ${cont} · ← Back · ${skip}`;
    }
    case 6:
      return `↑/↓ Move · Space Toggle · Enter Finish setup · ← Back · ${skip}`;
    case 7:
      return `↑/↓ Pick starter (optional) · Enter Start using OpenAgent · ← Back · ${skip}`;
    default:
      return `Enter Continue · ← Back · ${skip}`;
  }
}

// ---------------------------------------------------------------------------
// Step body dispatch
// ---------------------------------------------------------------------------

interface StepBodyProps {
  step: number;
  workspaceIndex: number | null;
  step5Hint: boolean;
  permissions: OnboardingPermissions;
  permIndex: number;
  starterIndex: number;
}

function StepBody(props: StepBodyProps): JSX.Element {
  switch (props.step) {
    case 1:
      return <Step1 />;
    case 2:
      return <Step2 />;
    case 3:
      return <Step3 />;
    case 4:
      return <Step4 />;
    case 5:
      return <Step5 selected={props.workspaceIndex} showHint={props.step5Hint} />;
    case 6:
      return <Step6 permissions={props.permissions} active={props.permIndex} />;
    case 7:
      return <Step7 selected={props.starterIndex} />;
    default:
      return <Step1 />;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

function Step1(): JSX.Element {
  // Reveal order: mark, title, subtitle, helper, actions.
  const visible = useStaggeredReveal(5, 1);
  return (
    <Box flexDirection="column">
      {visible >= 1 ? <Text color="cyan">◆</Text> : null}
      {visible >= 2 ? (
        <Text color="white" bold>
          Welcome to OpenAgent
        </Text>
      ) : null}
      {visible >= 3 ? (
        <Text color="gray">
          Your AI development partner for understanding, editing, debugging, and building projects from one workspace.
        </Text>
      ) : null}
      {visible >= 4 ? <Text color="gray">Setup takes less than a minute.</Text> : null}
      {visible >= 5 ? (
        <Box marginTop={1}>
          <Text color="green">Enter Get started</Text>
          <Text color="gray">{"   ·   "}</Text>
          <Text color="gray">s Skip onboarding</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Understand the Project
// ---------------------------------------------------------------------------

const STEP2_FEATURES = ["Read project structure", "Explain confusing files", "Find where features are built"];

function Step2(): JSX.Element {
  // Reveal: title, desc, then the three feature rows (5 items total).
  const visible = useStaggeredReveal(2 + STEP2_FEATURES.length, 2);
  return (
    <Box flexDirection="column">
      {visible >= 1 ? (
        <Text color="white" bold>
          Understand your codebase faster
        </Text>
      ) : null}
      {visible >= 2 ? (
        <Text color="gray">
          OpenAgent can read project structure, explain files, trace logic, and see how the code fits together.
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {STEP2_FEATURES.map((feature, i) =>
          visible >= 3 + i ? (
            <Text key={feature} color="white">
              <Text color="green">{"  ✓ "}</Text>
              {feature}
            </Text>
          ) : null,
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">{"src/"}</Text>
        <Box>
          <Text color="gray">{"  ui/        "}</Text>
          <Text color="cyan">App.tsx</Text>
        </Box>
        <Text color="gray">{"  agent/     loop.ts"}</Text>
        <Text color="gray">{"  tools/     index.ts"}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Make Changes Safely
// ---------------------------------------------------------------------------

function Step3(): JSX.Element {
  const visible = useStaggeredReveal(3, 3);
  return (
    <Box flexDirection="column">
      {visible >= 1 ? (
        <Text color="white" bold>
          Make changes with confidence
        </Text>
      ) : null}
      {visible >= 2 ? (
        <Text color="gray">
          OpenAgent can suggest edits, refactor, and implement features while keeping you in control.
        </Text>
      ) : null}
      {visible >= 3 ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="cyan">app/routes/dashboard.tsx</Text>
          <Text color="gray">{"  export function Dashboard() {"}</Text>
          <Text color="gray">{"    const data = useData();"}</Text>
          <Text color="green">{"  +   const stats = useStats();"}</Text>
          <Text color="gray">{"    return <Layout>…</Layout>;"}</Text>
          <Text color="gray">{"  }"}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">You review changes before applying them.</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Terminal and Debugging Help
// ---------------------------------------------------------------------------

function Step4(): JSX.Element {
  // Reveal: title, desc, then the terminal preview lines (command, error, bubble).
  const visible = useStaggeredReveal(5, 4);
  return (
    <Box flexDirection="column">
      {visible >= 1 ? (
        <Text color="white" bold>
          Run tasks, fix errors, and keep moving
        </Text>
      ) : null}
      {visible >= 2 ? (
        <Text color="gray">
          OpenAgent helps with terminal commands, build errors, tests, installs, and setup tasks.
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        {visible >= 3 ? <Text color="white">$ npm run build</Text> : null}
        {visible >= 4 ? <Text color="red">Build failed</Text> : null}
        {visible >= 5 ? (
          <Text color="cyan">OpenAgent found the issue and suggests a fix.</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">You decide what runs. OpenAgent explains before taking action.</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Choose Workspace Start Mode
// ---------------------------------------------------------------------------

function Step5({ selected, showHint }: { selected: number | null; showHint: boolean }): JSX.Element {
  const visible = useStaggeredReveal(WORKSPACE_MODES.length, 5);
  return (
    <Box flexDirection="column">
      <Text color="white" bold>
        Choose how OpenAgent should start
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {WORKSPACE_MODES.map((mode, i) => {
          if (visible < i + 1) {
            return null;
          }
          const active = selected === i;
          return (
            <Box
              key={mode.id}
              flexDirection="column"
              borderStyle="round"
              borderColor={active ? "green" : "gray"}
              paddingX={1}
            >
              <Text color={active ? "greenBright" : "white"} bold={active}>
                {active ? "› " : "  "}
                {mode.title}
              </Text>
              <Text color="gray">{"  "}{mode.note}</Text>
            </Box>
          );
        })}
      </Box>
      {showHint ? (
        <Box marginTop={1}>
          <Text color="yellow">Select an option to continue</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 6 — Permissions and Control
// ---------------------------------------------------------------------------

function Step6({
  permissions,
  active,
}: {
  permissions: OnboardingPermissions;
  active: number;
}): JSX.Element {
  const visible = useStaggeredReveal(PERMISSION_ROWS.length, 6);
  return (
    <Box flexDirection="column">
      <Text color="white" bold>
        You stay in control
      </Text>
      <Text color="gray">
        OpenAgent may read files, suggest edits, or run commands. You can review actions before they happen.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_ROWS.map((row, i) => {
          if (visible < i + 1) {
            return null;
          }
          const isActive = active === i;
          const on = permissions[row.key];
          return (
            <Box key={row.key}>
              <Text color={isActive ? "greenBright" : "white"} bold={isActive}>
                {isActive ? "› " : "  "}
                {row.label}
              </Text>
              <Text color={on ? "green" : "gray"}> {on ? "[on]" : "[off]"}</Text>
              <Text color="gray"> — {row.note}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">You can change these later in /settings.</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 7 — Setup Complete
// ---------------------------------------------------------------------------

function Step7({ selected }: { selected: number }): JSX.Element {
  // Reveal: glyph + title + desc together-ish, then the starter rows.
  const visible = useStaggeredReveal(2 + STARTERS.length, 7);
  return (
    <Box flexDirection="column">
      {visible >= 1 ? (
        <Box>
          <Text color="green" bold>
            ✓{" "}
          </Text>
          <Text color="white" bold>
            You are ready to build with OpenAgent
          </Text>
        </Box>
      ) : null}
      {visible >= 2 ? (
        <Text color="gray">
          OpenAgent is set up and ready to help you understand, edit, debug, and build your project.
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {STARTERS.map((starter, i) => {
          if (visible < 3 + i) {
            return null;
          }
          const active = selected === i;
          return (
            <Text key={starter} color={active ? "greenBright" : "white"} bold={active}>
              {active ? "› " : "  "}
              {starter}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
