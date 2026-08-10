import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./types.js";
import { ensureCloudflared } from "./dependencies.js";

const execFileAsync = promisify(execFile);
const LABEL = "com.omnix.go";
const LEGACY_LABEL = "com.openai.chatgpt-code";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function commandArguments(input: {
  config: AppConfig;
  tunnel: "off" | "gateway";
  cliPath: string;
}): string[] {
  const args = [
    input.cliPath,
    "serve",
    "--no-open",
    "--tunnel",
    input.tunnel,
    "--home",
    input.config.dataDir,
  ];
  for (const root of input.config.workspaceRoots) args.push("--workspace", root);
  return args;
}

function windowsQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

export function servicePath(platform = process.platform): string {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "OmniX Go.cmd",
    );
  }
  if (platform === "linux") {
    return path.join(os.homedir(), ".config", "systemd", "user", "omnix-go.service");
  }
  throw new Error(`Background service installation is not supported on ${platform}`);
}

async function installMacService(input: {
  config: AppConfig;
  tunnel: "off" | "gateway";
  cliPath: string;
}): Promise<string> {
  const target = servicePath("darwin");
  const legacyTarget = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LEGACY_LABEL}.plist`,
  );
  await mkdir(path.dirname(target), { recursive: true });
  const argumentsList = [process.execPath, ...commandArguments(input)];
  const argumentsXml = argumentsList
    .map((argument) => `<string>${escapeXml(argument)}</string>`)
    .join("\n      ");
  const logPath = path.join(input.config.dataDir, "service.log");
  const errorPath = path.join(input.config.dataDir, "service.error.log");
  const executablePath = [
    path.dirname(process.execPath),
    path.join(input.config.dataDir, "bin"),
    path.join(os.homedir(), ".local", "bin"),
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
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execFileAsync("launchctl", ["bootout", domain, target]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootout", domain, legacyTarget]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootstrap", domain, target]);
  await rm(legacyTarget, { force: true });
  return target;
}

async function installWindowsService(input: {
  config: AppConfig;
  tunnel: "off" | "gateway";
  cliPath: string;
}): Promise<string> {
  const target = servicePath("win32");
  await mkdir(path.dirname(target), { recursive: true });
  const args = commandArguments(input).map(windowsQuote).join(" ");
  const logPath = windowsQuote(path.join(input.config.dataDir, "service.log"));
  const errorPath = windowsQuote(path.join(input.config.dataDir, "service.error.log"));
  const command = `@echo off\r\nstart "OmniX Go" /min /b ${windowsQuote(process.execPath)} ${args} 1>>${logPath} 2>>${errorPath}\r\n`;
  await writeFile(target, command, { encoding: "utf8", mode: 0o600 });
  const child = spawn(process.execPath, commandArguments(input), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return target;
}

async function installLinuxService(input: {
  config: AppConfig;
  tunnel: "off" | "gateway";
  cliPath: string;
}): Promise<string> {
  const target = servicePath("linux");
  await mkdir(path.dirname(target), { recursive: true });
  const args = [process.execPath, ...commandArguments(input)]
    .map((value) => JSON.stringify(value))
    .join(" ");
  const unit = `[Unit]
Description=OmniX Go private MCP service
After=network-online.target

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=10
WorkingDirectory=${input.config.workspaceRoots[0]}

[Install]
WantedBy=default.target
`;
  await writeFile(target, unit, { encoding: "utf8", mode: 0o600 });
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", "omnix-go.service"]);
  return target;
}

export async function installService(input: {
  config: AppConfig;
  tunnel: "off" | "gateway";
  cliPath: string;
}): Promise<{ installed: true; path: string; platform: NodeJS.Platform }> {
  await mkdir(input.config.dataDir, { recursive: true, mode: 0o700 });
  if (input.tunnel !== "off") await ensureCloudflared(input.config.dataDir);
  const target =
    process.platform === "darwin"
      ? await installMacService(input)
      : process.platform === "win32"
        ? await installWindowsService(input)
        : process.platform === "linux"
          ? await installLinuxService(input)
          : servicePath();
  return { installed: true, path: target, platform: process.platform };
}

export async function uninstallService(): Promise<{
  uninstalled: true;
  path: string;
}> {
  const target = servicePath();
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await execFileAsync("launchctl", ["bootout", domain, target]).catch(() => undefined);
  } else if (process.platform === "linux") {
    await execFileAsync("systemctl", ["--user", "disable", "--now", "omnix-go.service"])
      .catch(() => undefined);
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
  await rm(target, { force: true });
  return { uninstalled: true, path: target };
}

export async function serviceStatus(): Promise<{
  label: string;
  loaded: boolean;
  detail: string;
}> {
  if (process.platform === "darwin") {
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
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("systemctl", [
        "--user",
        "status",
        "omnix-go.service",
        "--no-pager",
      ]);
      return { label: "omnix-go.service", loaded: true, detail: stdout };
    } catch (error) {
      return { label: "omnix-go.service", loaded: false, detail: String(error) };
    }
  }
  if (process.platform === "win32") {
    const target = servicePath("win32");
    const loaded = await import("node:fs/promises").then(({ access }) =>
      access(target).then(() => true, () => false),
    );
    return {
      label: "OmniX Go user startup",
      loaded,
      detail: loaded ? `Autostart configured at ${target}` : `Missing ${target}`,
    };
  }
  return { label: LABEL, loaded: false, detail: `Unsupported platform: ${process.platform}` };
}
