#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, rotatePairingCode, saveConfig } from "./config.js";
import { ActivityStore } from "./events.js";
import { LocalOAuth } from "./auth.js";
import { createMcpRuntime } from "./mcp.js";
import { startHttpServer } from "./http.js";
import { CloudflareTunnel, prepareManagedCloudflare } from "./cloudflare.js";
import {
  installService,
  serviceStatus,
  uninstallService,
} from "./service.js";

const execFileAsync = promisify(execFile);

interface Options {
  command:
    | "serve"
    | "doctor"
    | "auth-rotate"
    | "config-show"
    | "service-install"
    | "service-uninstall"
    | "service-status";
  host?: string;
  port?: number;
  dataDir?: string;
  publicUrl?: string;
  workspaces: string[];
  tunnel: "off" | "quick" | "managed";
  stdio: boolean;
  open: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: "serve",
    workspaces: [],
    tunnel: "quick",
    stdio: false,
    open: true,
  };
  const args = [...argv];
  if (args[0] === "doctor") {
    options.command = "doctor";
    args.shift();
  } else if (args[0] === "auth" && args[1] === "rotate") {
    options.command = "auth-rotate";
    args.splice(0, 2);
  } else if (args[0] === "config" && args[1] === "show") {
    options.command = "config-show";
    args.splice(0, 2);
  } else if (args[0] === "service" && args[1] === "install") {
    options.command = "service-install";
    args.splice(0, 2);
  } else if (args[0] === "service" && args[1] === "uninstall") {
    options.command = "service-uninstall";
    args.splice(0, 2);
  } else if (args[0] === "service" && args[1] === "status") {
    options.command = "service-status";
    args.splice(0, 2);
  } else if (args[0] === "serve") {
    args.shift();
  }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (flag === "--host" && value) {
      options.host = value;
      index++;
    } else if (flag === "--port" && value) {
      options.port = Number(value);
      index++;
    } else if (flag === "--home" && value) {
      options.dataDir = path.resolve(value);
      index++;
    } else if (flag === "--public-url" && value) {
      options.publicUrl = value;
      index++;
    } else if (flag === "--workspace" && value) {
      options.workspaces.push(path.resolve(value));
      index++;
    } else if (flag === "--tunnel" && ["off", "quick", "managed"].includes(value ?? "")) {
      options.tunnel = value as Options["tunnel"];
      index++;
    } else if (flag === "--stdio") {
      options.stdio = true;
      options.tunnel = "off";
      options.open = false;
    } else if (flag === "--no-open") {
      options.open = false;
    } else if (flag === "--help" || flag === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1)) {
    throw new Error("--port must be a positive integer");
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(`
ChatGPT Code — private local MCP coding harness

Usage:
  chatgpt-code [serve] [options]
  chatgpt-code doctor
  chatgpt-code auth rotate
  chatgpt-code config show
  chatgpt-code service install [--tunnel quick|managed|off]
  chatgpt-code service status
  chatgpt-code service uninstall

Options:
  --workspace <path>       Add an allowed workspace root (repeatable)
  --host <host>            Local bind host (default 127.0.0.1)
  --port <port>            Local port (default 3939)
  --tunnel <mode>          off, quick, or managed (default quick)
  --public-url <url>       Stable public HTTPS MCP origin
  --stdio                   Run as a local stdio MCP server
  --home <path>            Override private state directory
  --no-open                Do not open the local dashboard

Managed Cloudflare:
  CLOUDFLARE_TUNNEL_TOKEN + CHATGPT_CODE_PUBLIC_URL
  or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + CHATGPT_CODE_HOSTNAME
  Optional: CLOUDFLARE_ZONE_ID for automatic DNS.
`);
}

function banner(): void {
  process.stderr.write(`
\x1b[38;2;216;255;95m ██████╗██╗  ██╗ █████╗ ████████╗ ██████╗ ██████╗ ████████╗
██╔════╝██║  ██║██╔══██╗╚══██╔══╝██╔════╝ ██╔══██╗╚══██╔══╝
██║     ███████║███████║   ██║   ██║  ███╗██████╔╝   ██║
██║     ██╔══██║██╔══██║   ██║   ██║   ██║██╔═══╝    ██║
╚██████╗██║  ██║██║  ██║   ██║   ╚██████╔╝██║        ██║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝        ╚═╝\x1b[0m
                     C O D E  /  PRIVATE MCP
`);
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/env", ["which", command]);
    return true;
  } catch {
    return false;
  }
}

async function doctor(cwd: string, dataDir?: string): Promise<void> {
  const loaded = await loadConfig({ cwd, ...(dataDir ? { dataDir } : {}) });
  const checks = [
    ["Node.js >= 20", Number(process.versions.node.split(".")[0]) >= 20, process.version],
    ["Codex CLI", await commandExists("codex"), "required for subagents"],
    ["cloudflared", await commandExists("cloudflared"), "required for public HTTPS"],
    ["Git", await commandExists("git"), "required for diff/patch"],
    ["macOS screencapture", process.platform === "darwin" && await commandExists("screencapture"), "computer screenshots"],
    ["Config readable", await access(loaded.configPath).then(() => true, () => false), loaded.configPath],
  ] as const;
  for (const [name, passed, detail] of checks) {
    process.stdout.write(`${passed ? "✓" : "✗"} ${name.padEnd(24)} ${detail}\n`);
  }
  if (loaded.pairingCode) {
    process.stdout.write("\nA new pairing code was generated; run chatgpt-code to display it.\n");
  }
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  const options = parseArgs(rawArguments);
  const cwd = process.cwd();
  if (options.command === "doctor") {
    await doctor(cwd, options.dataDir);
    return;
  }
  const loaded = await loadConfig({
    cwd,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.workspaces.length === 0 ? {} : { workspaceRoots: options.workspaces }),
  });
  const { config, configPath } = loaded;

  if (options.command === "auth-rotate") {
    const code = await rotatePairingCode(config, configPath);
    process.stdout.write(`New pairing code: ${code}\n`);
    return;
  }
  if (options.command === "config-show") {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...config,
          dashboardToken: "[redacted]",
          pairingSecretHash: "[redacted]",
          jwtPrivateJwk: "[redacted]",
          upstreams: config.upstreams.map((upstream) => ({
            ...upstream,
            ...(upstream.headers
              ? {
                  headers: Object.fromEntries(
                    Object.keys(upstream.headers).map((key) => [key, "[redacted]"]),
                  ),
                }
              : {}),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (options.command === "service-install") {
    if (options.tunnel === "managed") {
      const managed = await prepareManagedCloudflare(config.dataDir);
      if (!managed.configured) {
        throw new Error(
          "Permanent Cloudflare setup is missing. Provide CLOUDFLARE_TUNNEL_TOKEN plus CHATGPT_CODE_PUBLIC_URL, or CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CHATGPT_CODE_HOSTNAME, and optionally CLOUDFLARE_ZONE_ID for this one installation command.",
        );
      }
    }
    const result = await installService({
      config,
      tunnel: options.tunnel,
      cliPath: path.resolve(process.argv[1]!),
    });
    process.stdout.write(`Installed and started ${result.path}\n`);
    return;
  }
  if (options.command === "service-uninstall") {
    const result = await uninstallService();
    process.stdout.write(`Stopped and removed ${result.path}\n`);
    return;
  }
  if (options.command === "service-status") {
    const result = await serviceStatus();
    process.stdout.write(
      `${result.loaded ? "running" : "not loaded"}: ${result.label}\n${result.detail}\n`,
    );
    return;
  }

  if (rawArguments.length === 0) {
    const existingService = await fetch(
      `http://${config.host}:${config.port}/health`,
    ).catch(() => undefined);
    if (existingService?.ok) {
      const current = await loadConfig({
        cwd,
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      });
      const code = await rotatePairingCode(current.config, current.configPath);
      banner();
      process.stderr.write(
        `\n  Service status    \x1b[38;2;216;255;95mRUNNING\x1b[0m\n` +
          `  Local MCP         http://${current.config.host}:${current.config.port}/mcp\n`,
      );
      if (current.config.publicUrl) {
        process.stderr.write(
          `  Public MCP        \x1b[38;2;216;255;95m${current.config.publicUrl.replace(/\/+$/, "")}/mcp\x1b[0m\n`,
        );
      }
      process.stderr.write(
        `\n  \x1b[38;2;255;159;67mPAIRING CODE\x1b[0m      \x1b[1m${code}\x1b[0m\n` +
          "  The running service accepted this new code immediately.\n",
      );
      return;
    }
  }

  if (
    options.tunnel === "quick" &&
    !options.publicUrl &&
    !process.env.CHATGPT_CODE_PUBLIC_URL
  ) {
    delete config.publicUrl;
  }

  const events = new ActivityStore();
  const persist = () => saveConfig(config, configPath);
  const runtime = await createMcpRuntime({ config, events, persist });

  if (options.stdio) {
    await runtime.server.connect(new StdioServerTransport());
    await runtime.upstreams.restore();
    return;
  }

  banner();
  const oauth = new LocalOAuth(config, events);
  await oauth.initialize();
  const httpServer = await startHttpServer({ config, runtime, oauth, events });
  await runtime.upstreams.restore();
  const localDashboard = `http://${config.host}:${config.port}/?token=${encodeURIComponent(config.dashboardToken)}`;
  process.stderr.write(`\n  Local dashboard  \x1b[36m${localDashboard}\x1b[0m\n`);
  process.stderr.write(`  Local MCP        http://${config.host}:${config.port}/mcp\n`);
  process.stderr.write(`  Legacy SSE       http://${config.host}:${config.port}/sse\n`);
  if (loaded.pairingCode) {
    process.stderr.write(
      `\n  \x1b[38;2;255;159;67mPAIRING CODE\x1b[0m     \x1b[1m${loaded.pairingCode}\x1b[0m\n` +
        "  Enter this code in the OAuth page when ChatGPT connects.\n",
    );
  } else {
    process.stderr.write(
      "\n  Pairing code already initialized. Run `chatgpt-code auth rotate` to issue a new one.\n",
    );
  }

  const tunnel = new CloudflareTunnel(config, events, persist);
  if (options.tunnel !== "off") {
    try {
      const result = await tunnel.start(options.tunnel);
      if (result.publicUrl) {
        process.stderr.write(
          `\n  Public MCP       \x1b[38;2;216;255;95m${result.publicUrl}/mcp\x1b[0m\n` +
            `  Legacy SSE       ${result.publicUrl}/sse\n` +
            `  OAuth metadata   ${result.publicUrl}/.well-known/oauth-protected-resource/mcp\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`\n  \x1b[31mCloudflare tunnel failed:\x1b[0m ${String(error)}\n`);
      process.stderr.write("  Local service is still running. Retry with `--tunnel quick` or check `chatgpt-code doctor`.\n");
    }
  }

  if (options.open && process.platform === "darwin") {
    await execFileAsync("open", [localDashboard]).catch(() => undefined);
  }

  const shutdown = () => {
    tunnel.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`chatgpt-code: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
