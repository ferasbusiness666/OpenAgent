/**
 * notify.ts — best-effort completion notifications for background runs.
 *
 * Phase B (async / long-running): a detached run outlives the TUI, so when it
 * finishes there is no foreground UI to surface the result. These helpers nudge
 * the user instead — a terminal bell + a native desktop notification, and an
 * optional Telegram message when a bot is configured.
 *
 * EVERYTHING here is strictly best-effort and NEVER throws: a notification is a
 * nicety, not a correctness requirement, and a background worker must never die
 * because a notifier binary is missing, a shell is unavailable, or the network
 * is down. Every external call is wrapped so any failure is swallowed.
 */

import { spawn } from "node:child_process";

/** Escape a string for safe embedding inside an AppleScript double-quoted literal. */
function escapeForAppleScript(text: string): string {
  // Backslashes first, then double quotes; strip newlines so the one-liner stays valid.
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

/**
 * Spawn a fire-and-forget child that can never crash us: stdio is fully ignored
 * (so it can't block on a pipe), the Windows console window is hidden, and both
 * the synchronous spawn throw and the asynchronous "error" event are swallowed.
 */
function spawnSilently(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    // An ENOENT (missing binary) surfaces asynchronously as an "error" event; a
    // handler is required or Node would throw it as an uncaught exception.
    child.on("error", () => {
      /* swallow — the notification is optional */
    });
    child.unref();
  } catch {
    // Swallow a synchronous spawn failure (e.g. invalid arguments).
  }
}

/**
 * Emit a terminal bell (when attached to a TTY) and attempt a cross-platform
 * desktop notification. Each step is independently guarded so a failure in one
 * never prevents the others, and the whole function resolves without throwing.
 *
 * Platform strategy:
 *   - macOS  → `osascript -e 'display notification "msg" with title "title"'`
 *   - Linux  → `notify-send "title" "msg"`
 *   - Windows→ best-effort PowerShell balloon-tip; if it fails it is simply
 *              skipped. We deliberately spawn with stdio ignored + windowsHide
 *              so it can never pop a console window or hang the worker.
 *
 * @param title Short notification title (e.g. "OpenAgent — done").
 * @param message Body text shown to the user.
 */
export async function notify(title: string, message: string): Promise<void> {
  // 1) Terminal bell — only meaningful when we have a real terminal attached.
  try {
    if (process.stdout.isTTY) {
      process.stdout.write("");
    }
  } catch {
    // Ignore — stdout may be a closed/ignored pipe in a detached child.
  }

  // 2) Native desktop notification, per platform. Best-effort and non-blocking.
  try {
    if (process.platform === "darwin") {
      const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
      spawnSilently("osascript", ["-e", script]);
    } else if (process.platform === "linux") {
      spawnSilently("notify-send", [title, message]);
    } else if (process.platform === "win32") {
      // Best-effort Windows balloon tip via PowerShell + Windows Forms. If the
      // assembly/notify-icon path is fragile on a given box it just no-ops —
      // we never let it pop a console or block the worker.
      const safeTitle = title.replace(/'/g, "''");
      const safeMessage = message.replace(/'/g, "''");
      const psScript =
        "try {" +
        " Add-Type -AssemblyName System.Windows.Forms;" +
        " $n = New-Object System.Windows.Forms.NotifyIcon;" +
        " $n.Icon = [System.Drawing.SystemIcons]::Information;" +
        " $n.BalloonTipTitle = '" +
        safeTitle +
        "';" +
        " $n.BalloonTipText = '" +
        safeMessage +
        "';" +
        " $n.Visible = $true;" +
        " $n.ShowBalloonTip(5000);" +
        " Start-Sleep -Milliseconds 6000;" +
        " $n.Dispose();" +
        " } catch { }";
      spawnSilently("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        psScript,
      ]);
    }
  } catch {
    // Swallow — desktop notifications are optional.
  }
}

/**
 * Send a Telegram message via the Bot API, best-effort. Swallows ALL errors
 * (bad token, network failure, timeout) — a failed notification must never
 * disturb the run that triggered it.
 *
 * @param token Telegram bot token.
 * @param chatId Destination chat id.
 * @param text Message body (plain text).
 */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  if (token.trim().length === 0 || chatId.trim().length === 0) {
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
  } catch {
    // Swallow — network/abort/HTTP errors are all non-fatal here.
  } finally {
    clearTimeout(timer);
  }
}
