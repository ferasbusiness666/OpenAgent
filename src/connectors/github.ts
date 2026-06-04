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

interface GitHubIssueCommentRaw {
  id: number;
  html_url: string;
}

interface GitHubPullRaw {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  body: string | null;
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

export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  head: string;
  base: string;
  body?: string;
}

export interface IssueCommentInfo {
  id: number;
  url: string;
}

// ---------------------------------------------------------------------------
// GitHubConnector
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const VALID_ACTIONS = [
  "listRepos",
  "readFile",
  "listIssues",
  "createIssue",
  "commentIssue",
  "closeIssue",
  "listPullRequests",
  "getPullRequest",
  "createPullRequest",
] as const;
type GitHubAction = (typeof VALID_ACTIONS)[number];

/**
 * Coerces a value to a finite integer, accepting either a number or a numeric
 * string (e.g. issue/PR numbers arriving as JSON strings from the tool layer).
 * Returns `undefined` when the value cannot be interpreted as a valid number.
 */
function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

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

  /**
   * Makes an authenticated mutating request (POST/PATCH) to the GitHub API,
   * sending a JSON body. Mirrors `get()` for headers, timeout/abort handling,
   * and error reporting. GitHub returns 201 for creates and 200 for updates —
   * any `response.ok` is treated as success.
   *
   * @param method - "POST" (create) or "PATCH" (update).
   * @param path   - API path beginning with "/".
   * @param body   - Request payload, serialized via JSON.stringify.
   * @throws Error on non-ok status, timeout, or network failure.
   */
  private async request(
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
  ): Promise<unknown> {
    const token = this.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${GITHUB_API_BASE}${path}`, {
        method,
        headers: {
          ...this.buildHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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

      case "createIssue": {
        const repo = params["repo"];
        const title = params["title"];
        const body = params["body"];
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "createIssue" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        if (typeof title !== "string" || title.trim().length === 0) {
          throw new Error(
            'GitHub "createIssue" requires a non-empty string "title" parameter.',
          );
        }
        if (body !== undefined && typeof body !== "string") {
          throw new Error(
            'GitHub "createIssue" requires "body" to be a string when provided.',
          );
        }
        return this.createIssue(repo, title, body);
      }

      case "commentIssue": {
        const repo = params["repo"];
        const issueNumber = coerceNumber(params["number"]);
        const body = params["body"];
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "commentIssue" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        if (issueNumber === undefined) {
          throw new Error(
            'GitHub "commentIssue" requires a numeric "number" parameter (the issue number).',
          );
        }
        if (typeof body !== "string" || body.trim().length === 0) {
          throw new Error(
            'GitHub "commentIssue" requires a non-empty string "body" parameter.',
          );
        }
        return this.commentIssue(repo, issueNumber, body);
      }

      case "closeIssue": {
        const repo = params["repo"];
        const issueNumber = coerceNumber(params["number"]);
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "closeIssue" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        if (issueNumber === undefined) {
          throw new Error(
            'GitHub "closeIssue" requires a numeric "number" parameter (the issue number).',
          );
        }
        return this.closeIssue(repo, issueNumber);
      }

      case "listPullRequests": {
        const repo = params["repo"];
        const state = params["state"];
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "listPullRequests" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        if (
          state !== undefined &&
          state !== "open" &&
          state !== "closed" &&
          state !== "all"
        ) {
          throw new Error(
            'GitHub "listPullRequests" "state" must be one of "open", "closed", or "all".',
          );
        }
        return this.listPullRequests(repo, state);
      }

      case "getPullRequest": {
        const repo = params["repo"];
        const prNumber = coerceNumber(params["number"]);
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "getPullRequest" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        if (prNumber === undefined) {
          throw new Error(
            'GitHub "getPullRequest" requires a numeric "number" parameter (the pull request number).',
          );
        }
        return this.getPullRequest(repo, prNumber);
      }

      case "createPullRequest": {
        const repo = params["repo"];
        const title = params["title"];
        const head = params["head"];
        const base = params["base"];
        const body = params["body"];
        if (typeof repo !== "string" || repo.trim().length === 0) {
          throw new Error(
            'GitHub "createPullRequest" requires a non-empty string "repo" parameter (format: owner/name).',
          );
        }
        if (typeof title !== "string" || title.trim().length === 0) {
          throw new Error(
            'GitHub "createPullRequest" requires a non-empty string "title" parameter.',
          );
        }
        if (typeof head !== "string" || head.trim().length === 0) {
          throw new Error(
            'GitHub "createPullRequest" requires a non-empty string "head" parameter (the source branch).',
          );
        }
        if (typeof base !== "string" || base.trim().length === 0) {
          throw new Error(
            'GitHub "createPullRequest" requires a non-empty string "base" parameter (the target branch).',
          );
        }
        if (body !== undefined && typeof body !== "string") {
          throw new Error(
            'GitHub "createPullRequest" requires "body" to be a string when provided.',
          );
        }
        const prParams: {
          title: string;
          head: string;
          base: string;
          body?: string;
        } = { title, head, base };
        if (typeof body === "string") {
          prParams.body = body;
        }
        return this.createPullRequest(repo, prParams);
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

  /**
   * Creates a new issue in a repository.
   *
   * @param repo  - Repository in "owner/name" format.
   * @param title - Issue title (required, non-empty).
   * @param body  - Optional Markdown body.
   * @returns The created issue as an {@link IssueInfo}.
   */
  async createIssue(
    repo: string,
    title: string,
    body?: string,
  ): Promise<IssueInfo> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    if (title.trim().length === 0) {
      throw new Error("createIssue requires a non-empty title.");
    }
    const payload: { title: string; body?: string } = { title };
    if (body !== undefined) {
      payload.body = body;
    }
    const data = await this.request("POST", `/repos/${repo}/issues`, payload);
    const issue = data as GitHubIssueRaw;
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
    };
  }

  /**
   * Adds a comment to an existing issue (or pull request, which GitHub treats
   * as an issue for commenting purposes).
   *
   * @param repo        - Repository in "owner/name" format.
   * @param issueNumber - The issue number to comment on.
   * @param body        - Comment body (required, non-empty).
   * @returns The created comment id and html_url as an {@link IssueCommentInfo}.
   */
  async commentIssue(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<IssueCommentInfo> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    if (body.trim().length === 0) {
      throw new Error("commentIssue requires a non-empty body.");
    }
    const data = await this.request(
      "POST",
      `/repos/${repo}/issues/${issueNumber}/comments`,
      { body },
    );
    const comment = data as GitHubIssueCommentRaw;
    return { id: comment.id, url: comment.html_url };
  }

  /**
   * Closes an existing issue by setting its state to "closed".
   *
   * @param repo        - Repository in "owner/name" format.
   * @param issueNumber - The issue number to close.
   * @returns The updated issue as an {@link IssueInfo}.
   */
  async closeIssue(repo: string, issueNumber: number): Promise<IssueInfo> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    const data = await this.request(
      "PATCH",
      `/repos/${repo}/issues/${issueNumber}`,
      { state: "closed" },
    );
    const issue = data as GitHubIssueRaw;
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
    };
  }

  /**
   * Lists pull requests for a repository.
   *
   * @param repo  - Repository in "owner/name" format.
   * @param state - Filter by state ("open" | "closed" | "all"). Defaults to "open".
   * @returns Up to 50 pull requests as {@link PullRequestInfo}[].
   */
  async listPullRequests(
    repo: string,
    state?: "open" | "closed" | "all",
  ): Promise<PullRequestInfo[]> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    const data = await this.get(
      `/repos/${repo}/pulls?state=${state ?? "open"}&per_page=50`,
    );
    if (!Array.isArray(data)) {
      throw new Error(
        `Unexpected response shape from GitHub /repos/${repo}/pulls.`,
      );
    }
    return (data as GitHubPullRaw[]).map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.html_url,
      head: pr.head.ref,
      base: pr.base.ref,
    }));
  }

  /**
   * Fetches a single pull request, including its body.
   *
   * @param repo     - Repository in "owner/name" format.
   * @param prNumber - The pull request number.
   * @returns The pull request as a {@link PullRequestInfo}.
   */
  async getPullRequest(
    repo: string,
    prNumber: number,
  ): Promise<PullRequestInfo> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    const data = await this.get(`/repos/${repo}/pulls/${prNumber}`);
    return toPullRequestInfo(data as GitHubPullRaw);
  }

  /**
   * Creates a new pull request.
   *
   * @param repo   - Repository in "owner/name" format.
   * @param params - title, head (source branch), base (target branch), and an
   *                 optional Markdown body.
   * @returns The created pull request as a {@link PullRequestInfo}.
   */
  async createPullRequest(
    repo: string,
    params: { title: string; head: string; base: string; body?: string },
  ): Promise<PullRequestInfo> {
    if (!repo.includes("/")) {
      throw new Error(
        `Invalid repo format "${repo}". Expected "owner/name" (e.g. "octocat/Hello-World").`,
      );
    }
    if (params.title.trim().length === 0) {
      throw new Error("createPullRequest requires a non-empty title.");
    }
    if (params.head.trim().length === 0) {
      throw new Error("createPullRequest requires a non-empty head branch.");
    }
    if (params.base.trim().length === 0) {
      throw new Error("createPullRequest requires a non-empty base branch.");
    }
    const payload: {
      title: string;
      head: string;
      base: string;
      body?: string;
    } = {
      title: params.title,
      head: params.head,
      base: params.base,
    };
    if (params.body !== undefined) {
      payload.body = params.body;
    }
    const data = await this.request("POST", `/repos/${repo}/pulls`, payload);
    return toPullRequestInfo(data as GitHubPullRaw);
  }
}

/**
 * Maps a raw GitHub pull request payload to the public {@link PullRequestInfo}
 * shape, including the body only when present (keeps the optional field truly
 * optional rather than explicitly `undefined`).
 */
function toPullRequestInfo(pr: GitHubPullRaw): PullRequestInfo {
  const info: PullRequestInfo = {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.html_url,
    head: pr.head.ref,
    base: pr.base.ref,
  };
  if (typeof pr.body === "string") {
    info.body = pr.body;
  }
  return info;
}
