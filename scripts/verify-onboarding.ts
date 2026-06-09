// Headless render + keyboard-drive test for the first-run Onboarding screen.
// Mounts <Onboarding/> via ink-testing-library (no real TTY needed), asserts
// the welcome frame, that pressing "s" skips, and that driving Enter/arrows
// through all 7 steps fires onComplete with a sensible result.
import { createElement } from "react";
import { render } from "ink-testing-library";
import {
  Onboarding,
  type OnboardingPermissions,
  type OnboardingResult,
} from "../src/ui/Onboarding.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STEP_WAIT = 40;

// Escape sequences Ink's input parser understands for the arrow keys.
const RIGHT = "[C";
const LEFT = "[D";
const UP = "[A";
const DOWN = "[B";
const ENTER = "\r";

const FULL_PERMS: OnboardingPermissions = {
  readFiles: true,
  suggestEdits: true,
  requireCommandApproval: true,
};

async function main(): Promise<void> {
  const checks: Array<[string, boolean]> = [];

  // --- 1) First frame: welcome + skip hint ---------------------------------
  {
    let skipped = false;
    let completed = false;
    const { lastFrame, stdin, unmount } = render(
      createElement(Onboarding, {
        initialPermissions: FULL_PERMS,
        onComplete: () => {
          completed = true;
        },
        onSkip: () => {
          skipped = true;
        },
      }),
    );
    // Wait long enough for the staggered reveal to surface the title row
    // (the ◆ mark shows first, then the title a couple of ticks later).
    await delay(400);
    const frame = lastFrame() ?? "";
    checks.push(["first frame has 'Welcome to OpenAgent'", frame.includes("Welcome to OpenAgent")]);
    checks.push(["first frame has 'Skip'", frame.includes("Skip")]);

    // --- 2) Pressing "s" triggers onSkip ----------------------------------
    stdin.write("s");
    await delay(STEP_WAIT);
    checks.push(["pressing 's' calls onSkip", skipped]);
    checks.push(["'s' did not also complete", !completed]);
    unmount();
  }

  // --- 3) Fresh render; drive Enter/arrows through every step --------------
  {
    let result: OnboardingResult | null = null;
    let skipped = false;
    const { lastFrame, stdin, unmount } = render(
      createElement(Onboarding, {
        initialPermissions: FULL_PERMS,
        onComplete: (r: OnboardingResult) => {
          result = r;
        },
        onSkip: () => {
          skipped = true;
        },
      }),
    );
    await delay(STEP_WAIT);

    // Step 1 -> 2 -> 3 -> 4 -> 5 (Enter advances on the informational steps).
    stdin.write(ENTER); // 1 -> 2
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 2 -> 3
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 3 -> 4
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 4 -> 5
    await delay(STEP_WAIT);
    const step5Frame = lastFrame() ?? "";
    checks.push(["reached Step 5 (workspace)", step5Frame.includes("Choose how OpenAgent should start")]);

    // Step 5: nothing selected -> Enter shows the hint, does not advance.
    stdin.write(ENTER);
    await delay(STEP_WAIT);
    const hintFrame = lastFrame() ?? "";
    checks.push(["Step 5 Enter w/o selection shows hint", hintFrame.includes("Select an option to continue")]);

    // Down selects the first card, then Enter continues to Step 6.
    stdin.write(DOWN);
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 5 -> 6
    await delay(STEP_WAIT);
    const step6Frame = lastFrame() ?? "";
    checks.push(["reached Step 6 (permissions)", step6Frame.includes("You stay in control")]);

    // Step 6: Enter finishes setup -> Step 7.
    stdin.write(ENTER); // 6 -> 7
    await delay(STEP_WAIT);
    const step7Frame = lastFrame() ?? "";
    checks.push(["reached Step 7 (complete)", step7Frame.includes("ready to build with OpenAgent")]);

    // Step 7: Enter (no starter picked) starts -> onComplete.
    stdin.write(ENTER);
    await delay(STEP_WAIT);

    const r = result as OnboardingResult | null;
    checks.push(["onComplete was called", r !== null]);
    checks.push(["onComplete not via skip", !skipped]);
    checks.push([
      "result has a permissions object",
      r !== null && typeof r.permissions === "object" && typeof r.permissions.readFiles === "boolean",
    ]);
    checks.push([
      "result has a workspaceMode",
      r !== null &&
        (r.workspaceMode === "open-existing" ||
          r.workspaceMode === "current-dir" ||
          r.workspaceMode === "create-new"),
    ]);
    checks.push([
      "first card selected -> workspaceMode is 'open-existing'",
      r !== null && r.workspaceMode === "open-existing",
    ]);
    checks.push(["no starter highlighted -> starter is null", r !== null && r.starter === null]);
    unmount();
  }

  // --- 4) Back navigation + starter selection ------------------------------
  {
    let result: OnboardingResult | null = null;
    const { stdin, unmount } = render(
      createElement(Onboarding, {
        initialPermissions: FULL_PERMS,
        onComplete: (r: OnboardingResult) => {
          result = r;
        },
        onSkip: () => {},
      }),
    );
    await delay(STEP_WAIT);

    // Advance to step 2 then Back to step 1 (no throw, Left is a no-op on 1).
    stdin.write(RIGHT); // 1 -> 2
    await delay(STEP_WAIT);
    stdin.write(LEFT); // 2 -> 1
    await delay(STEP_WAIT);
    stdin.write(LEFT); // 1 -> 1 (no-op)
    await delay(STEP_WAIT);

    // Now run forward to step 7 and pick a starter.
    stdin.write(ENTER); // 1 -> 2
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 2 -> 3
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 3 -> 4
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 4 -> 5
    await delay(STEP_WAIT);
    stdin.write(UP); // select last card (create-new)
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 5 -> 6
    await delay(STEP_WAIT);
    stdin.write(ENTER); // 6 -> 7
    await delay(STEP_WAIT);
    stdin.write(DOWN); // highlight first starter
    await delay(STEP_WAIT);
    stdin.write(ENTER); // start
    await delay(STEP_WAIT);

    const r = result as OnboardingResult | null;
    checks.push(["back-nav + forward completes", r !== null]);
    checks.push([
      "UP on Step 5 selected last card -> 'create-new'",
      r !== null && r.workspaceMode === "create-new",
    ]);
    checks.push([
      "starter highlighted -> 'Explain this project'",
      r !== null && r.starter === "Explain this project",
    ]);
    unmount();
  }

  for (const [label, ok] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
  }
  const allOk = checks.every(([, ok]) => ok);
  console.log(`\nONBOARDING VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
