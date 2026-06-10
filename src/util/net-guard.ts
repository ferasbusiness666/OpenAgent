/**
 * net-guard.ts — SSRF protection for outbound URL access (IMP-36).
 *
 * The browser and http tools take model-chosen URLs; without a guard a crafted
 * task ("check if http://192.168.1.1/admin is reachable") turns the agent into
 * a scanner of the user's own network — or, in a cloud environment, a reader of
 * the instance metadata endpoint. Every tool that dials out checks URLs through
 * {@link checkUrlAllowed} first.
 *
 * Blocked by default:
 *   • non-http(s) schemes (file:, ftp:, data:, …)
 *   • loopback        — 127.0.0.0/8, ::1, 0.0.0.0, ::, localhost
 *   • RFC-1918        — 10/8, 172.16/12, 192.168/16 (and IPv6 ULA fc00::/7)
 *   • link-local      — 169.254/16 (cloud metadata lives here), fe80::/10
 * Hostnames are RESOLVED via DNS and every returned address is classified, so
 * "internal.corp" pointing at 10.0.0.5 is caught, not just literal IPs.
 *
 * Two escape hatches keep legitimate local workflows working:
 *   • loopback exemptions — the serve tool registers its own preview servers so
 *     the agent can still open the site it just shipped on localhost.
 *   • the `allowLocalNetworkAccess` config flag disables the guard entirely for
 *     users who explicitly want to automate their own LAN / localhost apps.
 */

import dns from "node:dns/promises";
import net from "node:net";

/** Outcome of a URL safety check. */
export interface UrlCheckResult {
  allowed: boolean;
  /** Present when blocked — a human/model-readable explanation. */
  reason?: string;
}

/**
 * A predicate that may exempt a LOOPBACK url from blocking (e.g. "this is one
 * of our own local preview servers"). Only consulted for loopback addresses —
 * never for private-range or link-local ones.
 */
export type LoopbackExemption = (url: URL) => boolean;

const exemptions: LoopbackExemption[] = [];

/** Register a loopback exemption (used by the serve tool for its own previews). */
export function registerLoopbackExemption(fn: LoopbackExemption): void {
  exemptions.push(fn);
}

function isExemptLoopback(url: URL): boolean {
  return exemptions.some((fn) => {
    try {
      return fn(url);
    } catch {
      return false;
    }
  });
}

/** Address classification used to build the block reason. */
type AddressClass = "public" | "loopback" | "private" | "link-local";

/** Classify a literal IPv4 address string (assumes net.isIPv4(ip)). */
function classifyIPv4(ip: string): AddressClass {
  const parts = ip.split(".").map((n) => Number(n));
  const [a = 0, b = 0] = parts;
  if (a === 127 || ip === "0.0.0.0") return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local"; // incl. 169.254.169.254 metadata
  return "public";
}

/** Classify a literal IPv6 address string (assumes net.isIPv6(ip)). */
function classifyIPv6(ip: string): AddressClass {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped && mapped[1] !== undefined && net.isIPv4(mapped[1])) {
    return classifyIPv4(mapped[1]);
  }
  if (lower === "::1" || lower === "::") return "loopback";
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return "link-local"; // fe80::/10
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7
  return "public";
}

function classifyIp(ip: string): AddressClass {
  if (net.isIPv4(ip)) return classifyIPv4(ip);
  if (net.isIPv6(ip)) return classifyIPv6(ip);
  return "public";
}

/** Strip the brackets URL.hostname keeps around IPv6 literals. */
function bareHostname(url: URL): string {
  const h = url.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * Check whether `rawUrl` may be dialed. Resolves hostnames via DNS and
 * classifies every address; any non-public address blocks the request unless
 * exempted (loopback preview servers) or `allowLocal` is set.
 *
 * DNS failures do NOT block — an unresolvable host will fail at connect time
 * anyway, and blocking on resolver hiccups would create flaky false positives.
 */
export async function checkUrlAllowed(
  rawUrl: string,
  options?: { allowLocal?: boolean },
): Promise<UrlCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Invalid URL: "${rawUrl}"` };
  }

  // data:/about: never open a network connection, so they cannot SSRF —
  // browser tests and blank pages rely on them. file:// stays blocked: it
  // reads local files, which is exactly what the guard exists to prevent.
  if (url.protocol === "data:" || url.protocol === "about:") {
    return { allowed: true };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      reason:
        `Blocked: only http/https URLs are allowed (got "${url.protocol}//"). ` +
        `Schemes like file:// can read local files and are never dialed.`,
    };
  }

  if (options?.allowLocal === true) {
    return { allowed: true };
  }

  const host = bareHostname(url);

  // Collect the addresses this URL would actually connect to.
  let addresses: string[];
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else if (host === "localhost" || host.endsWith(".localhost")) {
    addresses = ["127.0.0.1"];
  } else {
    try {
      const results = await dns.lookup(host, { all: true, verbatim: true });
      addresses = results.map((r) => r.address);
    } catch {
      // Unresolvable — let the actual connection attempt produce the error.
      return { allowed: true };
    }
  }

  for (const address of addresses) {
    const cls = classifyIp(address);
    if (cls === "public") {
      continue;
    }
    if (cls === "loopback" && isExemptLoopback(url)) {
      continue; // one of our own local preview servers
    }
    return {
      allowed: false,
      reason:
        `Blocked: "${host}" resolves to ${address} (${cls} network range). ` +
        `Access to internal/private addresses is disabled to prevent SSRF. ` +
        `The user can enable "allowLocalNetworkAccess" in settings to permit it.`,
    };
  }

  return { allowed: true };
}
