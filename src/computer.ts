import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./types.js";
import type { ActivityStore } from "./events.js";

const execFileAsync = promisify(execFile);

const KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

export class ComputerService {
  constructor(
    private readonly config: AppConfig,
    private readonly events: ActivityStore,
  ) {}

  private assertMac(): void {
    if (process.platform !== "darwin") {
      throw new Error("Built-in computer control currently supports macOS");
    }
  }

  async screenshot(): Promise<{
    path: string;
    data: string;
    mimeType: "image/png";
    frontmostApp: string;
  }> {
    this.assertMac();
    const target = path.join(
      this.config.dataDir,
      "screenshots",
      `${randomUUID()}.png`,
    );
    await execFileAsync("mkdir", ["-p", path.dirname(target)]);
    await execFileAsync("/usr/sbin/screencapture", ["-x", "-t", "png", target]);
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    const data = (await readFile(target)).toString("base64");
    this.events.publish("computer", "Screenshot captured", "success", stdout.trim(), {
      path: target,
    });
    return { path: target, data, mimeType: "image/png", frontmostApp: stdout.trim() };
  }

  async click(x: number, y: number, button: "left" | "right" = "left"): Promise<void> {
    this.assertMac();
    const script =
      button === "right"
        ? `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}} using {control down}`
        : `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`;
    await execFileAsync("/usr/bin/osascript", ["-e", script]);
    this.events.publish("computer", `${button} click`, "success", `${x}, ${y}`);
  }

  async type(text: string): Promise<void> {
    this.assertMac();
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      "on run argv",
      "-e",
      'tell application "System Events" to keystroke (item 1 of argv)',
      "-e",
      "end run",
      text,
    ]);
    this.events.publish("computer", "Text typed", "success", `${text.length} characters`);
  }

  async key(key: string, modifiers: string[] = []): Promise<void> {
    this.assertMac();
    const keyCode = KEY_CODES[key.toLowerCase()];
    const allowed = new Set(["command", "control", "option", "shift"]);
    const normalized = modifiers
      .map((modifier) => modifier.toLowerCase())
      .filter((modifier) => allowed.has(modifier));
    const using =
      normalized.length > 0
        ? ` using {${normalized.map((modifier) => `${modifier} down`).join(", ")}}`
        : "";
    const action =
      keyCode === undefined
        ? `keystroke "${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"${using}`
        : `key code ${keyCode}${using}`;
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `tell application "System Events" to ${action}`,
    ]);
    this.events.publish("computer", "Key pressed", "success", [key, ...normalized].join("+"));
  }

  async scroll(amount: number): Promise<void> {
    this.assertMac();
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      `tell application "System Events" to scroll area 1 of first application process whose frontmost is true by ${Math.round(amount)}`,
    ]).catch(async () => {
      const direction = amount > 0 ? 125 : 126;
      const repeats = Math.min(Math.max(Math.abs(Math.round(amount)), 1), 50);
      await execFileAsync("/usr/bin/osascript", [
        "-e",
        `tell application "System Events" to repeat ${repeats} times`,
        "-e",
        `key code ${direction}`,
        "-e",
        "end repeat",
      ]);
    });
    this.events.publish("computer", "Scrolled", "success", String(amount));
  }
}
