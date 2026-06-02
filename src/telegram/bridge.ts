import TelegramBot from "node-telegram-bot-api";
import type { AgentLoop } from "../agent/loop.js";

/** Telegram's hard message length limit. */
const TELEGRAM_MAX = 4096;

function truncate(text: string, max = TELEGRAM_MAX - 64): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function summarizeParams(params: Record<string, unknown>): string {
  const json = JSON.stringify(params);
  return json.length <= 200 ? json : `${json.slice(0, 200)}…`;
}

/**
 * TelegramBridge — mirrors the terminal session to a Telegram chat and lets the
 * user drive the agent remotely. Only one task runs at a time; messages that
 * arrive while a task is active are queued and run in order.
 */
export class TelegramBridge {
  private readonly bot: TelegramBot;
  private readonly agentLoop: AgentLoop;
  private readonly chatId: string;
  private readonly queue: string[] = [];
  private busy = false;
  private started = false;

  constructor(agentLoop: AgentLoop, token: string, chatId: string) {
    this.agentLoop = agentLoop;
    this.chatId = chatId;
    this.bot = new TelegramBot(token, { polling: true });
  }

  /** Begin polling, wire up events, and announce readiness. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.wireAgentEvents();
    this.wireIncoming();

    void this.send("✅ Open Agent is running. Send me a task.");
  }

  /** Stop polling cleanly. */
  async stop(): Promise<void> {
    try {
      await this.bot.stopPolling();
    } catch {
      // Best-effort shutdown.
    }
  }

  // ---- Outgoing -------------------------------------------------------------

  /** Send a message to the configured chat; never throws (logs nothing sensitive). */
  private async send(text: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, truncate(text));
    } catch {
      // Swallow network/Telegram errors so they never crash the agent.
    }
  }

  private wireAgentEvents(): void {
    this.agentLoop.on("thought", (thought) => {
      void this.send(`💭 ${thought}`);
    });
    this.agentLoop.on("toolCall", ({ tool, params }) => {
      void this.send(`🔧 ${tool}: ${summarizeParams(params)}`);
    });
    this.agentLoop.on("toolResult", ({ result, success }) => {
      void this.send(success ? `✅ ${result}` : `❌ ${result}`);
    });
    this.agentLoop.on("message", (message) => {
      void this.send(message);
    });
    this.agentLoop.on("done", (finalMessage) => {
      void this.send(`✅ Done: ${finalMessage}`);
      this.finishAndDrain();
    });
    this.agentLoop.on("stuck", (question) => {
      void this.send(`⚠️ Agent needs input: ${question}`);
      this.finishAndDrain();
    });
    this.agentLoop.on("error", (message) => {
      void this.send(`❌ Error: ${message}`);
      this.finishAndDrain();
    });
  }

  // ---- Incoming -------------------------------------------------------------

  private wireIncoming(): void {
    this.bot.on("message", (msg) => {
      const text = msg.text;
      if (typeof text !== "string" || text.trim().length === 0) return;
      // Only accept commands from the configured chat (security boundary).
      if (String(msg.chat.id) !== this.chatId) return;
      this.handleIncoming(text.trim());
    });
  }

  private handleIncoming(text: string): void {
    if (this.busy) {
      this.queue.push(text);
      void this.send("⏳ A task is already running. Queued your message.");
      return;
    }
    this.startTask(text);
  }

  private startTask(text: string): void {
    this.busy = true;
    void this.agentLoop.run(text);
  }

  /**
   * Called on any terminal event. Marks the bridge free and, on the next tick
   * (after the loop's run() has fully returned and reset its own flag), starts
   * the next queued task if there is one.
   */
  private finishAndDrain(): void {
    this.busy = false;
    setImmediate(() => {
      if (this.busy) return;
      const next = this.queue.shift();
      if (next !== undefined) {
        this.startTask(next);
      }
    });
  }
}
