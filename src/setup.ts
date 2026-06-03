import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { saveConfig, type Config } from "./config/index.js";

/**
 * CLIs we know how to drive. Keep in sync with src/providers/detector.ts and
 * src/providers/cli.ts. A local copy of the detection logic lives here so the
 * setup wizard is fully self-contained and can run before the UI boots.
 */
const KNOWN_CLIS = ["gemini", "claude", "codex", "aider", "goose", "ollama"] as const;
const API_PROVIDERS = ["openai", "anthropic", "google"] as const;

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

    // 1. Detect installed CLIs.
    console.log("Scanning for installed AI CLIs...");
    const detected = detectClis();

    // 2. Build the choice list: detected CLIs + an API key option.
    const options: string[] = [...detected];
    const apiOptionIndex = options.length; // index of the "Enter API key" choice
    options.push("Enter API key instead");

    console.log("");
    console.log("How should Open Agent talk to a model?");
    if (detected.length === 0) {
      console.log("  (no supported CLIs found on PATH)");
    }
    options.forEach((opt, i) => {
      const label = i === apiOptionIndex ? opt : `Use detected CLI: ${opt}`;
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

    if (choiceIndex === apiOptionIndex) {
      // 4. API key path.
      partial.providerMode = "api";

      let provider = "";
      while (!API_PROVIDERS.includes(provider as (typeof API_PROVIDERS)[number])) {
        provider = (
          await ask(`API provider (${API_PROVIDERS.join(" / ")}): `)
        ).toLowerCase();
        if (!API_PROVIDERS.includes(provider as (typeof API_PROVIDERS)[number])) {
          console.log(`  Please enter one of: ${API_PROVIDERS.join(", ")}`);
        }
      }
      partial.apiProvider = provider as Config["apiProvider"];

      let key = "";
      while (key.length === 0) {
        key = await ask("API key: ");
        if (key.length === 0) console.log("  API key cannot be empty.");
      }
      partial.apiKey = key;
    } else {
      // 3. CLI path.
      partial.providerMode = "cli";
      partial.activeCliName = options[choiceIndex];
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
