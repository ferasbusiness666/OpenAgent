import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { saveConfig, type Config } from "./config/index.js";
import { API_PROVIDERS, defaultModelFor, type ApiProviderName } from "./providers/catalog.js";

/**
 * CLIs we know how to drive. Keep in sync with src/providers/detector.ts and
 * src/providers/cli.ts. A local copy of the detection logic lives here so the
 * setup wizard is fully self-contained and can run before the UI boots.
 */
const KNOWN_CLIS = ["gemini", "claude", "codex", "aider", "goose", "ollama"] as const;

/** Check whether a command exists on PATH using `where` (win) / `which` (unix). */
function commandExists(cmd: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(finder, [cmd], { stdio: "ignore", shell: false });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Return the subset of KNOWN_CLIS that are installed on this machine. */
function detectClis(): string[] {
  return KNOWN_CLIS.filter((cli) => commandExists(cli));
}

/** Promise-based readline question helper. */
function makeAsker(rl: readline.Interface) {
  return (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

/**
 * First-run setup wizard. Runs when config.json is empty or incomplete.
 * Uses raw readline (not Ink) because it runs before the UI starts.
 * Returns the saved, completed Config.
 */
export async function runSetup(): Promise<Config> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl);

  try {
    console.log("");
    console.log("──────────────────────────────────────────────");
    console.log("  Open Agent — First Run Setup");
    console.log("──────────────────────────────────────────────");
    console.log("");

    // 1. Detect installed CLIs (a secondary, optional path now).
    console.log("Scanning for installed AI CLIs...");
    const detected = detectClis();

    // 2. Build the choice list, API-key providers FIRST (the recommended way),
    //    then any detected local CLIs. The combined `options` array is a union
    //    of provider metadata objects and CLI-name strings; the first
    //    `apiCount` entries are API providers, the rest are CLIs.
    const apiCount = API_PROVIDERS.length;
    const options: Array<(typeof API_PROVIDERS)[number] | string> = [
      ...API_PROVIDERS,
      ...detected,
    ];

    console.log("");
    console.log("How should Open Agent talk to a model?");
    console.log("Recommended: use a hosted API key — no local AI CLI required.");
    console.log("(Local CLIs are optional and only listed if installed.)");
    console.log("");
    options.forEach((opt, i) => {
      const label =
        i < apiCount
          ? `Use ${(opt as (typeof API_PROVIDERS)[number]).label} API key  (key: ${(opt as (typeof API_PROVIDERS)[number]).keyHint})`
          : `Use local CLI: ${opt as string}`;
      console.log(`  ${i + 1}) ${label}`);
    });
    console.log("");

    let choiceIndex = -1;
    while (choiceIndex < 0 || choiceIndex >= options.length) {
      const raw = await ask(`Choose [1-${options.length}]: `);
      const n = Number.parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        choiceIndex = n - 1;
      } else {
        console.log("  Please enter a valid number.");
      }
    }

    const partial: Partial<Config> = {};

    if (choiceIndex < apiCount) {
      // API-key path (the primary flow). `chosen` is the catalog metadata for
      // the picked provider; its id is an ApiProviderName (incl. "groq").
      const chosen = API_PROVIDERS[choiceIndex];
      const providerId: ApiProviderName = chosen.id;
      partial.providerMode = "api";
      partial.apiProvider = providerId;

      console.log("");
      console.log(`Selected ${chosen.label}.`);
      console.log(`Get a key at: ${chosen.keyHint}`);

      let key = "";
      while (key.length === 0) {
        key = await ask("API key: ");
        if (key.length === 0) console.log("  API key cannot be empty.");
      }
      partial.apiKey = key;

      // Seed the default model so the right one is used out of the box. The
      // user can change it later via /model or /settings.
      const model = defaultModelFor(providerId);
      partial.activeModel = model;
      console.log(`Default model: ${model} (change later with /model or /settings).`);
    } else {
      // Local CLI path (unchanged behavior).
      const cli = options[choiceIndex] as string;
      partial.providerMode = "cli";
      partial.activeCliName = cli;
    }

    // That is all the first-run wizard asks. The workspace is the directory the
    // agent was launched in (no separate workspace path), and Telegram is
    // configured later from inside the app via /settings (or environment vars).

    // 4. Persist.
    const saved = saveConfig(partial);

    // 5. Done.
    console.log("");
    console.log("Setup complete. Starting Open Agent...");
    console.log("");
    return saved;
  } finally {
    rl.close();
  }
}
