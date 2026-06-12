import { spawnSync, execFile } from "node:child_process";
import { getWorkerPool } from "../workers/pool.js";
import { getActiveWorkspace } from "../config/index.js";

/** Package managers installDeps understands, in a stable order. */
export const SUPPORTED_PACKAGE_MANAGERS = ["npm", "pip"] as const;
/** A package manager installDeps understands. */
export type PackageManager = (typeof SUPPORTED_PACKAGE_MANAGERS)[number];

/** Test frameworks runTests understands, in a stable order. */
export const SUPPORTED_TEST_FRAMEWORKS = [
  "pytest",
  "jest",
  "mocha",
  "vitest",
  "go",
] as const;
/** A test framework runTests understands. */
export type TestFramework = (typeof SUPPORTED_TEST_FRAMEWORKS)[number];

/** Default / clamp bounds for the install + test timeouts (milliseconds). */
const INSTALL_TIMEOUT_DEFAULT_MS = 180_000;
const TEST_TIMEOUT_DEFAULT_MS = 120_000;
const TIMEOUT_MIN_MS = 10_000;
const TIMEOUT_MAX_MS = 600_000;

/** Max stdout/stderr captured from a spawned install/test process (8 MB). */
const RUN_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Allowed shape for a package NAME passed to installDeps. These become argv
 * entries to npm/pip, so we permit only the characters real package specifiers
 * use — letters, digits, scope/path separators, version operators — and nothing
 * a shell could interpret (no spaces, quotes, semicolons, backticks, &, |, ...).
 */
const PACKAGE_NAME_RE = /^[A-Za-z0-9@/._^~><=+-]+$/;
/** Shell metacharacters forbidden in a test path argument. */
const PATH_METACHAR_RE = /[;&|<>$`"']/;

/** Outcome of running a child process: combined output + numeric exit code. */
interface RunOutcome {
  /** Combined stdout + stderr, in that order. */
  output: string;
  /** Process exit code; non-numeric spawn failures are mapped to a label. */
  exitCode: number;
  /** Set when the process never produced an exit code (spawn error/timeout). */
  spawnError?: string;
}

/** Structured verdict parsed from a test runner's output. */
export interface TestVerdict {
  /** Tests that passed, or null when no count could be parsed. */
  passed: number | null;
  /** Tests that failed, or null when no count could be parsed. */
  failed: number | null;
  /** True when neither a passed nor a failed count could be extracted. */
  unparsed: boolean;
}

/** Languages the CodeTool can execute. "js" uses the in-thread vm sandbox. */
export type CodeLanguage = "js" | "python" | "node" | "bash" | "powershell";

/** All languages the tool supports, in a stable order. */
export const SUPPORTED_LANGUAGES: readonly CodeLanguage[] = [
  "js",
  "python",
  "node",
  "bash",
  "powershell",
];

/** Availability of a single language's interpreter on the host. */
export interface RuntimeInfo {
  language: CodeLanguage;
  command: string;
  available: boolean;
}

/**
 * CodeTool — a multi-language code-execution tool backed by the {@link WorkerPool}.
 *
 * JavaScript snippets run inside worker threads (isolated-vm when explicitly
 * opted in, Node's `vm` as the default), keeping evaluation off the main thread
 * and bounded by per-job memory + time limits. Python/Node/Bash/PowerShell run
 * through the same pool via a local interpreter ("exec" jobs), inheriting the
 * pool's timeout + force-kill + parallelism, with the working directory set to
 * the agent's workspace. `runMany` fans JS snippets out across the pool in
 * parallel to exercise the multi-worker engine from a single call.
 */
export class CodeTool {
  /**
   * Run a code snippet in the given language. "js" delegates to the in-thread
   * vm sandbox via {@link runJs}; every other language runs through the worker
   * pool as an "exec" job (local interpreter, workspace cwd, pool timeout).
   * @throws if execution fails, so the agent loop can self-correct.
   * @returns the combined stdout+stderr, or "(no output)" when nothing printed.
   */
  async run(
    language: CodeLanguage,
    code: string,
    timeoutMs?: number,
  ): Promise<string> {
    if (language === "js") {
      return this.runJs(code, timeoutMs);
    }
    const r = await getWorkerPool().run({
      kind: "exec",
      language,
      source: code,
      cwd: getActiveWorkspace(),
      timeoutMs,
    });
    if (!r.success) {
      throw new Error(r.error ?? `${language} execution failed`);
    }
    return r.output.trim().length > 0 ? r.output : "(no output)";
  }

  /**
   * Evaluate a single JavaScript snippet in a sandboxed worker.
   * @throws if execution fails (so callers / the agent loop can self-correct).
   * @returns `[engine] output`, or `[engine] (no output)` when nothing printed.
   */
  async runJs(code: string, timeoutMs?: number): Promise<string> {
    const r = await getWorkerPool().run({ kind: "js", source: code, timeoutMs });
    if (!r.success) {
      throw new Error(r.error ?? "code execution failed");
    }
    const engine = r.engine ?? "vm";
    const output = r.output.trim();
    return `[${engine}] ${output.length > 0 ? output : "(no output)"}`;
  }

  /**
   * Evaluate several JavaScript snippets in parallel across the worker pool,
   * returning a numbered summary (one line per snippet). Never throws — each
   * snippet's success/failure is reported inline so a partial batch still
   * produces a useful result.
   */
  async runMany(snippets: string[], timeoutMs?: number): Promise<string> {
    if (snippets.length === 0) return "(no snippets)";

    const pool = getWorkerPool();
    const results = await Promise.all(
      snippets.map((s) => pool.run({ kind: "js", source: s, timeoutMs })),
    );

    const lines = results.map((r, i) => {
      const n = i + 1;
      if (r.success) {
        const first = firstLine(r.output) || "(no output)";
        return `${n}. ✓ [${r.engine ?? "vm"}] ${first}`;
      }
      const first = firstLine(r.error ?? r.output) || "execution failed";
      return `${n}. ✗ [${r.engine ?? "vm"}] ${first}`;
    });

    return lines.join("\n");
  }

  /**
   * Probe each supported language's primary interpreter on this host. "js" is
   * always available (it runs in-process via the vm sandbox; command "vm").
   * Each non-js language is probed with a quick, side-effect-free version check
   * matching the same primary command the worker's interpreter map picks per
   * platform. Synchronous and never throws — each probe is individually guarded.
   */
  detectRuntimes(): RuntimeInfo[] {
    const isWin = process.platform === "win32";
    return SUPPORTED_LANGUAGES.map((language): RuntimeInfo => {
      if (language === "js") {
        return { language, command: "vm", available: true };
      }

      let command: string;
      let probeArgs: string[];
      switch (language) {
        case "python":
          command = isWin ? "python" : "python3";
          probeArgs = ["--version"];
          break;
        case "node":
          command = "node";
          probeArgs = ["--version"];
          break;
        case "bash":
          command = "bash";
          probeArgs = ["--version"];
          break;
        case "powershell":
          command = isWin ? "powershell" : "pwsh";
          probeArgs = ["-NoProfile", "-Command", "$PSVersionTable"];
          break;
      }

      let available = false;
      try {
        const probe = spawnSync(command, probeArgs, {
          stdio: "ignore",
          windowsHide: true,
          timeout: 4000,
        });
        available = probe.status === 0;
      } catch {
        available = false;
      }
      return { language, command, available };
    });
  }

  /**
   * Install dependencies into the workspace via npm or pip.
   *
   * Package names are command-line arguments, so each is validated against a
   * strict allowlist ({@link PACKAGE_NAME_RE}, ≤100 chars) before use and passed
   * as a separate argv entry to `execFile` (no shell), keeping metacharacters
   * out. The install runs with cwd = workspace under a clamped timeout.
   *
   * Never throws for a failing install — a non-zero exit is a real observation,
   * returned as a summary (exit code + the last 30 lines, where the verdict is).
   * Throws only for invalid input (unknown manager, no packages, bad name).
   *
   * @returns a readable summary: the resolved command, exit code, output tail.
   */
  async installDeps(
    packageManager: string,
    packages: string[],
    timeoutMs?: number,
  ): Promise<string> {
    if (
      !(SUPPORTED_PACKAGE_MANAGERS as readonly string[]).includes(
        packageManager,
      )
    ) {
      throw new Error(
        `unsupported package manager: ${packageManager || "(none)"} — use one of: ${SUPPORTED_PACKAGE_MANAGERS.join(", ")}`,
      );
    }
    if (!Array.isArray(packages) || packages.length === 0) {
      throw new Error("installDeps requires at least one package name");
    }
    for (const pkg of packages) {
      if (typeof pkg !== "string" || pkg.length === 0) {
        throw new Error("package names must be non-empty strings");
      }
      if (pkg.length > 100) {
        throw new Error(`package name too long (>100 chars): ${pkg}`);
      }
      if (!PACKAGE_NAME_RE.test(pkg)) {
        throw new Error(`invalid package name: ${pkg}`);
      }
    }

    // npm install <pkgs...>  |  python -m pip install <pkgs...>
    // execFile passes each token as its own argv entry — no shell expansion.
    const { cmd, args } =
      packageManager === "npm"
        ? { cmd: "npm", args: ["install", ...packages] }
        : { cmd: "python", args: ["-m", "pip", "install", ...packages] };

    const timeout = clampTimeout(timeoutMs, INSTALL_TIMEOUT_DEFAULT_MS);
    const outcome = await runProcess(cmd, args, timeout);
    const printable = `${cmd} ${args.join(" ")}`;
    const header = outcome.spawnError
      ? `$ ${printable}\n[${packageManager}] could not run: ${outcome.spawnError} (exit ${outcome.exitCode})`
      : `$ ${printable}\n[${packageManager}] exit ${outcome.exitCode}`;
    return `${header}\n${lastLines(outcome.output, 30)}`.trimEnd();
  }

  /**
   * Run a project's test suite via one of the supported frameworks and return a
   * structured verdict.
   *
   * `testPath`, when given, is validated (no `..`, no absolute path, no shell
   * metacharacters) and appended as ONE argv entry. The runner executes with
   * cwd = workspace under a clamped timeout. The first returned line is always
   * machine-friendly — `TESTS: <p> passed, <f> failed (exit <code>)` — followed
   * by the tail (last 40 lines) of raw output.
   *
   * Never throws for a failing suite (a non-zero exit is a valid result);
   * throws only for invalid input (unknown framework, unsafe path).
   */
  async runTests(
    framework: string,
    testPath?: string,
    timeoutMs?: number,
  ): Promise<string> {
    if (
      !(SUPPORTED_TEST_FRAMEWORKS as readonly string[]).includes(framework)
    ) {
      throw new Error(
        `unsupported test framework: ${framework || "(none)"} — use one of: ${SUPPORTED_TEST_FRAMEWORKS.join(", ")}`,
      );
    }

    // A path is optional. When present it must be a relative, metacharacter-free
    // path so it can be appended as a single safe argument.
    let safePath: string | undefined;
    if (testPath !== undefined && testPath !== null && testPath !== "") {
      if (typeof testPath !== "string") {
        throw new Error("testPath must be a string");
      }
      if (testPath.includes("..")) {
        throw new Error(`invalid testPath (parent traversal): ${testPath}`);
      }
      if (/^([A-Za-z]:[\\/]|[\\/]|~)/.test(testPath)) {
        throw new Error(`invalid testPath (absolute path): ${testPath}`);
      }
      if (PATH_METACHAR_RE.test(testPath)) {
        throw new Error(`invalid testPath (shell metacharacter): ${testPath}`);
      }
      safePath = testPath;
    }

    // Build the per-framework command + args. The optional path is inserted as a
    // single argv entry; `go` uses "./..." when no explicit path is given.
    const fw = framework as TestFramework;
    const { cmd, args } = buildTestCommand(fw, safePath);

    const timeout = clampTimeout(timeoutMs, TEST_TIMEOUT_DEFAULT_MS);
    const outcome = await runProcess(cmd, args, timeout);

    const verdict = parseTestOutput(fw, outcome.output, outcome.exitCode);
    const passedStr = verdict.passed === null ? "?" : String(verdict.passed);
    const failedStr = verdict.failed === null ? "?" : String(verdict.failed);
    const summary = `TESTS: ${passedStr} passed, ${failedStr} failed (exit ${outcome.exitCode})`;
    const note = verdict.unparsed
      ? "\n(could not parse counts — relying on exit code)"
      : "";
    const spawnNote = outcome.spawnError
      ? `\n[runner] could not run: ${outcome.spawnError}`
      : "";
    const printable = `$ ${cmd} ${args.join(" ")}`;
    return `${summary}${note}${spawnNote}\n${printable}\n${lastLines(outcome.output, 40)}`.trimEnd();
  }
}

/**
 * Build the executable + argv for a test framework. The optional, already-
 * validated `testPath` is inserted as one argv entry; `go` defaults to "./..."
 * (its all-packages selector) when no path is supplied.
 */
function buildTestCommand(
  framework: TestFramework,
  testPath?: string,
): { cmd: string; args: string[] } {
  const p = testPath !== undefined ? [testPath] : [];
  switch (framework) {
    case "pytest":
      // python -m pytest <path?> -v --no-header
      return { cmd: "python", args: ["-m", "pytest", ...p, "-v", "--no-header"] };
    case "jest":
      // npx jest <path?> --colors=false
      return { cmd: "npx", args: ["jest", ...p, "--colors=false"] };
    case "mocha":
      // npx mocha <path?> --reporter spec
      return { cmd: "npx", args: ["mocha", ...p, "--reporter", "spec"] };
    case "vitest":
      // npx vitest run <path?>
      return { cmd: "npx", args: ["vitest", "run", ...p] };
    case "go":
      // go test <path or ./...> -v
      return { cmd: "go", args: ["test", testPath ?? "./...", "-v"] };
  }
}

/**
 * Parse a test runner's combined output into a {@link TestVerdict}. Regexes are
 * case-insensitive and tolerant: when nothing matches, `passed`/`failed` are
 * left null and `unparsed` is true so callers fall back to the exit code.
 *
 * Exported so the test-writing agent can feed it canned outputs per framework.
 *
 * @param exitCode the runner's exit code, used as a tie-breaker so a fully
 * green run with no parseable "0 failed" still reports 0 failures.
 */
export function parseTestOutput(
  framework: TestFramework,
  output: string,
  exitCode: number,
): TestVerdict {
  let passed: number | null = null;
  let failed: number | null = null;

  switch (framework) {
    case "pytest": {
      passed = firstInt(output.match(/(\d+) passed/i));
      // pytest reports failures and (separately) collection errors.
      const failMatch = firstInt(output.match(/(\d+) failed/i));
      const errMatch = firstInt(output.match(/(\d+) error/i));
      if (failMatch !== null || errMatch !== null) {
        failed = (failMatch ?? 0) + (errMatch ?? 0);
      }
      break;
    }
    case "jest":
    case "vitest": {
      // Jest/Vitest summary line: "Tests: 1 failed, 2 skipped, 7 passed, 10 total"
      const m = output.match(
        /Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed, (\d+) total/i,
      );
      if (m) {
        failed = m[1] !== undefined ? Number(m[1]) : 0;
        passed = Number(m[3]);
      } else {
        // Vitest's compact form: "Tests  6 passed | 1 failed (7)". Prefer the
        // line that starts with "Tests" so the separate "Test Files N passed"
        // line above it doesn't capture the wrong count; fall back to the whole
        // output when no such line exists.
        const testsLine =
          output.split(/\r?\n/).find((l) => /^\s*tests\b/i.test(l)) ?? output;
        passed = firstInt(testsLine.match(/(\d+) passed/i));
        failed = firstInt(testsLine.match(/(\d+) failed/i));
      }
      break;
    }
    case "mocha": {
      passed = firstInt(output.match(/(\d+) passing/i));
      failed = firstInt(output.match(/(\d+) failing/i));
      break;
    }
    case "go": {
      const passCount = countMatches(output, /^--- PASS/gim);
      const failCount = countMatches(output, /^--- FAIL/gim);
      if (passCount > 0) passed = passCount;
      if (failCount > 0) {
        failed = failCount;
      } else if (/^FAIL\b/im.test(output)) {
        // A package-level FAIL with no per-test "--- FAIL" lines (e.g. a build
        // or compile failure) still means the suite failed.
        failed = failed ?? 1;
      } else if (/^ok\b/im.test(output)) {
        // Package compiled and the test binary reported ok → no failures.
        failed = failed ?? 0;
        passed = passed ?? 0;
      }
      break;
    }
  }

  // A clean exit with no parseable failure count means zero failures.
  if (failed === null && exitCode === 0) {
    failed = 0;
  }

  const unparsed = passed === null && failed === null;
  return { passed, failed, unparsed };
}

/**
 * Run an executable with the given args, combining stdout + stderr and resolving
 * the numeric exit code. Mirrors the worker's exec machinery (execFile + cwd =
 * workspace + timeout + SIGKILL force-kill) but surfaces the real exit code,
 * which the install/test summaries need. Never rejects: a spawn failure or
 * timeout resolves with a descriptive `spawnError` and a synthetic exit code.
 */
function runProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: getActiveWorkspace(),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: RUN_MAX_BUFFER,
        // npx / npm are .cmd shims on Windows; shell:true lets them resolve.
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`;
        if (!error) {
          resolve({ output, exitCode: 0 });
          return;
        }
        // `error.code` is the numeric exit code when the process ran and failed;
        // at runtime it can be a string (e.g. "ENOENT", "ETIMEDOUT") on a spawn
        // failure. Read it as unknown so both shapes are handled without `any`.
        const code: unknown = (error as { code?: unknown }).code;
        if (typeof code === "number") {
          resolve({ output, exitCode: code });
          return;
        }
        const label = typeof code === "string" && code.length > 0 ? code : "spawn failed";
        resolve({
          output: output.length > 0 ? output : error.message,
          exitCode: 1,
          spawnError: label,
        });
      },
    );
  });
}

/** Clamp `value` (or `fallback` when undefined) to [TIMEOUT_MIN, TIMEOUT_MAX]. */
function clampTimeout(value: number | undefined, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(n)));
}

/** Last `n` non-trailing-empty lines of `text`, joined back with newlines. */
function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** First capture group of a regex match parsed as an int, or null. */
function firstInt(match: RegExpMatchArray | null): number | null {
  if (!match || match[1] === undefined) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Count how many times a global regex matches in `text`. */
function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** First non-empty line of a string, trimmed. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return text.trim();
}
