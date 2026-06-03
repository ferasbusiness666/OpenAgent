// Deterministic end-to-end verification of the agent loop without a live model.
// A scripted provider returns the exact JSON a real model would, so we exercise
// the real parser, corrector, tool dispatch, filesystem tool, and done handling.
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import type { Provider } from "../src/providers/index.js";
import { getConfig, resolveWorkspacePath, setActiveWorkspace } from "../src/config/index.js";

class ScriptedProvider implements Provider {
  readonly name = "scripted-test";
  private calls = 0;

  async complete(_prompt: string): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) {
      // First call is now the PLANNING call — return a JSON phase array.
      return JSON.stringify([
        { title: "Create the file", description: "Write hello.txt with the content." },
      ]);
    }
    if (this.calls === 2) {
      // Second turn: write the file. Intentionally wrapped in prose + fences to
      // exercise the JSON extractor's tolerance.
      return [
        "Sure, here is my next step:",
        "```json",
        JSON.stringify({
          thought: "I will create hello.txt with the requested content.",
          action: "filesystem",
          params: { operation: "write", path: "hello.txt", content: "Hello World" },
          message: "Creating the file.",
        }),
        "```",
      ].join("\n");
    }
    // Third turn: the write succeeded, so finish.
    return JSON.stringify({
      thought: "The file was written successfully. Task complete.",
      action: "done",
      params: {},
      message: "Created hello.txt with the content 'Hello World'.",
    });
  }
}

async function main(): Promise<void> {
  // Point the active workspace at a temp dir BEFORE constructing AgentMemory so
  // the agent (and AGENT.md creation) never writes into the repo root.
  const workspace = path.join(os.tmpdir(), "openagent-verify-loop");
  fs.ensureDirSync(workspace);
  setActiveWorkspace(workspace);

  const loop = new AgentLoop(new ScriptedProvider(), new SessionMemory(), new AgentMemory());

  const events: string[] = [];
  loop.on("thought", (t) => events.push(`thought: ${t}`));
  loop.on("toolCall", (d) => events.push(`toolCall: ${d.tool} ${JSON.stringify(d.params)}`));
  loop.on("toolResult", (d) => events.push(`toolResult: ${d.tool} success=${d.success}`));
  loop.on("done", (m) => events.push(`done: ${m}`));
  loop.on("stuck", (m) => events.push(`stuck: ${m}`));
  loop.on("error", (m) => events.push(`error: ${m}`));

  await loop.run("create a file called hello.txt with the content Hello World");

  for (const e of events) console.log(" -", e);

  const ws = resolveWorkspacePath(getConfig());
  const file = path.join(ws, "hello.txt");
  const exists = await fs.pathExists(file);
  const content = exists ? await fs.readFile(file, "utf8") : "";
  console.log(`\nworkspace: ${ws}`);
  console.log(`hello.txt exists: ${exists}`);
  console.log(`hello.txt content: ${JSON.stringify(content)}`);

  const ok =
    exists &&
    content === "Hello World" &&
    events.some((e) => e.startsWith("toolResult: filesystem success=true")) &&
    events.some((e) => e.startsWith("done:"));
  console.log(`\nVERIFY: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

void main();
