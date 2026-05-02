// File notifier: append the summary to a log file.
//
// Path resolution:
//   1. NOTIFY_LOG_FILE env var (absolute path), if set
//   2. ~/Library/Logs/cuassistant.log on macOS
//   3. ~/.local/state/cuassistant/cuassistant.log elsewhere
//
// Each entry is the summary text wrapped between marker lines so multiple
// runs concatenate cleanly when tailed.

import { promises as fs, mkdirSync } from "fs";
import { homedir, platform } from "os";
import { dirname, join } from "path";

import { registerNotifier } from "./registry.js";

function defaultLogPath(): string {
  const env = process.env.NOTIFY_LOG_FILE;
  if (env) return env;
  return platform() === "darwin"
    ? join(homedir(), "Library", "Logs", "cuassistant.log")
    : join(homedir(), ".local", "state", "cuassistant", "cuassistant.log");
}

const LOG_PATH = defaultLogPath();
mkdirSync(dirname(LOG_PATH), { recursive: true });

registerNotifier({
  name: "file",
  send: async (text) => {
    const stamp = new Date().toISOString();
    const entry =
      `\n===== ${stamp} =====\n` +
      (text.endsWith("\n") ? text : text + "\n") +
      `===== end ${stamp} =====\n`;
    await fs.appendFile(LOG_PATH, entry);
  },
});
