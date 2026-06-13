// Deterministic verification for the encrypted-at-rest secret store (IMP-35)
// and its opt-in config integration. No network, no real keychain (keytar is
// not installed, so the file backend is exercised). Everything runs against a
// throwaway temp dir via __setSecretsDirForTest, and the one test that touches
// the real config.json captures and RESTORES the user's original values in a
// finally block so their config is left exactly as found.
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { randomUUID } from "node:crypto";
import {
  secretsBackend,
  describeSecretsBackend,
  getSecret,
  setSecret,
  deleteSecret,
  __setSecretsDirForTest,
} from "../src/secrets.js";
import { getConfig, saveConfig, CONFIG_PATH } from "../src/config/index.js";

function check(label: string, ok: boolean): boolean {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

async function main(): Promise<void> {
  const results: boolean[] = [];
  const tempDir = path.join(os.tmpdir(), `openagent-verify-secrets-${randomUUID()}`);
  const PLAIN = "super-secret-value-PLAINTEXT-marker";

  try {
    __setSecretsDirForTest(tempDir);

    // 1. Backend selection + description --------------------------------------
    results.push(
      check(
        `secretsBackend() === "encrypted-file" (keytar absent, got "${secretsBackend()}")`,
        secretsBackend() === "encrypted-file",
      ),
    );
    const desc = describeSecretsBackend();
    results.push(
      check(
        `describeSecretsBackend() is non-empty and mentions encryption (got "${desc.slice(0, 40)}…")`,
        typeof desc === "string" && desc.length > 0 && /encrypt/i.test(desc),
      ),
    );

    // 2. set/get round-trip, overwrite, missing, delete -----------------------
    setSecret("x", PLAIN);
    results.push(check(`getSecret("x") returns the stored value`, getSecret("x") === PLAIN));
    setSecret("x", "overwritten");
    results.push(check(`overwrite updates the value`, getSecret("x") === "overwritten"));
    results.push(check(`getSecret("missing") === null`, getSecret("missing") === null));
    deleteSecret("x");
    results.push(check(`deleteSecret removes the value (getSecret → null)`, getSecret("x") === null));

    // 3. Persistence + encryption-at-rest -------------------------------------
    setSecret("apiKey", PLAIN);
    const encPath = path.join(tempDir, "secrets.enc");
    const exists = fs.existsSync(encPath);
    results.push(check(`secrets.enc was written to the temp dir`, exists));
    const rawBytes = exists ? fs.readFileSync(encPath) : Buffer.alloc(0);
    const rawText = rawBytes.toString("utf8");
    results.push(
      check(
        `plaintext value is NOT present in the file bytes (encrypted at rest)`,
        !rawText.includes(PLAIN),
      ),
    );
    let envelopeOk = false;
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      envelopeOk =
        parsed.v === 1 &&
        typeof parsed.iv === "string" &&
        typeof parsed.tag === "string" &&
        typeof parsed.data === "string";
    } catch {
      envelopeOk = false;
    }
    results.push(check(`file is valid JSON with v/iv/tag/data fields`, envelopeOk));

    // 4. A fresh "process" decrypts from disk (reset cache, re-read) -----------
    __setSecretsDirForTest(tempDir); // resets the in-memory cache
    results.push(
      check(
        `fresh process reads persisted secret from disk (not just cache)`,
        getSecret("apiKey") === PLAIN,
      ),
    );

    // 5. Corrupt-file tolerance -----------------------------------------------
    fs.writeFileSync(encPath, "garbage not json {{{", "utf8");
    __setSecretsDirForTest(tempDir); // reset cache so it re-reads the garbage
    let threw = false;
    let corruptResult: string | null = "sentinel";
    try {
      corruptResult = getSecret("apiKey");
    } catch {
      threw = true;
    }
    results.push(
      check(
        `corrupt secrets.enc → getSecret returns null without throwing`,
        !threw && corruptResult === null,
      ),
    );

    // 6. Config integration (touches REAL config.json — restored in finally) --
    const original = getConfig();
    const origApiKey = original.apiKey;
    const origEncrypt = original.encryptSecrets;
    try {
      const TEST_KEY = "sk-test-12345";
      const effective = saveConfig({ encryptSecrets: true, apiKey: TEST_KEY });
      results.push(
        check(
          `saveConfig returns effective config WITH real apiKey (got "${effective.apiKey}")`,
          effective.apiKey === TEST_KEY,
        ),
      );
      results.push(
        check(`getConfig().apiKey resolves back to the real value`, getConfig().apiKey === TEST_KEY),
      );

      // Raw on-disk config.json must have apiKey blanked.
      const rawConfig = fs.readJsonSync(CONFIG_PATH) as Record<string, unknown>;
      results.push(
        check(
          `raw config.json on disk has apiKey === "" (blanked, got ${JSON.stringify(rawConfig.apiKey)})`,
          rawConfig.apiKey === "",
        ),
      );
      results.push(
        check(`raw config.json on disk has encryptSecrets === true`, rawConfig.encryptSecrets === true),
      );

      // Sanity: when encryptSecrets is off, the secret is written plaintext as
      // before (proves default behavior is unchanged). Use a distinct value.
      saveConfig({ encryptSecrets: false, apiKey: "sk-plain-67890" });
      const rawPlain = fs.readJsonSync(CONFIG_PATH) as Record<string, unknown>;
      results.push(
        check(
          `with encryptSecrets=false, apiKey is written plaintext (unchanged behavior)`,
          rawPlain.apiKey === "sk-plain-67890",
        ),
      );
    } finally {
      // Clean up the secret store entry we created, then RESTORE the user's
      // original config exactly (value + flag). deleteSecret targets the test
      // temp dir is wrong here — config integration used the REAL store, so
      // reset to the real dir before deleting.
      __setSecretsDirForTest(null);
      try {
        deleteSecret("apiKey");
      } catch {
        // best-effort
      }
      saveConfig({ encryptSecrets: origEncrypt, apiKey: origApiKey });
      const restored = getConfig();
      results.push(
        check(
          `user's original config restored (apiKey + encryptSecrets)`,
          restored.apiKey === origApiKey && restored.encryptSecrets === origEncrypt,
        ),
      );
    }
  } finally {
    __setSecretsDirForTest(null);
    try {
      fs.removeSync(tempDir);
    } catch {
      // best-effort
    }
  }

  const ok = results.every(Boolean);
  console.log(`\nSECRETS VERIFY: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

void main();
