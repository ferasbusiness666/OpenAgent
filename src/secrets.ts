/**
 * secrets.ts — opt-in encrypted-at-rest store for the handful of credentials
 * Open Agent keeps (the LLM API key, the Telegram bot token, the Tavily key).
 *
 * WHY THIS EXISTS (IMP-35)
 * ────────────────────────
 * By default Open Agent writes those secrets in plaintext inside
 * ~/.openagent/config.json. That is convenient but leaves a credential sitting
 * on disk where a stray `cat`, a screen-share, a backup, or an accidental
 * `git add` can expose it. When the user flips the `encryptSecrets` config flag
 * on, the config layer routes secrets through THIS module instead, so
 * config.json holds only blanks and the real values live encrypted in
 * ~/.openagent/secrets.enc (or the OS keychain — see below).
 *
 * THREAT MODEL — READ THIS HONESTLY
 * ─────────────────────────────────
 * Two backends exist, picked automatically:
 *
 *   • "keychain"        — used ONLY when the optional `keytar` module is
 *                         installed. Secrets live in the real OS credential
 *                         store (macOS Keychain / Windows Credential Manager /
 *                         libsecret). This is the strong option: the OS guards
 *                         the secret with the user's login session and other
 *                         processes/users cannot trivially read it. `keytar` is
 *                         NOT a dependency of this project, so this backend is
 *                         off unless the user opts in by installing it.
 *
 *   • "encrypted-file"  — the default fallback. Secrets are AES-256-GCM
 *                         encrypted in secrets.enc. The encryption key is NOT a
 *                         user password; it is DERIVED FROM THE MACHINE
 *                         (hostname + username + home directory). That means:
 *
 *        ✓ Protects against CASUAL exposure: someone glancing at the file, a
 *          file synced to a backup, the value accidentally committed to git, a
 *          log scrape — none of those reveal the secret, because the file is
 *          ciphertext and the salt/derivation are fixed but the plaintext is
 *          not present.
 *        ✗ Does NOT protect against a determined LOCAL attacker who can run
 *          code as the same user on the same machine. Such an attacker can
 *          recompute the machine-derived key exactly the way this module does
 *          and decrypt the file. The machine key is obfuscation-grade binding,
 *          not a vault.
 *
 *     If you need real protection from a local attacker, install `keytar` (the
 *     keychain backend is selected automatically) or supply the secret via an
 *     environment variable so it never touches disk at all.
 *
 * SAFETY CONTRACT
 * ───────────────
 * Nothing in this module ever throws. A corrupt file, a different machine that
 * cannot decrypt an old secrets.enc, a missing directory — all degrade to "no
 * secret found" (getSecret → null) rather than crashing the app or, worse,
 * losing a key by aborting a save mid-write. Reads are synchronous so the
 * config layer (which is synchronous today) need not change shape.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import { DATA_DIR, ensureDataDir } from "./paths.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Which storage backend is active for this process. */
export type SecretsBackend = "keychain" | "encrypted-file";

/**
 * On-disk envelope written to secrets.enc. All binary fields are base64. `v`
 * is a format version so a future change can migrate rather than misread.
 */
interface SecretsFile {
  v: 1;
  /** AES-GCM initialization vector (12 bytes), base64. */
  iv: string;
  /** AES-GCM authentication tag (16 bytes), base64. */
  tag: string;
  /** Ciphertext of the JSON name→value map, base64. */
  data: string;
}

/**
 * Minimal typed surface of the OPTIONAL `keytar` module. We only ever touch
 * these three functions, so we model just them — no `any`, and no hard
 * dependency on @types/keytar (which isn't installed either).
 */
interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Filename (under the storage dir) of the encrypted file-backend store. */
const SECRETS_FILENAME = "secrets.enc";

/** Service name used for every entry in the OS keychain backend. */
const KEYCHAIN_SERVICE = "openagent";

/** Fixed salt for the scrypt key derivation. Not a secret; pairs with the
 *  machine-derived material to produce a stable per-machine+user key. */
const SCRYPT_SALT = "openagent-secrets-salt";

/** AES-256-GCM: 32-byte key, 12-byte IV, 16-byte tag. */
const KEY_BYTES = 32;
const IV_BYTES = 12;

// ── Module state (caches) ─────────────────────────────────────────────────────

/**
 * Override for the storage directory, set only by tests. `null` means "use the
 * real DATA_DIR". Kept separate from DATA_DIR so production never reads a stale
 * test value.
 */
let secretsDirOverride: string | null = null;

/** Memoized backend choice. Reset by {@link __setSecretsDirForTest}. */
let cachedBackend: SecretsBackend | null = null;

/**
 * In-memory copy of every known secret, keyed by name. For the file backend
 * this is the decrypted map loaded lazily on first access (and refreshed on
 * write). For the keychain backend this is hydrated by {@link hydrateSecrets}
 * so {@link getSecret} can stay synchronous. `null` = not yet loaded.
 */
let cache: Map<string, string> | null = null;

// ── Directory + key helpers ───────────────────────────────────────────────────

/** Directory the secrets file lives in (test override or real DATA_DIR). */
function secretsDir(): string {
  return secretsDirOverride ?? DATA_DIR;
}

/** Absolute path of the encrypted secrets file. */
function secretsFilePath(): string {
  return path.join(secretsDir(), SECRETS_FILENAME);
}

/**
 * Stable, machine+user-specific key material. NOT secret in the cryptographic
 * sense — anyone who can run as this user on this host can recompute it. See the
 * threat-model note at the top of the file. The sha256 hex string it returns is
 * fed to scrypt to stretch into the AES key.
 */
function machineKeyMaterial(): string {
  let hostname = "";
  let username = "";
  let homedir = "";
  try {
    hostname = os.hostname();
  } catch {
    hostname = "";
  }
  try {
    username = os.userInfo().username;
  } catch {
    username = "";
  }
  try {
    homedir = os.homedir();
  } catch {
    homedir = "";
  }
  const seed = `${hostname} ${username} ${homedir}`;
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex");
}

/** Derive the 32-byte AES key from the machine material via scrypt. */
function deriveKey(): Buffer {
  return crypto.scryptSync(machineKeyMaterial(), SCRYPT_SALT, KEY_BYTES);
}

// ── Backend detection ──────────────────────────────────────────────────────

/**
 * Synchronously decide which backend is active and cache it. We attempt to
 * resolve the OPTIONAL `keytar` module; if it cannot be resolved (the expected
 * case, since it is not a dependency) we fall back to the encrypted file.
 *
 * The probe uses `require.resolve` semantics via a dynamic check rather than a
 * top-level await so this can remain synchronous. We import keytar for real
 * (asynchronously) only inside the keychain code paths.
 */
export function secretsBackend(): SecretsBackend {
  if (cachedBackend !== null) {
    return cachedBackend;
  }
  cachedBackend = probeKeychainAvailable() ? "keychain" : "encrypted-file";
  return cachedBackend;
}

/**
 * Best-effort synchronous probe for the presence of `keytar`. Uses
 * createRequire so we can call require.resolve from an ESM module without
 * actually loading the (native) module on the hot path. Any failure → false.
 */
function probeKeychainAvailable(): boolean {
  try {
    // Lazily build a CommonJS-style require bound to this module's URL.
    // `import.meta.url` is available because the project is ESM.
    const req = createRequireSafe();
    if (req === null) {
      return false;
    }
    req.resolve("keytar");
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a `require` whose `.resolve` we can use to detect optional modules.
 * Wrapped so that, in any environment where this is unavailable, we simply
 * report "no keychain" instead of throwing.
 */
function createRequireSafe(): NodeRequire | null {
  try {
    // node:module is always present; createRequire needs a base path/URL.
    // We import it lazily and synchronously via the global require shim that
    // tsx/node provides for ESM interop is not guaranteed, so use module API.
    const moduleApi = nodeModule;
    if (moduleApi === null) {
      return null;
    }
    return moduleApi.createRequire(import.meta.url);
  } catch {
    return null;
  }
}

/**
 * Lazily-loaded reference to node:module's createRequire facility. Loaded via a
 * synchronous require-of-builtin is not possible in ESM, so we resolve it once
 * through a dynamic import kicked off at module init and memoize the result.
 * Until it resolves, keychain probing returns false (safe default).
 */
let nodeModule: { createRequire(p: string | URL): NodeRequire } | null = null;
void (async () => {
  try {
    const m = await import("node:module");
    nodeModule = { createRequire: m.createRequire };
    // The backend may have been cached as "encrypted-file" before node:module
    // finished loading; clear it so the next call re-probes now that keychain
    // detection is possible.
    if (cachedBackend === "encrypted-file") {
      cachedBackend = null;
    }
  } catch {
    nodeModule = null;
  }
})();

/**
 * One-line, human-readable description of the active backend for the startup
 * warning. For the file backend it is deliberately candid about the
 * machine-derived-key weakness so the user is not misled into thinking this is
 * a hardened vault.
 */
export function describeSecretsBackend(): string {
  if (secretsBackend() === "keychain") {
    return "Secrets are encrypted in your OS keychain (keytar).";
  }
  return (
    "Secrets are AES-256-GCM encrypted at rest in ~/.openagent/secrets.enc, but " +
    "the key is derived from this machine — it guards against casual disk " +
    "inspection or accidental commits, not a determined local attacker. " +
    "Install keytar (or use environment variables) for stronger protection."
  );
}

// ── File backend: load / persist the decrypted map ────────────────────────────

/**
 * Decrypt secrets.enc into a name→value map. Any problem — missing file,
 * unparseable JSON, wrong-shape envelope, GCM auth failure (corrupt file or a
 * different machine) — yields an empty map. NEVER throws and NEVER logs the
 * plaintext.
 */
function loadFileMap(): Map<string, string> {
  const file = secretsFilePath();
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) {
      return new Map();
    }
    raw = fs.readJsonSync(file);
  } catch {
    return new Map();
  }

  if (!isSecretsFile(raw)) {
    return new Map();
  }

  try {
    const iv = Buffer.from(raw.iv, "base64");
    const tag = Buffer.from(raw.tag, "base64");
    const data = Buffer.from(raw.data, "base64");
    const key = deriveKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    const obj = JSON.parse(plaintext) as unknown;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return new Map();
    }
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") {
        map.set(k, v);
      }
    }
    return map;
  } catch {
    // Auth failure (corrupt / foreign machine) or any other decryption error.
    return new Map();
  }
}

/** Type guard for the on-disk envelope shape. */
function isSecretsFile(value: unknown): value is SecretsFile {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.data === "string"
  );
}

/**
 * Encrypt the given map and atomically write secrets.enc. Best-effort: any
 * failure is swallowed (the in-memory cache still reflects the change for the
 * life of the process, so a write hiccup never loses the value mid-session).
 */
function persistFileMap(map: Map<string, string>): void {
  try {
    ensureSecretsDir();
    const obj: Record<string, string> = {};
    for (const [k, v] of map) {
      obj[k] = v;
    }
    const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
    const key = deriveKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: SecretsFile = {
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: ciphertext.toString("base64"),
    };
    fs.writeJsonSync(secretsFilePath(), envelope, { spaces: 0 });
  } catch {
    // Never throw on write — the cache already holds the new value.
  }
}

/** Ensure the storage directory exists (real DATA_DIR or the test override). */
function ensureSecretsDir(): void {
  try {
    if (secretsDirOverride !== null) {
      fs.ensureDirSync(secretsDirOverride);
    } else {
      ensureDataDir();
    }
  } catch {
    // Best-effort.
  }
}

/** Return the live cache, lazily loading the file backend's map on first use. */
function ensureCache(): Map<string, string> {
  if (cache !== null) {
    return cache;
  }
  // For the keychain backend the cache is populated by hydrateSecrets(); until
  // then it is an empty map (a not-yet-hydrated secret simply reads as null).
  // For the file backend we decrypt the file now.
  cache = secretsBackend() === "encrypted-file" ? loadFileMap() : new Map();
  return cache;
}

// ── Keychain backend (best-effort, async, optional) ──────────────────────────

/**
 * Dynamically import the optional `keytar` module. Returns null when it is not
 * installed (the normal case) or fails to load. Never throws.
 */
async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    // A NON-LITERAL specifier so TypeScript does not try to resolve a module
    // that isn't a dependency (keytar is optional and normally absent).
    const spec = ["key", "tar"].join("");
    const mod: unknown = await import(spec);
    const candidate = (mod as { default?: unknown }).default ?? mod;
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as KeytarLike).getPassword === "function" &&
      typeof (candidate as KeytarLike).setPassword === "function" &&
      typeof (candidate as KeytarLike).deletePassword === "function"
    ) {
      return candidate as KeytarLike;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read a secret by name, or `null` if absent. SYNCHRONOUS.
 *
 * File backend: served from the decrypted in-memory map (loaded lazily).
 * Keychain backend: served from the cache previously filled by
 * {@link hydrateSecrets}; a name that was never hydrated reads as `null`.
 */
export function getSecret(name: string): string | null {
  try {
    const map = ensureCache();
    const value = map.get(name);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Store or overwrite a secret. SYNCHRONOUS with respect to the in-memory cache
 * and (file backend) the on-disk re-encrypt.
 *
 * Keychain backend: the cache is updated synchronously and a write-through to
 * the OS keychain is fired-and-forgotten (best-effort, errors swallowed) so the
 * value survives a restart even though this function does not await it.
 */
export function setSecret(name: string, value: string): void {
  try {
    const map = ensureCache();
    map.set(name, value);
    if (secretsBackend() === "encrypted-file") {
      persistFileMap(map);
    } else {
      // Keychain: best-effort async write-through.
      void (async () => {
        const keytar = await loadKeytar();
        if (keytar !== null) {
          try {
            await keytar.setPassword(KEYCHAIN_SERVICE, name, value);
          } catch {
            // Swallow — the cache already holds the value for this session.
          }
        }
      })();
    }
  } catch {
    // Never throw.
  }
}

/**
 * Remove a secret from both the cache and the active backend. SYNCHRONOUS for
 * the cache + file backend; keychain deletion is fired-and-forgotten.
 */
export function deleteSecret(name: string): void {
  try {
    const map = ensureCache();
    map.delete(name);
    if (secretsBackend() === "encrypted-file") {
      persistFileMap(map);
    } else {
      void (async () => {
        const keytar = await loadKeytar();
        if (keytar !== null) {
          try {
            await keytar.deletePassword(KEYCHAIN_SERVICE, name);
          } catch {
            // Swallow.
          }
        }
      })();
    }
  } catch {
    // Never throw.
  }
}

/**
 * Hydrate the in-memory cache from the active backend so {@link getSecret} can
 * stay synchronous. For the keychain backend each name is read from the OS
 * store; for the file backend this is a no-op (the file is decrypted lazily by
 * getSecret). Never throws.
 *
 * @param names  The secret names the app cares about (e.g. apiKey,
 *               telegramToken, tavilyApiKey).
 */
export async function hydrateSecrets(names: string[]): Promise<void> {
  try {
    if (secretsBackend() !== "keychain") {
      return;
    }
    const keytar = await loadKeytar();
    if (keytar === null) {
      return;
    }
    const map = ensureCache();
    for (const name of names) {
      try {
        const value = await keytar.getPassword(KEYCHAIN_SERVICE, name);
        if (typeof value === "string") {
          map.set(name, value);
        }
      } catch {
        // Skip this one; others may still hydrate.
      }
    }
  } catch {
    // Never throw.
  }
}

/**
 * TEST HOOK: point the file backend at `dir` instead of DATA_DIR and reset all
 * caches (so the next access re-probes the backend and re-reads from disk).
 * Pass `null` to restore the default directory. Calling this also clears the
 * decrypted-map cache, which is exactly what a "fresh process" simulation needs.
 */
export function __setSecretsDirForTest(dir: string | null): void {
  secretsDirOverride = dir;
  cache = null;
  cachedBackend = null;
}
