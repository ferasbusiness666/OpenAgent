/**
 * verify-stream-cache.ts — IMP-15 (streaming) + IMP-16 (tool result cache).
 *
 * Tests:
 *  1. Streaming: executeTool("shell", ..., {onChunk}) → chunks contain output;
 *     final result also contains it.
 *  2. Loop toolChunk event: scripted provider runs a shell command; at least
 *     one "toolChunk" event is emitted with the expected content.
 *  3. Cache hit: filesystem read cached; direct disk delete (bypasses tool)
 *     between two reads → second read still succeeds from cache.
 *  4. Invalidation: shell command clears cache → next read fails (file gone).
 *  5. grep is cached too: same direct-delete trick.
 */

import { AgentLoop } from "../src/agent/loop.js";
import { SessionMemory } from "../src/memory/session.js";
import { AgentMemory } from "../src/memory/agent-md.js";
import { getConfig, saveConfig, setActiveWorkspace } from "../src/config/index.js";
import type { Provider, GenerateRequest, GenerateResult } from "../src/providers/index.js";
import { executeTool, clearToolResultCache } from "../src/tools/index.js";
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";

const checks: Array<[string, boolean]> = [];
const ok = (l: string, c: boolean): void => { checks.push([l, c]); };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

const textOf = (r: GenerateRequest): string =>
  r.system + "\n" + r.messages.map((m) => m.content).join("\n");

const planReply = (): GenerateResult => ({
  text: JSON.stringify([{ title: "a", description: "b" }]),
  toolCalls: [],
});

async function main(): Promise<void> {
  const ws = path.join(os.tmpdir(), "openagent-stream-cache-" + Date.now());
  fs.ensureDirSync(ws);
  setActiveWorkspace(ws);
  clearToolResultCache();

  const origReflect = getConfig().enableReflection;
  saveConfig({ enableReflection: false });

  try {
    // ---- 1. Streaming shell -------------------------------------------------
    {
      const chunks: string[] = [];
      // Use node -e to print two lines; works on Windows and Unix.
      const cmd = `node -e "console.log('AAA111');console.log('BBB222')"`;
      const result = await executeTool(
        "shell",
        { command: cmd },
        { onChunk: (chunk) => { chunks.push(chunk); } },
      );
      const concatenated = chunks.join("");
      ok("streaming shell: success:true", result.success === true);
      ok(
        "streaming chunks contain AAA111",
        concatenated.includes("AAA111"),
      );
      ok(
        "streaming chunks contain BBB222",
        concatenated.includes("BBB222"),
      );
      ok(
        "final result contains AAA111",
        result.result.includes("AAA111"),
      );
      ok(
        "final result contains BBB222",
        result.result.includes("BBB222"),
      );
    }

    // ---- 2. Loop emits toolChunk events -------------------------------------
    {
      class Scripted implements Provider {
        readonly name = "stream-test";
        readonly supportsVision = false;
        actionTurns = 0;
        async generate(req: GenerateRequest): Promise<GenerateResult> {
          if (textOf(req).includes("planning module")) return planReply();
          this.actionTurns += 1;
          if (this.actionTurns === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  name: "shell",
                  arguments: { command: `node -e "console.log('CHUNKTEST')"` },
                },
              ],
            };
          }
          return { text: "", toolCalls: [{ name: "done", arguments: { message: "ok" } }] };
        }
      }

      const loop = new AgentLoop(new Scripted(), new SessionMemory(), new AgentMemory());
      const toolChunks: Array<{ tool: string; chunk: string }> = [];
      loop.on("toolChunk", (data) => { toolChunks.push(data); });
      await loop.run("run chunk test");
      await settle();
      const chunkMatch = toolChunks.some(
        (c) => c.tool === "shell" && c.chunk.includes("CHUNKTEST"),
      );
      ok(
        "loop emits toolChunk with CHUNKTEST from shell",
        chunkMatch,
      );
    }

    // ---- 3. Cache hit -------------------------------------------------------
    {
      clearToolResultCache();
      const testFile = "cached-read.txt";
      const testContent = "CACHED-CONTENT-123";

      // Write the file via the tool (this also clears the cache per IMP-16).
      await executeTool("filesystem", { operation: "write", path: testFile, content: testContent });

      // First read — populates the cache.
      const read1 = await executeTool("filesystem", { operation: "read", path: testFile });
      ok("first read succeeds", read1.success === true && read1.result.includes(testContent));

      // Delete the file DIRECTLY (bypassing the tool) so the cache isn't invalidated.
      const absPath = path.join(ws, testFile);
      fs.removeSync(absPath);

      // Second read — must be served from cache (file is gone on disk).
      const read2 = await executeTool("filesystem", { operation: "read", path: testFile });
      ok(
        "second read after direct-delete still succeeds (cache hit)",
        read2.success === true && read2.result.includes(testContent),
      );
    }

    // ---- 4. Cache invalidation via shell ------------------------------------
    {
      // The cached-read.txt is still in the cache from check 3.
      // Run a shell command — this must clear the cache.
      await executeTool("shell", { command: `node -e "/* no-op */"` });

      // Now the cache is cleared and the file is gone → read must fail.
      const read3 = await executeTool("filesystem", { operation: "read", path: "cached-read.txt" });
      ok(
        "after shell command cache cleared → read fails (file gone)",
        read3.success === false,
      );
    }

    // ---- 5. grep is cached too (same direct-delete trick) -------------------
    {
      clearToolResultCache();
      const grepFile = "grep-cache-test.txt";
      const grepContent = "GREPME-UNIQUE-42";

      // Write file to disk.
      await executeTool("filesystem", { operation: "write", path: grepFile, content: grepContent });

      // First grep — populates the grep cache entry.
      const grep1 = await executeTool("filesystem", {
        operation: "grep",
        path: "",
        pattern: "GREPME-UNIQUE",
      });
      ok("first grep succeeds", grep1.success === true && grep1.result.includes(grepFile));

      // Delete file directly.
      fs.removeSync(path.join(ws, grepFile));

      // Second grep — must be served from cache (file is gone).
      const grep2 = await executeTool("filesystem", {
        operation: "grep",
        path: "",
        pattern: "GREPME-UNIQUE",
      });
      ok(
        "second grep after direct-delete still succeeds (grep cache hit)",
        grep2.success === true && grep2.result.includes(grepFile),
      );
    }

  } finally {
    saveConfig({ enableReflection: origReflect });
    clearToolResultCache();
    fs.removeSync(ws);
  }

  for (const [l, c] of checks) console.log(`${c ? "✓" : "✗"} ${l}`);
  const allOk = checks.every(([, c]) => c);
  console.log(`\nSTREAM-CACHE VERIFY: ${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

void main();
