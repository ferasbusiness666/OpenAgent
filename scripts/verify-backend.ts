// Deterministic backend verification (no network, no real CLI). Exercises the
// new/changed utility and memory modules end-to-end against temp files:
//   - util/json: extractJsonObject (fenced object + null path)
//   - memory/projects: createProject(path) + getProjectByPath round-trip
//   - memory/session: rollover/summarization past SESSION_MAX + persist-path swap
//   - memory/session-store: serialize/deserialize preserving the "system" role
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { randomUUID } from "node:crypto";
import { extractJsonObject } from "../src/util/json.js";
import { createProject, getProjectByPath } from "../src/memory/projects.js";
import { SessionMemory, SESSION_MAX } from "../src/memory/session.js";
import type { Message } from "../src/memory/session.js";
import {
  newSessionFilePath,
  serializeMessages,
  deserializeMessages,
} from "../src/memory/session-store.js";

function check(label: string, ok: boolean): boolean {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

async function main(): Promise<void> {
  const results: boolean[] = [];

  // 1. extractJsonObject -----------------------------------------------------
  const extracted = extractJsonObject('noise ```json {"a":1} ``` noise');
  let parsedA = false;
  if (extracted !== null) {
    try {
      const obj = JSON.parse(extracted) as { a?: number };
      parsedA = obj.a === 1;
    } catch {
      parsedA = false;
    }
  }
  results.push(check(`extractJsonObject pulls {"a":1} from fenced noise (got ${JSON.stringify(extracted)})`, parsedA));
  results.push(check("extractJsonObject returns null for non-JSON text", extractJsonObject("no json here") === null));

  // 2. projects round-trip ---------------------------------------------------
  const projectDir = path.join(os.tmpdir(), `openagent-verify-proj-${randomUUID()}`);
  fs.ensureDirSync(projectDir);
  const created = createProject("Test Proj (verify-backend)", projectDir);
  results.push(check(`createProject sets .path (${created.path})`, created.path === path.resolve(projectDir)));
  const found = getProjectByPath(projectDir);
  results.push(
    check(
      "getProjectByPath finds the project by directory",
      found !== undefined && found.id === created.id,
    ),
  );

  // 3. session rollover ------------------------------------------------------
  const projectId = `verify-backend-${randomUUID()}`;
  const sessionPath = newSessionFilePath(projectId);
  const session = new SessionMemory();
  session.bindPersistence(sessionPath, { projectId });

  // Add enough messages to trip the cap. Rollover fires once history reaches
  // SESSION_MAX (500): the oldest 250 are summarized into a single "system" note
  // and the recent 250 are kept, leaving 251. Adding exactly SESSION_MAX messages
  // triggers rollover on the final add and lands the history at exactly 251.
  for (let i = 0; i < SESSION_MAX; i += 1) {
    session.addMessage(i % 2 === 0 ? "user" : "assistant", `message ${i}`);
  }

  const history = session.getHistory();
  results.push(check(`session length capped after rollover (${history.length} <= 251)`, history.length <= 251 && history.length < SESSION_MAX));
  results.push(
    check(
      `first message after rollover is role "system" (got "${history[0]?.role}")`,
      history[0]?.role === "system",
    ),
  );
  const newPath = session.getPersistPath();
  results.push(
    check(
      `getPersistPath rolled to a new file (${path.basename(newPath ?? "")} != ${path.basename(sessionPath)})`,
      typeof newPath === "string" && newPath !== sessionPath,
    ),
  );

  // 4. session-store round-trip preserves "system" role ----------------------
  const sample: Message[] = [
    { role: "system", content: "an archived summary", timestamp: new Date() },
    { role: "user", content: "hello", timestamp: new Date() },
  ];
  const restored = deserializeMessages(serializeMessages(sample));
  results.push(
    check(
      "serialize/deserialize preserves the system-role message",
      restored.length === 2 &&
        restored[0].role === "system" &&
        restored[0].content === "an archived summary" &&
        restored[1].role === "user",
    ),
  );

  const ok = results.every(Boolean);
  console.log(`\nBACKEND VERIFY: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

void main();
