import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const LABEL = "com.openai.chatgpt-code";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function servicePath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export async function installService(input: {
  config: AppConfig;
  tunnel: "off" | "quick" | "managed";
  cliPath: string;
}): Promise<{ installed: true; path: string }> {
  if (process.platform !== "darwin") {
    throw new Error("Background service installation currently supports macOS launchd");
  }
  const target = servicePath();
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(input.config.dataDir, { recursive: true });
  const argumentsList = [
    process.execPath,
    input.cliPath,
    "serve",
    "--no-open",
    "--tunnel",
    input.tunnel,
    "--home",
    input.config.dataDir,
  ];
  for (const root of input.config.workspaceRoots) {
    argumentsList.push("--workspace", root);
  }
  const argumentsXml = argumentsList
    .map((argument) => `<string>${escapeXml(argument)}</string>`)
    .join("\n      ");
  const logPath = path.join(input.config.dataDir, "service.log");
  const errorPath = path.join(input.config.dataDir, "service.error.log");
  const executablePath = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(":");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
      ${argumentsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>${escapeXml(input.config.workspaceRoots[0]!)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(executablePath)}</string>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(errorPath)}</string>
</dict>
</plist>
`;
  await writeFile(target, plist, { encoding: "utf8", mode: 0o600 });
  await execFileAsync("launchctl", [
    "bootout",
    `gui/${process.getuid?.() ?? 501}`,
    target,
  ]).catch(() => undefined);
  await execFileAsync("launchctl", [
    "bootstrap",
    `gui/${process.getuid?.() ?? 501}`,
    target,
  ]);
  return { installed: true, path: target };
}

export async function uninstallService(): Promise<{
  uninstalled: true;
  path: string;
}> {
  if (process.platform !== "darwin") {
    throw new Error("Background service installation currently supports macOS launchd");
  }
  const target = servicePath();
  await execFileAsync("launchctl", [
    "bootout",
    `gui/${process.getuid?.() ?? 501}`,
    target,
  ]).catch(() => undefined);
  await rm(target, { force: true });
  return { uninstalled: true, path: target };
}

export async function serviceStatus(): Promise<{
  label: string;
  loaded: boolean;
  detail: string;
}> {
  if (process.platform !== "darwin") {
    return { label: LABEL, loaded: false, detail: "launchd is only available on macOS" };
  }
  try {
    const { stdout } = await execFileAsync("launchctl", [
      "print",
      `gui/${process.getuid?.() ?? 501}/${LABEL}`,
    ]);
    return { label: LABEL, loaded: true, detail: stdout };
  } catch (error) {
    return { label: LABEL, loaded: false, detail: String(error) };
  }
}
