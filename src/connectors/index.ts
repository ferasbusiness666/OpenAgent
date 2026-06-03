export type { Connector } from "./types.js";
export { GitHubConnector } from "./github.js";
export type { RepoInfo, IssueInfo } from "./github.js";

import type { Connector } from "./types.js";
import { GitHubConnector } from "./github.js";

/**
 * Central registry of all available connectors, keyed by their `name`.
 * Adding a new connector here is sufficient to make it available everywhere
 * that calls `getConnector` or `listConnectors`.
 */
const registry = new Map<string, Connector>([
  ["github", new GitHubConnector()],
]);

/**
 * Returns the connector for `name`, or `undefined` if none is registered.
 */
export function getConnector(name: string): Connector | undefined {
  return registry.get(name);
}

/**
 * Returns the list of registered connector names.
 */
export function listConnectors(): string[] {
  return [...registry.keys()];
}
