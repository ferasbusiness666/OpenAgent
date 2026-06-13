/**
 * Standalone, dependency-free unified-diff producer for the UI.
 *
 * This mirrors the LCS line-diff algorithm used internally by
 * src/tools/filesystem.ts, but is intentionally NOT imported from there: the UI
 * must never depend on a tool. Pure functions only — no I/O, no side effects.
 */

/** Lines of context emitted around each change, matching the tool's diff. */
const CONTEXT = 3;

/**
 * Per-side line cap. Beyond this, building the full LCS table is wasteful for a
 * trust-building UI, so we emit a single truncated-notice hunk instead. Bounds
 * cost at roughly CAP*CAP table cells (~4M) in the worst case.
 */
const LINE_CAP = 2000;

/** A single line-level edit operation. */
type DiffOp =
  | { type: "equal"; line: string }
  | { type: "del"; line: string }
  | { type: "add"; line: string };

/**
 * Produce a unified diff (LCS-based, 3 lines of context) between two texts.
 * `label` names the file in the ---/+++ headers. Identical inputs → "". Caps
 * work at ~2000 lines per side (beyond that, emit a single truncated-notice
 * hunk) to bound cost.
 */
export function computeUnifiedDiff(oldText: string, newText: string, label?: string): string {
  if (oldText === newText) return "";

  const a = splitLines(oldText);
  const b = splitLines(newText);

  const name = label && label.length > 0 ? label : "file";
  const header = `--- a/${name}\n+++ b/${name}\n`;

  // Guard against pathological inputs: a huge file shouldn't build a giant
  // table or flood the diff. Surface a concise notice hunk instead.
  if (a.length > LINE_CAP || b.length > LINE_CAP) {
    const body =
      `@@ -1,${a.length} +1,${b.length} @@\n` +
      `- (file too large to diff: ${a.length} → ${b.length} lines; showing summary only)\n`;
    return header + body;
  }

  const body = renderHunks(lcsDiff(a, b), CONTEXT);
  // Defensive: if the only difference was a trailing newline, splitLines may
  // collapse it — but oldText !== newText guaranteed a real change, so body is
  // non-empty in practice. Return just the header + body when body exists.
  if (body.length === 0) return "";
  return header + body;
}

/**
 * Split text into lines without inventing a trailing empty line for a final
 * newline. "a\nb\n" → ["a", "b"]; "a\nb" → ["a", "b"]; "" → [].
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * LCS-based line diff. Builds an (n+1)*(m+1) length table, then walks it
 * forward to produce an ordered list of equal / delete / add operations.
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
  const lineNoA: number[] = new Array<number>(ops.length).fill(0);
  const lineNoB: number[] = new Array<number>(ops.length).fill(0);
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
    // line before the insertion point, which for a 0-count side is the last
    // numbered line on that side before the hunk (or 0 at the very top).
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
