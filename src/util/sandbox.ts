/**
 * sandbox.ts — the SINGLE workspace path-confinement implementation (IMP-32).
 *
 * Path-traversal checks used to be duplicated (with slightly different rules)
 * in filesystem.ts, shell.ts, and serve.ts — a security inconsistency waiting
 * to happen. Every tool that touches the filesystem now validates through the
 * two functions below, so the rules can never diverge again.
 *
 * Rules enforced by {@link resolveWorkspaceRelative}:
 *   • the path must be a non-empty string
 *   • no `..` anywhere (parent-directory traversal)
 *   • no leading `/`, `\`, or `~` (absolute / home references)
 *   • no Windows drive-letter absolute paths (C:\ or C:/)
 *   • after resolving against the workspace root, the result must still live
 *     inside the workspace (defense in depth against normalization tricks)
 */

import path from "node:path";

/**
 * Thrown when a requested path would escape the workspace sandbox.
 * Callers (e.g. the ToolRegistry) translate this into a tool error result.
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

/** True when `target` is exactly `base` or a path nested inside it. */
export function isInsidePath(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Validate a workspace-relative path and return its absolute location inside
 * `workspaceAbs`. Throws {@link PathTraversalError} on any escape attempt.
 *
 * @param relativePath the untrusted, workspace-relative path
 * @param workspaceAbs absolute path of the workspace root
 * @param label        tool name used in error messages (e.g. "serve")
 */
export function resolveWorkspaceRelative(
  relativePath: string,
  workspaceAbs: string,
  label = "filesystem",
): string {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new PathTraversalError(`${label}: path must be a non-empty string.`);
  }

  const p = relativePath.trim();

  if (p.includes("..")) {
    throw new PathTraversalError(
      `${label}: path traversal ("..") is not allowed: "${p}"`,
    );
  }
  if (p.startsWith("/") || p.startsWith("\\")) {
    throw new PathTraversalError(`${label}: absolute paths are not allowed: "${p}"`);
  }
  if (p.startsWith("~")) {
    throw new PathTraversalError(
      `${label}: home-directory references are not allowed: "${p}"`,
    );
  }
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) {
    throw new PathTraversalError(`${label}: absolute paths are not allowed: "${p}"`);
  }

  const workspace = path.resolve(workspaceAbs);
  const resolved = path.resolve(workspace, p);

  // Defense in depth: the fully-resolved path must still live inside the
  // workspace root even after normalization.
  if (!isInsidePath(workspace, resolved)) {
    throw new PathTraversalError(
      `${label}: resolved path escapes the workspace: "${p}"`,
    );
  }

  return resolved;
}
