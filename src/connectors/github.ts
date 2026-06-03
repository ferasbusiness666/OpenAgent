import type { Connector } from "./types.js";

// ---------------------------------------------------------------------------
// Internal API response shapes — typed locally to avoid `any`
// ---------------------------------------------------------------------------

interface GitHubUserRepoRaw {
  full_name: string;
  private: boolean;
  description: string | null;
  html_url: string;
}

interface GitHubFileContentsRaw {
  type: string;
  encoding: string;
  content: string;
  name: string;
}

interface GitHubIssueRaw {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export interface RepoInfo {
  fullName: string;
  private: boolean;
  description: string | null;
  url: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  state: string;
  url: string;
}

// ---------------------------------------------------------------------------
// GitHubConnector
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const VALID_ACTIONS = ["listRepos", "readFile", "listIssues"] as const;
type GitHubAction = (typeof VALID_ACTIONS)[number];

/**
 * Read-only GitHub connector that communicates with the GitHub REST API via
 * the global `fetch`. Authentication uses `GITHUB_TOKEN` from the environment,
 * read lazily at call-time so it picks up values set after module load.
 *
 * All methods require GITHUB_TOKEN to be set and throw a descriptive Error
 * when it is absent — the tool layer translates these into ToolResult failures.
 */
export class GitHubConnector implements Connector {
  readonly name = "github";

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getToken(): string {
    const token = process.env["GITHUB_TOKEN"];
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN is not set. Set the GITHUB_TOKEN environment variable to use the GitHub connector.",
      );
    }
    return token;
  }

  private buildHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OpenAgent",
    };
  }

  /**
   * Makes an authenticated GET request to the GitHub API.
   * Throws on non-ok status or timeout.
   */
  private async get(path: string): Promise<unknown> {
    const token = this.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${GITHUB_API_BASE}${path}`, {
        method: "GET",
        headers: this.buildHeaders(token),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`GitHub API request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let bodySnippet = "";
      try {
        const text = await response.text();
        bodySnippet = text.slice(0, 200);
      } catch {
        // ignore body read errors
      }
      throw new Error(
        `GitHub API responded with HTTP ${response.status} for ${path}. Body: ${bodySnippet}`,
      );
    }

    return response.json() as Promise<unknown>;
  }

  // -------------------------------------------------------------------------
  // Connector interface
  // -------------------------------------------------------------------------

  /**
   * Returns false if GITHUB_TOKEN is absent. Otherwise, hits GET /user and
   * returns response.ok. Never throws.
   */
  async authenticate(): Promise<boolean> {
    const token = process.env["GITHUB_TOKEN"];
    if (!token) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let ok = false;
      try {
        const response = await fetch(`${GITHUB_API_BASE}/user`, {
          method: "GET",
          headers: this.buildHeaders(token),
          signal: controller.signal,
        });
        ok = response.ok;
      } finally {
        clearTimeout(timer);
      }
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Dispatches one of the supported actions:
   *   - "listRepos"  → no extra params required
   *   - "readFile"   → requires params.repo (owner/name) and params.path
   *   - "listIssues" → requires params.repo (owner/name)
   *
   * Throws an Error for unknown actions or missing required params.
   */
  async executeAction(
    action: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(
        `Unknown GitHub action "${action}". Valid actions: ${VALID_ACTIONS.join(", ")}.`,
      );
    }

    const validAction = action as GitHubAction;

    switch (validAction) {
      case "listRepos":
        return this.listRepos();

      case "readFile": {
        const repo = params["repo"];
        const filePath = params["path"];
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "readFile" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          throw new Error(
            'GitHub "readFile" requires a non-empty string "path" parameter.',
          );
        }
        return this.readFile(repo, filePath);
      }

      case "listIssues": {
        const repo = params["repo"];
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "listIssues" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        return this.listIssues(repo);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public typed methods
  // -------------------------------------------------------------------------

  /**
   * Lists up to 100 of the authenticated user's repos, sorted by last update.
   */
  async listRepos(): Promise<RepoInfo[]> {
    const data = await this.get("/user/repos?per_page=100&sort=updated");
    if (!Array.isArray(data)) {
      throw new Error("Unexpected response shape from GitHub /user/repos.");
    }
    return (data as GitHubUserRepoRaw[]).map((repo) => ({
      fullName: repo.full_name,
      private: repo.private,
      description: repo.description,
      url: repo.html_url,
    }));
  }

  /**
   * Reads a file from a GitHub repository and returns its decoded text content.
   *
   * @param repo     - Repository in "owner/name" format.
   * @param filePath - Path to the file within the repository.
   * @throws Error if the path resolves to a directory, or if the response is
   *         not a base64-encoded file.
   */
  async readFile(repo: string, filePath: string): Promise<string> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    const encodedPath = filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const data = await this.get(`/repos/${repo}/contents/${encodedPath}`);

    // A directory response is an array.
    if (Array.isArray(data)) {
      throw new Error(
        `"${filePath}" in ${repo} is a directory, not a file. Use listRepos to explore structure.`,
      );
    }

    const file = data as GitHubFileContentsRaw;
    if (file.encoding !== "base64") {
      throw new Error(
        `Unexpected encoding "${file.encoding}" for ${filePath} in ${repo}. Only base64 is supported.`,
      );
    }

    // Node.js Buffer decodes base64 → utf-8.
    const cleaned = file.content.replace(/\s/g, "");
    return Buffer.from(cleaned, "base64").toString("utf-8");
  }

  /**
   * Lists open issues (and PRs, which GitHub includes in /issues) for a repo.
   *
   * @param repo - Repository in "owner/name" format.
   */
  async listIssues(repo: string): Promise<IssueInfo[]> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    const data = await this.get(
      `/repos/${repo}/issues?state=open&per_page=50`,
    );
    if (!Array.isArray(data)) {
      throw new Error(
        `Unexpected response shape from GitHub /repos/${repo}/issues.`,
      );
    }
    return (data as GitHubIssueRaw[]).map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
    }));
  }
}
