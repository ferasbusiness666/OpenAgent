import fs from "fs-extra";
import path from "node:path";
import { getConfig, resolveWorkspacePath } from "../config/index.js";

/** Filesystem operations available to the agent. */
export type FilesystemOperation = "read" | "write" | "list" | "delete" | "mkdir";

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

/**
 * All operations are confined to the configured workspace folder. Paths are
 * RELATIVE to the workspace root; any attempt to escape it (via `..`, an
 * absolute path, or a `~` home reference) is rejected.
 */
export class FilesystemTool {
  /** Absolute, validated path for a workspace-relative input. */
  private resolveSafe(relativePath: string): string {
    if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
      throw new PathTraversalError("Path must be a non-empty string.");
    }

    const p = relativePath.trim();

    // Reject obvious traversal / absolute / home references up front.
    if (p.includes("..")) {
      throw new PathTraversalError(
        `Path traversal ("..") is not allowed: "${p}"`,
      );
    }
    if (p.startsWith("/") || p.startsWith("\\")) {
      throw new PathTraversalError(
        `Absolute paths are not allowed: "${p}"`,
      );
    }
    if (p.startsWith("~")) {
      throw new PathTraversalError(
        `Home-directory references are not allowed: "${p}"`,
      );
    }
    if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) {
      throw new PathTraversalError(
        `Absolute paths are not allowed: "${p}"`,
      );
    }

    const workspace = path.resolve(resolveWorkspacePath(getConfig()));
    const resolved = path.resolve(workspace, p);

    // Defense in depth: the fully-resolved path must still live inside the
    // workspace root.
    const rel = path.relative(workspace, resolved);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new PathTraversalError(
        `Resolved path escapes the workspace: "${p}"`,
      );
    }

    return resolved;
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
}
