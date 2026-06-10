import fs from "fs-extra";
import path from "node:path";
import { getConfig, resolveWorkspacePath } from "../config/index.js";
import { resolveWorkspaceRelative } from "../util/sandbox.js";

/** Filesystem operations available to the agent. */
export type FilesystemOperation =
  | "read"
  | "write"
  | "list"
  | "delete"
  | "mkdir"
  | "grep"
  | "find"
  | "diff";

// Path-confinement lives in one place now (../util/sandbox.ts). We re-export the
// error type so existing importers (src/tools/index.ts) keep working unchanged.
export { PathTraversalError } from "../util/sandbox.js";

// Directories that are never worth walking for grep/find — large, generated, or
// version-control internals.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

// Files larger than this are skipped by grep (too big to scan line-by-line).
const GREP_MAX_FILE_BYTES = 5 * 1024 * 1024;

// diff refuses files larger than this; line-diffing huge files is not useful.
const DIFF_MAX_FILE_BYTES = 1 * 1024 * 1024;

// Above this LCS-table size (rows * cols) we fall back to the linear-scan diff
// to avoid allocating an enormous matrix.
const LCS_CELL_LIMIT = 4_000_000;

/**
 * All operations are confined to the configured workspace folder. Paths are
 * RELATIVE to the workspace root; any attempt to escape it (via `..`, an
 * absolute path, or a `~` home reference) is rejected.
 */
export class FilesystemTool {
  /** Absolute, validated path for a workspace-relative input. */
  private resolveSafe(relativePath: string): string {
    return resolveWorkspaceRelative(
      relativePath,
      path.resolve(resolveWorkspacePath(getConfig())),
      "filesystem",
    );
  }

  /** Absolute path of the workspace root. */
  private workspaceRoot(): string {
    return path.resolve(resolveWorkspacePath(getConfig()));
  }

  /** Read a file and return its UTF-8 contents. */
  async read(relativePath: string): Promise<string> {
    const abs = this.resolveSafe(relativePath);
    const exists = await fs.pathExists(abs);
    if (!exists) {
      throw new Error(`File not found: "${relativePath}"`);
    }
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      throw new Error(
        `Path is a directory, not a file: "${relativePath}". Use list instead.`,
      );
    }
    return await fs.readFile(abs, "utf8");
  }

  /** Write content to a file, creating parent directories as needed. */
  async write(relativePath: string, content: string): Promise<string> {
    const abs = this.resolveSafe(relativePath);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content ?? "", "utf8");
    const bytes = Buffer.byteLength(content ?? "", "utf8");
    return `Wrote ${bytes} byte(s) to "${relativePath}".`;
  }

  /** List directory entries (or describe a file). Newline-joined. */
  async list(relativePath: string): Promise<string> {
    // Allow listing the workspace root with "." or "".
    const target =
      relativePath === undefined ||
      relativePath === null ||
      relativePath.trim() === ""
        ? "."
        : relativePath;
    const abs = this.resolveSafe(target);
    const exists = await fs.pathExists(abs);
    if (!exists) {
      throw new Error(`Path not found: "${target}"`);
    }
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      return `${path.basename(abs)} (file, ${stat.size} bytes)`;
    }
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) {
      return "(empty directory)";
    }
    const lines = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    return lines.join("\n");
  }

  /** Delete a file or directory (recursively). */
  async delete(relativePath: string): Promise<string> {
    const abs = this.resolveSafe(relativePath);
    const exists = await fs.pathExists(abs);
    if (!exists) {
      throw new Error(`Path not found: "${relativePath}"`);
    }
    await fs.remove(abs);
    return `Deleted "${relativePath}".`;
  }

  /** Create a directory (and any missing parents). */
  async mkdir(relativePath: string): Promise<string> {
    const abs = this.resolveSafe(relativePath);
    await fs.ensureDir(abs);
    return `Created directory "${relativePath}".`;
  }

  /**
   * Search file contents for a regex (or literal-fallback) pattern, returning
   * `relative/path:lineNumber: text` lines (text trimmed to 200 chars).
   *
   * @param pattern        JavaScript regex SOURCE; invalid sources fall back to
   *                       a literal substring search (noted in the header).
   * @param relativePath   file or directory to search; "" → workspace root.
   * @param recursive      descend into subdirectories (directory targets only).
   * @param caseInsensitive add the `i` flag / case-fold the literal match.
   */
  async grep(
    pattern: string,
    relativePath = "",
    recursive = true,
    caseInsensitive = false,
  ): Promise<string> {
    const targetRel =
      relativePath === undefined ||
      relativePath === null ||
      relativePath.trim() === ""
        ? "."
        : relativePath;
    const abs = this.resolveSafe(targetRel);
    const exists = await fs.pathExists(abs);
    if (!exists) {
      throw new Error(`Path not found: "${targetRel}"`);
    }

    // Compile the regex; on failure, search for the pattern as a literal.
    const flags = caseInsensitive ? "i" : "";
    let regex: RegExp;
    let usedLiteralFallback = false;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      usedLiteralFallback = true;
      regex = new RegExp(escapeRegex(pattern), flags);
    }

    const root = this.workspaceRoot();
    const stat = await fs.stat(abs);
    const files: string[] = [];
    if (stat.isDirectory()) {
      await collectFiles(abs, recursive, files);
    } else {
      files.push(abs);
    }

    const MAX_MATCHES = 200;
    const matches: string[] = [];
    let stopped = false;

    for (const file of files) {
      if (stopped) break;
      // Skip files that are too large or look binary.
      if (stat.isDirectory()) {
        const fileStat = await fs.stat(file).catch(() => null);
        if (!fileStat || fileStat.size > GREP_MAX_FILE_BYTES) continue;
      }
      if (await looksBinary(file)) continue;

      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }

      const relDisplay = toPosix(path.relative(root, file));
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        // Reset lastIndex defensively in case a global flag is ever introduced.
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          const text = lines[i].trim().slice(0, 200);
          matches.push(`${relDisplay}:${i + 1}: ${text}`);
          if (matches.length >= MAX_MATCHES) {
            stopped = true;
            break;
          }
        }
      }
    }

    const patternLabel = usedLiteralFallback
      ? `literal "${pattern}"`
      : `/${pattern}/${flags}`;

    if (matches.length === 0) {
      return `No matches for ${patternLabel} in "${targetRel}".`;
    }

    const header = usedLiteralFallback
      ? `(invalid regex — searched ${patternLabel} as a literal substring)\n`
      : "";
    let out = header + matches.join("\n");
    if (stopped) {
      out += "\n... (stopped after 200 matches)";
    }
    return out;
  }

  /**
   * Find FILES whose basename matches a name glob (`*` = any chars, `?` = one
   * char), case-insensitively. Returns workspace-relative paths (forward
   * slashes), sorted, newline-joined.
   *
   * @param nameGlob     basename glob, e.g. `*.ts`, `index.*`, `*config*`.
   * @param relativePath directory to search; "" → workspace root.
   * @param recursive    descend into subdirectories.
   */
  async find(
    nameGlob: string,
    relativePath = "",
    recursive = true,
  ): Promise<string> {
    if (typeof nameGlob !== "string" || nameGlob.trim().length === 0) {
      throw new Error("find: a non-empty name glob is required.");
    }
    const targetRel =
      relativePath === undefined ||
      relativePath === null ||
      relativePath.trim() === ""
        ? "."
        : relativePath;
    const abs = this.resolveSafe(targetRel);
    const exists = await fs.pathExists(abs);
    if (!exists) {
      throw new Error(`Path not found: "${targetRel}"`);
    }
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      throw new Error(
        `Path is a file, not a directory: "${targetRel}". find searches directories.`,
      );
    }

    const matcher = globToRegExp(nameGlob.trim());
    const root = this.workspaceRoot();
    const files: string[] = [];
    await collectFiles(abs, recursive, files);

    const MAX_RESULTS = 500;
    const results: string[] = [];
    for (const file of files) {
      if (matcher.test(path.basename(file))) {
        results.push(toPosix(path.relative(root, file)));
      }
    }

    if (results.length === 0) {
      return `No files matching "${nameGlob}" found in "${targetRel}".`;
    }

    results.sort((a, b) => a.localeCompare(b));
    const stopped = results.length > MAX_RESULTS;
    const shown = stopped ? results.slice(0, MAX_RESULTS) : results;
    let out = shown.join("\n");
    if (stopped) {
      out += "\n... (stopped after 500 matches)";
    }
    return out;
  }

  /**
   * Produce a unified diff (3 lines of context) between two workspace files.
   * Both paths are validated and must be existing files. Files > 1 MB are
   * rejected. Identical files return a short note.
   */
  async diff(pathA: string, pathB: string): Promise<string> {
    const absA = this.resolveSafe(pathA);
    const absB = this.resolveSafe(pathB);

    const [existsA, existsB] = await Promise.all([
      fs.pathExists(absA),
      fs.pathExists(absB),
    ]);
    if (!existsA) {
      throw new Error(`File not found: "${pathA}"`);
    }
    if (!existsB) {
      throw new Error(`File not found: "${pathB}"`);
    }

    const [statA, statB] = await Promise.all([fs.stat(absA), fs.stat(absB)]);
    if (statA.isDirectory()) {
      throw new Error(
        `Path is a directory, not a file: "${pathA}". diff compares files.`,
      );
    }
    if (statB.isDirectory()) {
      throw new Error(
        `Path is a directory, not a file: "${pathB}". diff compares files.`,
      );
    }
    if (statA.size > DIFF_MAX_FILE_BYTES || statB.size > DIFF_MAX_FILE_BYTES) {
      return `diff is limited to files ≤ 1 MB; one of "${pathA}" / "${pathB}" is larger.`;
    }

    const [contentA, contentB] = await Promise.all([
      fs.readFile(absA, "utf8"),
      fs.readFile(absB, "utf8"),
    ]);
    if (contentA === contentB) {
      return "Files are identical.";
    }

    // Split WITHOUT a trailing empty element when the file ends in a newline,
    // so a final blank line doesn't masquerade as a content line.
    const linesA = splitLines(contentA);
    const linesB = splitLines(contentB);

    const header = `--- ${pathA}\n+++ ${pathB}\n`;
    const body = unifiedDiff(linesA, linesB);
    if (body.length === 0) {
      // Contents differed only by a trailing newline; surface that explicitly.
      return "Files are identical.";
    }
    return header + body;
  }
}

// ---- helpers ---------------------------------------------------------------

/** Escape every regex metacharacter so the string matches literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize a path to forward slashes for stable, OS-independent display. */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Drop the trailing empty element produced when text ends in a newline. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Convert a basename glob (`*` = any chars, `?` = one char) into a
 * case-insensitive anchored RegExp. All other regex metacharacters are escaped.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Recursively collect file paths under `dir`, skipping {@link SKIP_DIRS}. When
 * `recursive` is false, only the immediate children are considered. Symlinks
 * are treated by their dirent type and not followed as directories.
 */
async function collectFiles(
  dir: string,
  recursive: boolean,
  out: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (recursive) {
        await collectFiles(full, recursive, out);
      }
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/** Heuristic: a file looks binary if a NUL byte appears in its first 8 KB. */
async function looksBinary(file: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(8 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    // Unreadable files are skipped by treating them as binary.
    return true;
  } finally {
    if (handle) await handle.close();
  }
}

/**
 * Build a unified diff body (no file headers) with 3 lines of context. Chooses
 * an LCS-based diff for normal-sized inputs and a linear prefix/suffix-trim
 * diff when the LCS table would be too large.
 */
function unifiedDiff(a: string[], b: string[]): string {
  const context = 3;
  if (a.length * b.length > LCS_CELL_LIMIT) {
    return linearDiff(a, b, context);
  }
  const ops = lcsDiff(a, b);
  return renderHunks(ops, context);
}

/** A single line-level edit operation. */
type DiffOp =
  | { type: "equal"; line: string }
  | { type: "del"; line: string }
  | { type: "add"; line: string };

/**
 * LCS-based line diff. Builds an (n+1)*(m+1) length table, then backtracks to
 * produce an ordered list of equal / delete / add operations.
 */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..].
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j] });
    j++;
  }
  return ops;
}

/**
 * Fallback diff for very large inputs: trim the common prefix and suffix, then
 * emit the differing middle as a single hunk (all deletions, then all
 * additions). Avoids the quadratic LCS table.
 */
function linearDiff(a: string[], b: string[], context: number): string {
  let start = 0;
  const maxStart = Math.min(a.length, b.length);
  while (start < maxStart && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const delLines = a.slice(start, endA);
  const addLines = b.slice(start, endB);
  if (delLines.length === 0 && addLines.length === 0) {
    return "";
  }

  // Leading/trailing context drawn from the common prefix/suffix.
  const ctxBeforeCount = Math.min(context, start);
  const ctxBefore = a.slice(start - ctxBeforeCount, start);
  const ctxAfterCount = Math.min(context, a.length - endA);
  const ctxAfter = a.slice(endA, endA + ctxAfterCount);

  const aStart = start - ctxBeforeCount + 1;
  const aCount = ctxBeforeCount + delLines.length + ctxAfterCount;
  const bStart = start - ctxBeforeCount + 1;
  const bCount = ctxBeforeCount + addLines.length + ctxAfterCount;

  const lines: string[] = [];
  lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
  for (const line of ctxBefore) lines.push(` ${line}`);
  for (const line of delLines) lines.push(`-${line}`);
  for (const line of addLines) lines.push(`+${line}`);
  for (const line of ctxAfter) lines.push(` ${line}`);
  return lines.join("\n") + "\n";
}

/**
 * Group an op stream into unified-diff hunks with `context` lines of shared
 * context around each run of changes, emitting `@@ -a,b +c,d @@` headers.
 */
function renderHunks(ops: DiffOp[], context: number): string {
  // Indices (into ops) of every changed line.
  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== "equal") changeIdx.push(k);
  }
  if (changeIdx.length === 0) return "";

  // Cluster changes whose surrounding context windows overlap into one hunk.
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // Precompute, for each op index, its 1-based line numbers in A and B.
  const lineNoA: number[] = new Array(ops.length).fill(0);
  const lineNoB: number[] = new Array(ops.length).fill(0);
  let ca = 0;
  let cb = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === "equal") {
      ca++;
      cb++;
      lineNoA[k] = ca;
      lineNoB[k] = cb;
    } else if (op.type === "del") {
      ca++;
      lineNoA[k] = ca;
    } else {
      cb++;
      lineNoB[k] = cb;
    }
  }

  const out: string[] = [];
  for (const range of ranges) {
    let aCount = 0;
    let bCount = 0;
    let aStart = 0;
    let bStart = 0;
    const hunkLines: string[] = [];
    for (let k = range.start; k <= range.end; k++) {
      const op = ops[k];
      if (op.type === "equal") {
        if (aStart === 0) aStart = lineNoA[k];
        if (bStart === 0) bStart = lineNoB[k];
        aCount++;
        bCount++;
        hunkLines.push(` ${op.line}`);
      } else if (op.type === "del") {
        if (aStart === 0) aStart = lineNoA[k];
        aCount++;
        hunkLines.push(`-${op.line}`);
      } else {
        if (bStart === 0) bStart = lineNoB[k];
        bCount++;
        hunkLines.push(`+${op.line}`);
      }
    }
    // When a side contributes no lines its start is 0; unified diff uses the
    // line before the insertion point, which for a 0-count side is the first
    // line number minus one (or 0 when at the very top).
    if (aCount === 0) aStart = computeZeroSideStart(lineNoA, range.start);
    if (bCount === 0) bStart = computeZeroSideStart(lineNoB, range.start);
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    out.push(...hunkLines);
  }
  return out.join("\n") + "\n";
}

/**
 * For a hunk that contributes zero lines on one side, the unified-diff start is
 * the count of that side's lines before the hunk (i.e. the line after which the
 * change applies). Scan backwards for the last numbered line on that side.
 */
function computeZeroSideStart(lineNos: number[], rangeStart: number): number {
  for (let k = rangeStart - 1; k >= 0; k--) {
    if (lineNos[k] > 0) return lineNos[k];
  }
  return 0;
}
