/**
 * verify-diff.ts — IMP-27 inline diff view.
 *  1. computeUnifiedDiff: changed/identical/new-file cases.
 *  2. The loop emits a "fileDiff" event with a real unified diff on a
 *     filesystem write (new file AND a subsequent edit show the right +/- lines).
 */
import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import { computeUnifiedDiff } from "../src/util/diff.js";
import type { Provider, GenerateRequest, GenerateResult } from "../src/providers/index.js";
import { clearToolResultCache } from "../src/tools/index.js";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
const textOf = (r: GenerateRequest): string => r.system + "\n" + r.messages.map((m) => m.content).join("\n");

/** Scripted: planning, then the given action steps, then done. */
class Scripted implements Provider {
  readonly name = "diff";
  readonly supportsVision = false;
  private step = 0;
  constructor(private readonly steps: GenerateResult[]) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (textOf(req).includes("planning module")) {
      return { text: JSON.stringify([{ title: "a", description: "b" }]), toolCalls: [] };
    }
    const s = this.steps[this.step];
    this.step += 1;
    return s ?? { text: "", toolCalls: [{ name: "done", arguments: { message: "ok" } }] };
  }
}

function main2(): void {
  // ---- 1. computeUnifiedDiff unit cases ----
  const changed = computeUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.txt");
  ok("diff marks a removed line", changed.includes("-b"));
  ok("diff marks an added line", changed.includes("+B"));
  ok("diff has a hunk header", changed.includes("@@"));
  ok("identical inputs → empty diff", computeUnifiedDiff("x\ny", "x\ny") === "");
  const created = computeUnifiedDiff("", "one\ntwo\n", "new.txt");
  // All-added: has +one/+two and NO removed-content line (a "-" line that
  // isn't the "---" file header).
  const hasRemovedContent = created.split(/\r?\n/).some((l) => /^-(?!--)/.test(l));
  ok("new file → all-added", created.includes("+one") && created.includes("+two") && !hasRemovedContent);
}

async function main(): Promise<void> {
  main2();

  const ws = path.join(os.tmpdir(), "openagent-diff-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  clearToolResultCache();
  const origReflect = getConfig().enableReflection;
  saveConfig({ enableReflection: false });

  try {
    // ---- 2a. new-file write emits a fileDiff with all-added lines ----
    {
      const provider = new Scripted([
        { text: "", toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: "hello.txt", content: "line one\nline two\n" } }] },
        { text: "", toolCalls: [{ name: "done", arguments: { message: "done" } }] },
      ]);
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      const diffs: Array<{ path: string; diff: string }> = [];
      loop.on("fileDiff", (d) => diffs.push(d));
      await loop.run("write hello.txt");
      await settle();
      ok("new-file write emitted exactly one fileDiff", diffs.length === 1 && diffs[0]?.path === "hello.txt");
      ok("new-file diff shows added lines", (diffs[0]?.diff.includes("+line one") ?? false));
    }

    // ---- 2b. editing an existing file emits a diff with - and + ----
    {
      clearToolResultCache();
      const provider = new Scripted([
        { text: "", toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: "edit.txt", content: "alpha\nbeta\n" } }] },
        { text: "", toolCalls: [{ name: "filesystem", arguments: { operation: "write", path: "edit.txt", content: "alpha\nBETA\n" } }] },
        { text: "", toolCalls: [{ name: "done", arguments: { message: "done" } }] },
      ]);
      const loop = new AgentLoop(provider, new SessionMemory(), new AgentMemory());
      const diffs: Array<{ path: string; diff: string }> = [];
      loop.on("fileDiff", (d) => diffs.push(d));
      await loop.run("edit a file");
      await settle();
      const editDiff = diffs.find((d) => d.diff.includes("-beta"));
      ok("edit emitted a diff with the removed line", editDiff !== undefined);
      ok("edit diff shows the replacement", (editDiff?.diff.includes("+BETA") ?? false));
    }
  } finally {
    saveConfig({ enableReflection: origReflect });
    clearToolResultCache();
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nDIFF VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
