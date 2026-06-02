// Headless render smoke test for the Ink UI. Mounts <App/> via
// ink-testing-library (no real TTY needed), drives a scripted agent run, and
// asserts the transcript renders the key message kinds without throwing.
import { createElement } from "react";
import { render } from "ink-testing-library";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import type { Provider } from "../src/providers/index.js";
import { App } from "../src/ui/App.js";

class ScriptedProvider implements Provider {
  readonly name = "scripted-ui";
  private calls = 0;
  async complete(_prompt: string): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) {
      return JSON.stringify({
        thought: "Listing the workspace first.",
        action: "filesystem",
        params: { operation: "list", path: "" },
        message: "Looking around.",
      });
    }
    return JSON.stringify({
      thought: "All set.",
      action: "done",
      params: {},
      message: "Finished the demo task.",
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const loop = new AgentLoop(new ScriptedProvider(), new SessionMemory(), new AgentMemory());

  // initialTask drives the single run() so we exercise the real App entry path
  // (App's mount effect calls submitTask -> loop.run). We then poll for the frame.
  const { lastFrame, unmount } = render(
    createElement(App, {
      agentLoop: loop,
      providerName: "scripted-ui",
      workspacePath: "D:/open_agent/workspace",
      initialTask: "demo: list the workspace and finish",
    }),
  );

  // Wait for the loop (kicked off by App's initialTask effect) to finish.
  await new Promise<void>((resolve) => {
    loop.once("done", () => resolve());
    loop.once("error", () => resolve());
    loop.once("stuck", () => resolve());
  });
  await sleep(150);

  const frame = lastFrame() ?? "";
  unmount();

  console.log("----- rendered frame -----");
  console.log(frame);
  console.log("--------------------------");

  const checks: Array<[string, boolean]> = [
    ["header rendered", frame.includes("Open Agent")],
    ["status bar rendered", frame.includes("provider:") && frame.includes("ws:")],
    ["tool call/result shown", frame.includes("filesystem")],
    ["done shown", frame.includes("Done")],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${label}`);

  const allOk = checks.every(([, ok]) => ok);
  console.log(`\nUI VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
