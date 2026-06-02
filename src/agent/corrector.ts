/**
 * Corrector — tracks consecutive failures of "the same step" so the loop can
 * retry with the error fed back into context, and give up (go "stuck") after
 * too many failures of the identical step.
 *
 * A "step" is identified by a signature string the loop supplies — for a tool
 * call this is the tool name + its params, for a parse failure it is "parse".
 * Failing the same signature repeatedly increments the counter; succeeding (or
 * moving to a different step) resets it.
 */

/** How many times the same step may fail before it is treated as stuck. */
export const MAX_FAILURES_PER_STEP = 3;

export interface FailureOutcome {
  /** How many consecutive times this exact signature has now failed. */
  attempt: number;
  /** True once the failure count has reached MAX_FAILURES_PER_STEP. */
  giveUp: boolean;
}

export class Corrector {
  private failures = 0;
  private lastSignature: string | null = null;

  /**
   * Record a failure for `signature`. If it matches the previously failing
   * signature the counter increments; otherwise the counter restarts at 1 for
   * the new signature.
   */
  recordFailure(signature: string): FailureOutcome {
    if (signature === this.lastSignature) {
      this.failures += 1;
    } else {
      this.lastSignature = signature;
      this.failures = 1;
    }
    return {
      attempt: this.failures,
      giveUp: this.failures >= MAX_FAILURES_PER_STEP,
    };
  }

  /** Clear all failure tracking — call after any successful step. */
  reset(): void {
    this.failures = 0;
    this.lastSignature = null;
  }

  /** Current consecutive failure count (for diagnostics). */
  get count(): number {
    return this.failures;
  }
}
