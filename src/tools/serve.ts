/**
 * serve.ts — Static-file HTTP server tool for Open Agent.
 *
 * Lets the agent host a workspace subdirectory over HTTP on localhost and
 * return the URL — the local equivalent of a "preview / ship" action.
 *
 * Design decisions
 * ────────────────
 * • No external runtime deps: uses only `node:http`, `node:fs`, `node:path`,
 *   and `node:url` (plus `fs-extra` for `pathExists` / `stat`, already a
 *   project dep).
 * • Server isolation: every `serve()` call creates an independent `http.Server`
 *   tracked in a module-level registry keyed by the URL that was returned.
 * • `.unref()` is called on every server so open servers do not prevent the
 *   Node process from exiting naturally when the rest of the app has finished.
 *   The entry point still calls `closeAllServers()` for an orderly shutdown.
 * • Path traversal is blocked at two layers:
 *     1. The `dir` argument itself is validated (no `..`, no absolute paths,
 *        no `~`) — mirrors FilesystemTool.resolveSafe().
 *     2. Every incoming request path is decoded, resolved, and checked that it
 *        still sits inside the served directory before the file is opened.
 *        Out-of-bounds requests receive HTTP 403.
 * • Port selection: use `preferredPort` when supplied and free, otherwise 0
 *   (OS chooses an available ephemeral port).  The actual bound port is read
 *   from `server.address()` after `listen` resolves.
 */

import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import fs from "fs-extra";
import { getActiveWorkspace } from "../config/index.js";

// ── Content-type table ──────────────────────────────────────────────────────

/** Map of lowercase file extension → MIME type string. */
const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/** Return the MIME type for `filePath`, defaulting to `application/octet-stream`. */
function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

// ── Module-level server registry ────────────────────────────────────────────

/** Entry stored in the registry for each running server. */
interface ServerEntry {
  server: http.Server;
  /** Absolute path of the directory being served. */
  servedDir: string;
}

/**
 * Registry of every server started by this module, keyed by the URL string
 * returned to the caller (e.g. "http://localhost:52341").
 */
const registry = new Map<string, ServerEntry>();

// ── Path-validation helpers ─────────────────────────────────────────────────

/**
 * Validate a workspace-relative `dir` argument, mirroring the checks in
 * `FilesystemTool.resolveSafe()`.  Returns the absolute, confirmed-directory
 * path, or throws a descriptive `Error`.
 *
 * Rules:
 *  • Must be a non-empty string.
 *  • Must NOT contain `..`.
 *  • Must NOT start with `/`, `\`, or `~`.
 *  • Must NOT be a Windows drive-letter absolute path (e.g. `C:\...`).
 *  • After resolving against the workspace root the result must remain inside
 *    the workspace (defense-in-depth against clever Unicode tricks).
 *  • The resolved path must exist and be a directory.
 */
function resolveServedDir(dir: string): string {
  const p = dir.trim();

  if (p.length === 0) {
    throw new Error("serve: dir must be a non-empty string.");
  }
  if (p.includes("..")) {
    throw new Error(
      `serve: path traversal ("..") is not allowed in dir: "${p}"`,
    );
  }
  if (p.startsWith("/") || p.startsWith("\\")) {
    throw new Error(`serve: absolute paths are not allowed in dir: "${p}"`);
  }
  if (p.startsWith("~")) {
    throw new Error(
      `serve: home-directory references are not allowed in dir: "${p}"`,
    );
  }
  // Windows drive-letter absolute paths (C:\ or C:/).
  if (/^[A-Za-z]:[\\/]/.test(p) || path.isAbsolute(p)) {
    throw new Error(`serve: absolute paths are not allowed in dir: "${p}"`);
  }

  const workspace = path.resolve(getActiveWorkspace());
  const resolved = path.resolve(workspace, p);

  // Defense-in-depth: ensure the resolved path is still inside the workspace.
  const rel = path.relative(workspace, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(
      `serve: resolved dir escapes the workspace root: "${p}"`,
    );
  }

  return resolved;
}

/**
 * Return true when `target` is exactly `base` or is nested inside it.
 * Works on both POSIX and Windows paths.
 */
function isInsideDir(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ── Port-availability probe ──────────────────────────────────────────────────

/**
 * Probe whether a TCP port on 127.0.0.1 is available by attempting a brief
 * listen.  Resolves `true` if the port is free, `false` if it is in use.
 *
 * We create a temporary server just to check; if it binds we immediately close
 * it before returning.  This has a small TOCTOU window but is acceptable for
 * a development-preview tool.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

// ── Request handler factory ──────────────────────────────────────────────────

/**
 * Build an `http.RequestListener` that serves static files from `servedDir`.
 *
 * Request-path handling:
 *  1. Strip the query string, decode percent-encoding.
 *  2. Default "/" to "index.html".
 *  3. Resolve against `servedDir` and confirm the result is still inside it;
 *     respond with 403 if not.
 *  4. If the resolved path is a directory, try appending "index.html".
 *  5. If the file doesn't exist → 404; otherwise stream it with the correct
 *     Content-Type and 200.
 */
function makeHandler(servedDir: string): http.RequestListener {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void (async () => {
      try {
        // Only GET and HEAD are meaningful for a static server.
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" });
          res.end("Method Not Allowed");
          return;
        }

        // Parse the request URL; fall back to "/" on any weirdness.
        let rawPath = "/";
        try {
          // Prefix with a dummy base so URL() can parse a relative path.
          rawPath = new URL(req.url ?? "/", "http://localhost").pathname;
        } catch {
          rawPath = "/";
        }

        // Decode percent-encoding and normalise separators.
        let decoded: string;
        try {
          decoded = decodeURIComponent(rawPath);
        } catch {
          // Malformed encoding → serve nothing.
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Bad Request");
          return;
        }

        // Default root to index.html.
        if (decoded === "/" || decoded === "") {
          decoded = "/index.html";
        }

        // Strip any leading slash so path.resolve works correctly.
        const relative = decoded.replace(/^\/+/, "");

        // Resolve against the served directory.
        const absolute = path.resolve(servedDir, relative);

        // ── Traversal guard ──────────────────────────────────────────────
        // After resolving symlinks (or direct paths), the result must sit
        // inside `servedDir`.  We check on the raw resolved path; following
        // symlinks would require `fs.realpath` (async), but for a dev preview
        // the raw check is sufficient and keeps the handler synchronous up to
        // the stat call.
        if (!isInsideDir(servedDir, absolute)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }

        // Check existence.
        const exists = await fs.pathExists(absolute);
        if (!exists) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        const stat = await fs.stat(absolute);

        // If it's a directory, try serving index.html inside it.
        if (stat.isDirectory()) {
          const indexPath = path.join(absolute, "index.html");
          const indexExists = await fs.pathExists(indexPath);
          if (!indexExists) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }
          const indexStat = await fs.stat(indexPath);
          const contentType = mimeFor(indexPath);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": indexStat.size,
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          fs.createReadStream(indexPath).pipe(res);
          return;
        }

        // Regular file.
        const contentType = mimeFor(absolute);
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": stat.size,
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(absolute).pipe(res);
      } catch (err: unknown) {
        // Catch-all so an unexpected error never leaves the request hanging.
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        const msg = err instanceof Error ? err.message : String(err);
        res.end(`Internal Server Error: ${msg}`);
      }
    })();
  };
}

// ── ServeTool ────────────────────────────────────────────────────────────────

/**
 * Serves a workspace directory over HTTP on localhost.
 *
 * All methods are safe to call concurrently — each `serve()` call creates an
 * independent server on its own port.
 *
 * Usage by the agent:
 * ```ts
 * const tool = new ServeTool();
 * const message = await tool.serve("my-site");
 * // → "Serving /abs/path/to/workspace/my-site at http://localhost:52341"
 * ```
 */
export class ServeTool {
  /**
   * Start an HTTP server that statically serves `dir` (workspace-relative) and
   * return a human-readable result string that includes the URL.
   *
   * @param dir           Workspace-relative subdirectory to serve (default: the
   *                      workspace root).  Must not contain `..`, start with `/`,
   *                      `\`, or `~`.
   * @param preferredPort TCP port to try first.  If omitted or if the port is
   *                      already in use the OS will pick a free ephemeral port.
   * @returns             A message of the form
   *                      `"Serving <absDir> at http://localhost:<port>"`.
   * @throws              When `dir` fails path validation or does not exist as a
   *                      directory on disk.
   */
  async serve(dir?: string, preferredPort?: number): Promise<string> {
    // ── Resolve the directory ───────────────────────────────────────────────
    let absDir: string;

    if (dir === undefined || dir.trim().length === 0) {
      // Default: serve the workspace root.
      absDir = path.resolve(getActiveWorkspace());
    } else {
      absDir = resolveServedDir(dir);
    }

    // Confirm the path exists and is a directory.
    const exists = await fs.pathExists(absDir);
    if (!exists) {
      throw new Error(
        `serve: directory does not exist: "${absDir}"`,
      );
    }
    const stat = await fs.stat(absDir);
    if (!stat.isDirectory()) {
      throw new Error(
        `serve: path exists but is not a directory: "${absDir}"`,
      );
    }

    // ── Determine the port ──────────────────────────────────────────────────
    // Use preferredPort if it is a valid number and the port is free; otherwise
    // fall back to 0 so the OS picks a free ephemeral port.
    let listenPort = 0;
    if (
      typeof preferredPort === "number" &&
      Number.isInteger(preferredPort) &&
      preferredPort > 0 &&
      preferredPort <= 65535
    ) {
      const free = await isPortFree(preferredPort);
      listenPort = free ? preferredPort : 0;
    }

    // ── Create and start the server ─────────────────────────────────────────
    const server = http.createServer(makeHandler(absDir));

    // Do not keep the process alive solely because of this server.
    server.unref();

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          reject(new Error("serve: unexpected address format from server.address()"));
          return;
        }
        resolve(addr.port);
      });
    });

    const url = `http://localhost:${port}`;

    // Register the server.
    registry.set(url, { server, servedDir: absDir });

    return `Serving ${absDir} at ${url}`;
  }

  /**
   * Return the URLs of all currently running servers started by this module.
   * Servers are listed in the order they were started.
   */
  listServers(): string[] {
    return Array.from(registry.keys());
  }

  /**
   * Close the server registered under `url` and remove it from the registry.
   *
   * @param url  The URL string returned by `serve()` (e.g. `"http://localhost:52341"`).
   * @returns    `true` when the server was found and closed; `false` when no
   *             server is registered under that URL.
   */
  async stop(url: string): Promise<boolean> {
    const entry = registry.get(url);
    if (entry === undefined) {
      return false;
    }

    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
    });

    registry.delete(url);
    return true;
  }
}

// ── Module-level cleanup helper ──────────────────────────────────────────────

/**
 * Close every server that is currently running and clear the registry.
 *
 * Designed to be called from the entry point's shutdown / cleanup handler.
 * Never throws — failures are swallowed so one misbehaving server cannot
 * prevent the others from closing.
 *
 * ```ts
 * // In src/index.ts teardown:
 * import { closeAllServers } from "./tools/serve.js";
 * process.on("exit", () => void closeAllServers());
 * ```
 */
export async function closeAllServers(): Promise<void> {
  const entries = Array.from(registry.entries());
  // Clear the registry immediately so concurrent calls don't double-close.
  registry.clear();

  await Promise.allSettled(
    entries.map(
      ([, entry]) =>
        new Promise<void>((resolve) => {
          try {
            entry.server.close(() => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
}
