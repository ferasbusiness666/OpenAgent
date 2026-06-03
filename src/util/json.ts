/**
 * Shared JSON extraction used by both the agent loop (parsing model output) and
 * the CLI provider (pulling a JSON object out of noisy CLI stdout). Kept in its
 * own module so neither importer has to depend on the other.
 */

/**
 * Extract the first balanced top-level JSON object from arbitrary text,
 * accounting for strings and escape sequences so braces inside string literals
 * don't confuse the matcher. Strips ```json / ``` markdown fences first.
 * Returns the JSON substring, or null when no balanced object is present.
 */
export function extractJsonObject(raw: string): string | null {
  const stripped = raw.replace(/```json/gi, "```").replace(/```/g, "");
  const start = stripped.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  return null;
}
