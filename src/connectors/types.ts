/**
 * Base interface that all connectors must implement.
 *
 * Note: `params` and the return value of `executeAction` are typed as
 * `Record<string, unknown>` and `unknown` respectively — NOT `any` — to
 * satisfy the project's strict no-`any` rule while still allowing each
 * concrete connector to accept/return varied shapes.
 */
export interface Connector {
  /** Human-readable identifier for this connector (e.g. "github"). */
  readonly name: string;

  /**
   * Validate that the connector can authenticate against its upstream service
   * using locally available credentials (env vars / config file).
   *
   * @returns `true` when authentication succeeds, `false` otherwise.
   *          Never rejects — errors are swallowed and converted to `false`.
   */
  authenticate(): Promise<boolean>;

  /**
   * Dispatch a named action to the upstream service.
   *
   * @param action - The action to perform (e.g. "listRepos", "readFile").
   * @param params - Arbitrary parameters for the action. Typed as
   *                 `Record<string, unknown>` instead of `any` to preserve
   *                 strict-mode safety; each action documents its expected keys.
   * @returns The action result. Callers must narrow the type themselves.
   * @throws  An `Error` describing what went wrong (auth failure, bad params,
   *          non-ok HTTP response, etc.). The tool layer converts these into
   *          structured `ToolResult` failures.
   */
  executeAction(
    action: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}
