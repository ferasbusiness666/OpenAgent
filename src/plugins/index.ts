/**
 * plugins/index.ts — IMP-30: a sandboxed, file-based plugin system.
 *
 * A plugin is a single `.js` file that adds one new agent action. It is NEVER
 * imported, required, or eval'd in the main process. Two things happen to a
 * plugin file:
 *
 *   1. METADATA is read statically — a regex pulls the first header comment and
 *      `JSON.parse` decodes it. No plugin code runs during scanning.
 *   2. EXECUTION happens exclusively inside the existing worker-pool JS sandbox
 *      (the same `{ kind: "js" }` path the `code` tool uses — Node's `vm` in a
 *      resource-limited worker thread: no filesystem, no network, no require).
 *      We route through {@link getWorkerPool}().run, never our own vm.
 *
 * ── Writing a plugin ────────────────────────────────────────────────────────
 * Drop a `.js` file into `./plugins` (cwd-relative) or the user plugins dir
 * (~/.openagent/plugins). The FIRST line matching
 *
 *     // openagent-plugin: {…json…}
 *
 * carries all metadata; the file body must define a function named `execute`:
 *
 *     // openagent-plugin: {"name":"slugify","description":"Turn a string into a URL slug","schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}
 *     function execute(params) {
 *       return params.text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
 *     }
 *
 * `execute` receives the params object and returns the result. The result is
 * serialized with `JSON.stringify` and returned to the agent.
 *
 * ── Sandbox limitation: synchronous results ─────────────────────────────────
 * The worker JS sandbox evaluates the program synchronously (Node `vm`, no
 * top-level await, no microtask draining), so `execute` MUST produce its value
 * synchronously. A `Promise`-returning `execute` cannot be awaited inside the
 * sandbox and is rejected with a clear error rather than silently serializing to
 * `{}`. (Synchronous `execute` — by far the common case — works fully.)
 *
 * ── Discovery override (tests) ──────────────────────────────────────────────
 * When `OPENAGENT_PLUGIN_DIRS` is set, those `;`-delimited dirs are scanned
 * INSTEAD of the defaults, so plugins can be exercised from a temp directory.
 */

import fs from "fs-extra";
import path from "node:path";
import { getWorkerPool } from "../workers/pool.js";
import { PLUGINS_DIR } from "../paths.js";

/** Public, validated description of one installed plugin. */
export interface PluginInfo {
  /** [a-z0-9-]{1,40}; must not collide with a built-in action. */
  name: string;
  /** Human description, ≤ 200 chars. */
  description: string;
  /** JSON Schema for the params object passed to `execute`. */
  schema: Record<string, unknown>;
  /** Absolute path to the plugin's source file. */
  filePath: string;
}

/** Built-in action / tool names a plugin may NOT shadow. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "shell",
  "filesystem",
  "browser",
  "github",
  "research",
  "code",
  "memory",
  "serve",
  "http",
  "note",
  "update_plan",
  "done",
  "stuck",
  "plugin",
  "verdict",
]);

/** A plugin name: lowercase alphanumerics + dashes, 1–40 chars. */
const NAME_RE = /^[a-z0-9-]{1,40}$/;

/**
 * The metadata header. Matches the FIRST line of the form
 * `// openagent-plugin: { … }` (leading whitespace tolerated). The JSON object
 * is captured greedily-to-end-of-line so a single-line header is decoded whole.
 */
const HEADER_RE = /^[ \t]*\/\/[ \t]*openagent-plugin:[ \t]*(\{.*\})[ \t]*$/m;

/** Default sandbox timeout, and the clamp bounds enforced on caller input. */
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60_000;

/** Cached scan result; `loadPlugins({ reload: true })` rebuilds it. */
interface ScanResult {
  plugins: PluginInfo[];
  errors: string[];
}
let cache: ScanResult | null = null;

/**
 * Resolve the directories to scan. When `OPENAGENT_PLUGIN_DIRS` is set, those
 * `;`-delimited paths are used INSTEAD of the defaults (the test hook). The
 * defaults are `./plugins` (resolved against the current working directory) and
 * the user plugins dir, in that order — so a project-local plugin wins over a
 * user-global one of the same name (first-wins, see below).
 */
function pluginDirs(): string[] {
  const override = process.env.OPENAGENT_PLUGIN_DIRS;
  if (override && override.trim().length > 0) {
    return override
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.length > 0)
      .map((d) => path.resolve(d));
  }
  return [path.resolve(process.cwd(), "plugins"), PLUGINS_DIR];
}

/**
 * Type guard: a parsed value is a JSON object (not null, not an array). Used to
 * validate both the metadata envelope and the `schema` field without `any`.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse + validate one file's metadata header WITHOUT executing it. Returns the
 * built {@link PluginInfo} on success, or an error string describing why the
 * file was skipped. Never throws.
 */
function parsePluginHeader(filePath: string, source: string): PluginInfo | string {
  const match = HEADER_RE.exec(source);
  if (!match) {
    return `${path.basename(filePath)}: missing "// openagent-plugin: {…}" header`;
  }

  let meta: unknown;
  try {
    meta = JSON.parse(match[1]);
  } catch (err) {
    return `${path.basename(filePath)}: header JSON is invalid (${
      err instanceof Error ? err.message : String(err)
    })`;
  }

  if (!isJsonObject(meta)) {
    return `${path.basename(filePath)}: header must be a JSON object`;
  }

  // name -----------------------------------------------------------------
  const { name, description } = meta;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return `${path.basename(filePath)}: "name" must match ${NAME_RE.source}`;
  }
  if (RESERVED_NAMES.has(name)) {
    return `${path.basename(filePath)}: "${name}" is a reserved action name`;
  }

  // description -----------------------------------------------------------
  if (typeof description !== "string" || description.trim().length === 0) {
    return `${path.basename(filePath)}: "description" must be a non-empty string`;
  }
  if (description.length > 200) {
    return `${path.basename(filePath)}: "description" exceeds 200 chars`;
  }

  // schema ----------------------------------------------------------------
  let schema: Record<string, unknown>;
  if (meta.schema === undefined) {
    schema = { type: "object", properties: {} };
  } else if (isJsonObject(meta.schema)) {
    if (meta.schema.type !== "object") {
      return `${path.basename(filePath)}: "schema.type" must be "object"`;
    }
    schema = meta.schema;
  } else {
    return `${path.basename(filePath)}: "schema" must be a JSON object`;
  }

  return { name, description, schema, filePath };
}

/**
 * Scan the plugin directories for `*.js` files, parse their metadata headers,
 * validate, and return the registry. Plugin code is NEVER executed here —
 * discovery is pure file reads + regex + `JSON.parse`.
 *
 * Duplicate names: first wins (directory order, then alphabetical within a
 * dir); later duplicates are recorded in `errors` and skipped. Invalid files
 * are skipped and their reason collected into `errors`. Missing directories are
 * not errors. Results are cached; pass `{ reload: true }` to rescan.
 */
export function loadPlugins(options?: { reload?: boolean }): {
  plugins: PluginInfo[];
  errors: string[];
} {
  if (cache && !options?.reload) {
    return { plugins: [...cache.plugins], errors: [...cache.errors] };
  }

  const plugins: PluginInfo[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const dir of pluginDirs()) {
    let entries: string[];
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        continue;
      }
      entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch (err) {
      errors.push(
        `failed to read plugin dir ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".js")) continue;
      const filePath = path.join(dir, entry);

      let source: string;
      try {
        if (!fs.statSync(filePath).isFile()) continue;
        source = fs.readFileSync(filePath, "utf8");
      } catch (err) {
        errors.push(
          `${entry}: failed to read (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        continue;
      }

      const parsed = parsePluginHeader(filePath, source);
      if (typeof parsed === "string") {
        errors.push(parsed);
        continue;
      }
      if (seen.has(parsed.name)) {
        errors.push(
          `${entry}: duplicate plugin name "${parsed.name}" — skipped (first definition wins)`,
        );
        continue;
      }
      seen.add(parsed.name);
      plugins.push(parsed);
    }
  }

  cache = { plugins, errors };
  return { plugins: [...plugins], errors: [...errors] };
}

/**
 * Build the sandbox wrapper script: the plugin source verbatim, followed by a
 * trailer that calls `execute` with the params injected as a `JSON.stringify`
 * literal (never raw string concatenation), serializes the result, and leaves
 * that JSON string as the program's completion value (which the worker reports
 * back as its output). Because the sandbox is synchronous, a Promise-returning
 * `execute` is detected and rejected with a clear error.
 */
function buildWrapper(source: string, params: Record<string, unknown>): string {
  // JSON.stringify produces a valid JS literal for plain JSON data, so the
  // params are embedded inertly — no value the caller supplies can break out of
  // the literal or inject code.
  const paramsLiteral = JSON.stringify(params);
  return `${source}
;(function () {
  if (typeof execute !== "function") {
    throw new Error("plugin does not define a function named 'execute'");
  }
  var __params = ${paramsLiteral};
  var __result = execute(__params);
  if (__result !== null && typeof __result === "object" && typeof __result.then === "function") {
    throw new Error("plugin 'execute' returned a Promise; async plugins are not supported by the synchronous sandbox");
  }
  return JSON.stringify(__result);
})();`;
}

/**
 * Execute one plugin INSIDE THE WORKER-POOL JS SANDBOX and return its result
 * serialized as a JSON string (e.g. `"\"hello-world\""` for a string result).
 *
 * Steps: look the plugin up in the (cached) registry, read its source FRESH
 * from disk (so edits take effect without a reload), build the wrapper, and
 * submit it via the SAME `{ kind: "js" }` worker-pool path the `code` tool uses.
 * The timeout defaults to {@link DEFAULT_TIMEOUT_MS} and is clamped to
 * `[500, 60_000]`ms.
 *
 * @throws a readable Error for: unknown plugin, sandbox failure (including the
 *   async-Promise case and timeouts), or a result that fails JSON serialization.
 */
export async function executePlugin(
  name: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<string> {
  const { plugins } = loadPlugins();
  const info = plugins.find((p) => p.name === name);
  if (!info) {
    throw new Error(`unknown plugin: "${name}"`);
  }

  let source: string;
  try {
    source = await fs.readFile(info.filePath, "utf8");
  } catch (err) {
    throw new Error(
      `plugin "${name}": failed to read source from ${info.filePath} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  const clamped = clampTimeout(timeoutMs);
  const wrapper = buildWrapper(source, params);

  const result = await getWorkerPool().run({
    kind: "js",
    source: wrapper,
    timeoutMs: clamped,
  });

  if (!result.success) {
    throw new Error(
      `plugin "${name}" failed in sandbox: ${result.error ?? "unknown error"}`,
    );
  }

  // The vm engine reports the completion value as `=> <json>` (optionally
  // preceded by console.log lines). Recover the trailing serialized value: it
  // is the JSON string our wrapper produced.
  const serialized = extractCompletionValue(result.output);
  if (serialized === null) {
    throw new Error(
      `plugin "${name}" produced no serializable result (result may be undefined or non-JSON)`,
    );
  }
  return serialized;
}

/**
 * Clamp a caller-supplied timeout into `[MIN, MAX]`, defaulting when absent or
 * not a finite number.
 */
function clampTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(timeoutMs)));
}

/**
 * The worker formats a "js" result as the console.log lines followed by a
 * `=> <safeStringify(completionValue)>` line. Our wrapper's completion value is
 * itself a JSON string, so `safeStringify` wraps it once more — meaning the
 * `=>` payload is a JSON-encoded JSON string. Decode that single outer layer to
 * recover exactly what the wrapper's `JSON.stringify(result)` produced.
 *
 * Returns the recovered serialized result, or `null` when the program had no
 * completion value (e.g. `execute` returned `undefined`, which `JSON.stringify`
 * turns into `undefined` and the worker omits the `=>` line).
 */
function extractCompletionValue(output: string): string | null {
  const marker = output.lastIndexOf("=> ");
  if (marker === -1) return null;
  const encoded = output.slice(marker + 3).trim();
  if (encoded.length === 0) return null;
  // `encoded` is safeStringify(<our JSON string>) — i.e. a JSON string literal.
  // Parse one layer to get the wrapper's own JSON.stringify(result) output.
  try {
    const inner: unknown = JSON.parse(encoded);
    if (typeof inner === "string") {
      return inner;
    }
    // Defensive: if for any reason the value wasn't double-encoded, return the
    // raw payload so the caller still sees something serializable.
    return encoded;
  } catch {
    return encoded;
  }
}

/**
 * Render a compact, one-line-per-plugin block for the system prompt:
 *
 *     - slugify: Turn a string into a URL slug
 *     - …
 *
 * Returns `"(no plugins installed)"` when the list is empty.
 */
export function renderPluginList(plugins: PluginInfo[]): string {
  if (plugins.length === 0) {
    return "(no plugins installed)";
  }
  return plugins.map((p) => `- ${p.name}: ${p.description}`).join("\n");
}
