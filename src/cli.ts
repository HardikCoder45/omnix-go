#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, saveConfig } from "./config.js";
import { ActivityStore } from "./events.js";
import { LocalOAuth, createPairingCode, pairingCodeHash } from "./auth.js";
import { createMcpRuntime } from "./mcp.js";
import { detectDefaultBrowser } from "./chatgpt-browser.js";
import { startHttpServer } from "./http.js";
import { authenticateWithOmnix, checkGatewayNameAvailability, fetchCurrentGateway, GatewayTunnel, provisionGateway, readGatewaySettings, resolveGatewayName, type DesktopSession } from "./gateway.js";
import { dependencyStatus } from "./dependencies.js";
import {
  installService,
  serviceStatus,
  uninstallService,
} from "./service.js";

const execFileAsync = promisify(execFile);

interface Options {
  command:
    | "serve"
    | "server"
    | "doctor"
    | "gateway-provision"
    | "config-show"
    | "service-install"
    | "service-uninstall"
    | "service-status"
    | "auth-rotate"
    | "dashboard"
    | "approvals"
    | "whatsapp"
    | "workflow-list"
    | "workflow-create"
    | "workflow-run"
    | "workflow-delete"
    | "cron-list"
    | "cron-create"
    | "cron-pause"
    | "cron-resume"
    | "cron-run"
    | "cron-delete";
  host?: string;
  port?: number;
  dataDir?: string;
  publicUrl?: string;
  gatewayName?: string;
  workspaces: string[];
  tunnel: "off" | "gateway" | "auto";
  stdio: boolean;
  open: boolean;
  targetId?: string;
  file?: string;
  workflowId?: string;
  schedule?: string;
  scheduleName?: string;
  timezone?: string;
  input?: Record<string, unknown>;
  overlapPolicy?: "skip" | "parallel";
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: "serve",
    workspaces: [],
    tunnel: "auto",
    stdio: false,
    open: true,
  };
  const args = [...argv];
  if (args[0] === "doctor") {
    options.command = "doctor";
    args.shift();
  } else if (args[0] === "gateway" && args[1] === "provision") {
    options.command = "gateway-provision";
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
  } else if (args[0] === "auth" && args[1] === "rotate") {
    options.command = "auth-rotate";
    args.splice(0, 2);
  } else if (args[0] === "dashboard") {
    options.command = "dashboard";
    args.shift();
  } else if (args[0] === "approvals") {
    options.command = "approvals";
    args.shift();
  } else if (args[0] === "whatsapp") {
    options.command = "whatsapp";
    args.shift();
  } else if (args[0] === "server") {
    options.command = "server";
    options.open = false;
    args.shift();
  } else if (args[0] === "workflow" && ["list", "create", "run", "delete"].includes(args[1] ?? "")) {
    const action = args[1]! as "list" | "create" | "run" | "delete";
    options.command = `workflow-${action}`;
    args.splice(0, 2);
    if ((action === "run" || action === "delete") && args[0] && !args[0]!.startsWith("-")) {
      options.targetId = args.shift();
    }
  } else if (args[0] === "cron" && ["list", "create", "pause", "resume", "run", "delete"].includes(args[1] ?? "")) {
    const action = args[1]! as "list" | "create" | "pause" | "resume" | "run" | "delete";
    options.command = `cron-${action}`;
    args.splice(0, 2);
    if (["pause", "resume", "run", "delete"].includes(action) && args[0] && !args[0]!.startsWith("-")) {
      options.targetId = args.shift();
    }
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
    } else if (flag === "--name" && value) {
      options.gatewayName = value;
      index++;
    } else if (flag === "--workspace" && value) {
      options.workspaces.push(path.resolve(value));
      index++;
    } else if (flag === "--file" && value) {
      options.file = path.resolve(value);
      index++;
    } else if (flag === "--workflow" && value) {
      options.workflowId = value;
      index++;
    } else if (flag === "--schedule" && value) {
      options.schedule = value;
      index++;
    } else if (flag === "--label" && value) {
      options.scheduleName = value;
      index++;
    } else if (flag === "--timezone" && value) {
      options.timezone = value;
      index++;
    } else if (flag === "--input" && value) {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input must be a JSON object");
      options.input = parsed as Record<string, unknown>;
      index++;
    } else if (flag === "--overlap" && ["skip", "parallel"].includes(value ?? "")) {
      options.overlapPolicy = value as "skip" | "parallel";
      index++;
    } else if (
      flag === "--tunnel" &&
      ["off", "gateway", "auto"].includes(value ?? "")
    ) {
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
  if (options.command === "server" && options.stdio) throw new Error("Use `omnix-go serve --stdio` for stdio MCP.");
  return options;
}

function printHelp(): void {
  process.stdout.write(`
OmniX Go — private local MCP coding harness

Usage:
  omnix-go [serve] [options]
  omnix-go server [--name <permanent-name>] [--tunnel auto|gateway|off]
  omnix-go --name <permanent-name>
  omnix-go doctor
  omnix-go gateway provision --name <permanent-name>
  omnix-go auth rotate
  omnix-go config show
  omnix-go service install [--tunnel auto|gateway|off]
  omnix-go service status
  omnix-go service uninstall
  omnix-go dashboard
  omnix-go approvals [--no-open]
  omnix-go whatsapp [--no-open]
  omnix-go workflow list
  omnix-go workflow create --file workflow.json
  omnix-go workflow run <workflow-id> [--input '{"key":"value"}']
  omnix-go workflow delete <workflow-id>
  omnix-go cron list
  omnix-go cron create --label "Hourly review" --workflow <id> --schedule "@hourly" [--timezone Asia/Kolkata]
  omnix-go cron pause|resume|run|delete <schedule-id>

Options:
  --workspace <path>       Add an allowed workspace root (repeatable)
  --host <host>            Local bind host (default 127.0.0.1)
  --port <port>            Local port (default 8111)
  --tunnel <mode>          off, gateway, or auto (default auto)
  --name <name>            Choose/provision the permanent <name>.omnix.work gateway
  --public-url <url>       Development override; gateway URL is normally automatic
  --stdio                   Run as a local stdio MCP server
  --home <path>            Override private state directory
  --no-open                Do not open the local dashboard
  --file <json>            Workflow graph JSON for workflow create
  --workflow <id>          Workflow ID for cron create
  --schedule <cron>        Cron expression or @hourly/@daily shorthand
  --label <name>           Human-readable cron name
  --timezone <iana>        Schedule timezone (default system timezone)
  --input <json>           Workflow input JSON object
  --overlap <policy>       skip or parallel (default skip)

Optional environment:
  OMNIX_GO_BROWSER         macOS browser app name for the authentication window

Gateway setup signs in through https://auth.omnix.work using PKCE, provisions the
permanent hostname through https://server.omnix.work, and stores only the scoped
connector token locally. Cloudflare account, zone, and API keys are never accepted.
There is no random public URL fallback.
Use \`omnix-go server\` to print a browser sign-in link and run in the foreground.

New ChatGPT connections require both verified owner sign-in at auth.omnix.work and a
pairing code shown only in this computer's terminal. Use \`omnix-go auth rotate\` to
issue a new code and invalidate the old one.

A global npm installation creates the per-user login service automatically. Set
OMNIX_GO_SKIP_AUTO_SERVICE=1 only when packaging or running in CI.
`);
}

function banner(): void {
  process.stderr.write(`
\x1b[38;2;25;121;255m  ╭──────────────────────────────╮\x1b[0m
\x1b[38;2;0;215;238m  │  ◜───────────────◝  ◜──◝    │\x1b[0m
\x1b[38;2;25;121;255m  │  │  ●       ●    │  ╰──╯    │\x1b[0m
\x1b[38;2;0;215;238m  │  ╰───────╮───────╯          │\x1b[0m
\x1b[38;2;25;121;255m  │          ╰──  OMNIX GO      │\x1b[0m
\x1b[38;2;86;255;202m  ╰──────── PRIVATE MCP ────────╯\x1b[0m
`);
}

const tint = {
  reset: "\x1b[0m",
  cobalt: "\x1b[38;2;25;121;255m",
  cyan: "\x1b[38;2;0;215;238m",
  mint: "\x1b[38;2;86;255;202m",
  text: "\x1b[38;2;235;245;255m",
  muted: "\x1b[38;2;139;166;204m",
  warning: "\x1b[38;2;255;190;92m",
};

function directMcpUrl(config: { host: string; port: number; publicUrl?: string }): string {
  return config.publicUrl
    ? `${config.publicUrl.replace(/\/+$/, "")}/mcp`
    : `http://${config.host}:${config.port}/mcp`;
}

function minimalConnectionOutput(config: { host: string; port: number; publicUrl?: string }, pairingCode: string): string {
  return `\n${tint.cyan}\x1b[1mOMNIX${tint.mint} GO\x1b[22m${tint.reset}\n` +
    `${tint.cyan}${directMcpUrl(config)}${tint.reset}\n` +
    `${tint.mint}${pairingCode}${tint.reset}\n`;
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === "darwin") await execFileAsync("open", [url]);
  else if (process.platform === "win32") await execFileAsync("cmd", ["/c", "start", "", url]);
  else await execFileAsync("xdg-open", [url]);
}

async function localDashboardApi<T>(
  config: { host: string; port: number; dashboardToken: string },
  pathname: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${localHttpOrigin(config)}${pathname}`, {
    method,
    headers: {
      "X-Omnix-Dashboard-Token": config.dashboardToken,
      ...(method === "GET" ? {} : { "X-Omnix-Action": "1" }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((error) => {
    throw new Error(`OmniX Go is not reachable. Start it with \`omnix-go server\` or \`omnix-go service install\`. ${String(error)}`);
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Dashboard API returned HTTP ${response.status}`);
  return result;
}

function localHttpOrigin(config: { host: string; port: number }): string {
  const host = config.host === "0.0.0.0" ? "127.0.0.1"
    : config.host === "::" || config.host === "::1" ? "[::1]" : config.host;
  return `http://${host}:${config.port}`;
}

function sshForward(port: number): string {
  return `ssh -N -L 127.0.0.1:${port}:127.0.0.1:${port} user@server`;
}

async function presentServerSignIn(url: string, port: number, signal: AbortSignal): Promise<string | undefined> {
  process.stdout.write(`\nOpen this sign-in link in a browser on your computer:\n${url}\n\n` +
    `For automatic completion, first run this in a second terminal on your computer (replace user@server):\n${sshForward(port)}\n\n`);
  if (!process.stdin.isTTY) return undefined;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question("Without SSH forwarding, paste the full 127.0.0.1 URL from the browser address bar after signing in: ", { signal });
  } finally {
    terminal.close();
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/env", ["which", command]);
    return true;
  } catch {
    return false;
  }
}

function suggestedGatewayName(session: DesktopSession): string {
  const emailPrefix = String(session.user.email ?? "").split("@")[0] ?? "";
  const normalized = emailPrefix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return normalized || `omnix-${session.user.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
}

async function promptGatewayName(suggestion: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This account has no gateway yet. Pass `--name <name>` to choose one.");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(`Choose your permanent gateway name [${suggestion}]: `)).trim();
    return answer || suggestion;
  } finally {
    terminal.close();
  }
}

async function authenticateAndProvision(input: {
  config: Awaited<ReturnType<typeof loadConfig>>["config"];
  configPath: string;
  requestedName?: string;
  headless?: boolean;
}): Promise<{ gatewayUrl: string; pairingCode: string }> {
  if (!input.headless) process.stdout.write("Opening auth.omnix.work for verified sign-in…\n");
  const session = await authenticateWithOmnix(input.headless ? { presentLink: presentServerSignIn } : {});
  const assigned = await fetchCurrentGateway(session.accessToken);
  const selected = resolveGatewayName(input.requestedName, assigned?.gatewayName);
  let gatewayName = selected;
  while (!gatewayName) {
    const candidate = await promptGatewayName(suggestedGatewayName(session));
    const availability = await checkGatewayNameAvailability(session.accessToken, candidate);
    if (availability.available) gatewayName = availability.gatewayName;
    else process.stdout.write(`${availability.hostname} is already registered or hosted. Choose another name.\n`);
  }
  const availability = await checkGatewayNameAvailability(session.accessToken, gatewayName);
  if (!availability.available) {
    throw new Error(`${availability.hostname} is already registered or has hosted DNS configuration.`);
  }
  process.stdout.write(
    availability.ownedByRequester
      ? `Verified your permanent gateway: ${availability.hostname}\n`
      : `Gateway name available: ${availability.hostname}\n`,
  );
  const gateway = await provisionGateway({
    dataDir: input.config.dataDir,
    gatewayName,
    identityToken: session.accessToken,
    expectedOwnerUserId: session.user.id,
  });
  input.config.publicUrl = gateway.goUrl;
  input.config.gatewayName = gateway.gatewayName;
  input.config.gatewayOwnerUserId = gateway.ownerUserId;
  const pairingCode = createPairingCode();
  input.config.pairingSecretHash = pairingCodeHash(pairingCode);
  await saveConfig(input.config, input.configPath);
  return { gatewayUrl: `${gateway.goUrl}/mcp`, pairingCode };
}

async function doctor(cwd: string, dataDir?: string): Promise<void> {
  const loaded = await loadConfig({ cwd, ...(dataDir ? { dataDir } : {}) });
  const dependencies = await dependencyStatus(loaded.config.dataDir);
  const defaultBrowser = await detectDefaultBrowser().then(
    (browser) => ({ passed: true, detail: `${browser.name} (${browser.bundleId})` }),
    (error: unknown) => ({
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
  const checks = [
    ["Node.js >= 20", Number(process.versions.node.split(".")[0]) >= 20, process.version],
    ["Default browser", defaultBrowser.passed, defaultBrowser.detail],
    [
      "macOS osascript",
      process.platform === "darwin" && await commandExists("osascript"),
      "required for default-browser tab and ChatGPT page automation",
    ],
    [
      "Gateway connector runtime",
      dependencies.installed,
      dependencies.installed
        ? dependencies.cloudflared
        : "installed automatically by `omnix-go service install`",
    ],
    ["Git", await commandExists("git"), "required for diff/patch"],
    ["macOS screencapture", process.platform === "darwin" && await commandExists("screencapture"), "computer screenshots"],
    ["Config readable", await access(loaded.configPath).then(() => true, () => false), loaded.configPath],
  ] as const;
  for (const [name, passed, detail] of checks) {
    process.stdout.write(`${passed ? "✓" : "✗"} ${name.padEnd(24)} ${detail}\n`);
  }
  const gateway = await readGatewaySettings(loaded.config.dataDir);
  process.stdout.write(`${gateway ? "✓" : "✗"} ${"Authenticated gateway".padEnd(24)} ${gateway?.goUrl ?? "run `omnix-go gateway provision --name <name>`"}\n`);
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

  if (options.command === "dashboard") {
    const session = await localDashboardApi<{ url: string }>(config, "/api/dashboard/session", "POST");
    process.stdout.write(`${session.url}\n`);
    if (options.open) await openUrl(session.url).catch(() => undefined);
    return;
  }
  if (options.command === "approvals") {
    const session = await localDashboardApi<{ url: string }>(config, "/api/dashboard/session", "POST", { local: true, page: "approvals" });
    process.stdout.write(`${session.url}\n`);
    if (options.open) await openUrl(session.url).catch(() => undefined);
    return;
  }
  if (options.command === "whatsapp") {
    const session = await localDashboardApi<{ url: string }>(config, "/api/dashboard/session", "POST", { local: true, page: "whatsapp" });
    process.stdout.write(`${session.url}\n`);
    if (options.open) await openUrl(session.url).catch(() => undefined);
    return;
  }
  if (options.command === "workflow-list") {
    const state = await localDashboardApi<{ workflows: unknown[] }>(config, "/api/state");
    process.stdout.write(`${JSON.stringify(state.workflows, null, 2)}\n`);
    return;
  }
  if (options.command === "workflow-create") {
    if (!options.file) throw new Error("workflow create requires --file <workflow.json>");
    const workflow = JSON.parse(await readFile(options.file, "utf8")) as unknown;
    const result = await localDashboardApi(config, "/api/workflows", "POST", workflow);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "workflow-run") {
    if (!options.targetId) throw new Error("workflow run requires <workflow-id>");
    const result = await localDashboardApi(config, `/api/workflows/${encodeURIComponent(options.targetId)}/run`, "POST", { input: options.input ?? {} });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "workflow-delete") {
    if (!options.targetId) throw new Error("workflow delete requires <workflow-id>");
    const result = await localDashboardApi(config, `/api/workflows/${encodeURIComponent(options.targetId)}`, "DELETE");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "cron-list") {
    const state = await localDashboardApi<{ schedules: unknown[] }>(config, "/api/state");
    process.stdout.write(`${JSON.stringify(state.schedules, null, 2)}\n`);
    return;
  }
  if (options.command === "cron-create") {
    if (!options.workflowId || !options.schedule) {
      throw new Error("cron create requires --workflow <id> and --schedule <cron|@hourly>");
    }
    const result = await localDashboardApi(config, "/api/crons", "POST", {
      name: options.scheduleName ?? `Schedule ${options.workflowId.slice(0, 8)}`,
      workflowId: options.workflowId,
      cron: options.schedule,
      timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      overlapPolicy: options.overlapPolicy ?? "skip",
      input: options.input ?? {},
      enabled: true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (["cron-pause", "cron-resume", "cron-run", "cron-delete"].includes(options.command)) {
    if (!options.targetId) throw new Error(`${options.command.replace("cron-", "cron ")} requires <schedule-id>`);
    const id = encodeURIComponent(options.targetId);
    const result = options.command === "cron-run"
      ? await localDashboardApi(config, `/api/crons/${id}/run`, "POST")
      : options.command === "cron-delete"
        ? await localDashboardApi(config, `/api/crons/${id}`, "DELETE")
        : await localDashboardApi(config, `/api/crons/${id}/toggle`, "POST", { enabled: options.command === "cron-resume" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const existingGateway = await readGatewaySettings(config.dataDir);
  const server = options.command === "server";
  const serverGateway = server && options.tunnel !== "off";
  if (options.tunnel === "auto") options.tunnel = existingGateway ? "gateway" : "off";

  let serverPairingCode: string | undefined;
  if (server) {
    const running = await fetch(`${localHttpOrigin(config)}/health`, { signal: AbortSignal.timeout(2_000) })
      .then(async (response) => response.ok && (await response.json())?.name === "omnix-go")
      .catch(() => false);
    if (running) throw new Error(`OmniX Go is already running on port ${config.port}. Stop that instance before starting server mode (\`omnix-go service uninstall\` for the installed user service).`);
    if (serverGateway) {
      options.tunnel = "gateway";
      if (!existingGateway || options.gatewayName) {
        const result = await authenticateAndProvision({
          config, configPath, headless: true,
          ...(options.gatewayName ? { requestedName: options.gatewayName } : {}),
        });
        serverPairingCode = result.pairingCode;
      } else if (!config.pairingSecretHash) {
        serverPairingCode = createPairingCode();
        config.pairingSecretHash = pairingCodeHash(serverPairingCode);
        await saveConfig(config, configPath);
      }
    }
  }

  if (options.command === "gateway-provision" || (options.command === "serve" && options.gatewayName)) {
    const result = await authenticateAndProvision({
      config,
      configPath,
      ...(options.gatewayName ? { requestedName: options.gatewayName } : {}),
    });
    const service = await installService({ config, tunnel: "gateway", cliPath: path.resolve(process.argv[1]!) });
    process.stdout.write(`Authenticated gateway ready: ${result.gatewayUrl}\nService installed at ${service.path}\nPairing code: ${result.pairingCode}\n`);
    return;
  }
  if (options.command === "config-show") {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...config,
          dashboardToken: "[redacted]",
          ...(config.pairingSecretHash ? { pairingSecretHash: "[legacy-redacted]" } : {}),
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
  if (options.command === "auth-rotate") {
    const pairingCode = createPairingCode();
    config.pairingSecretHash = pairingCodeHash(pairingCode);
    await saveConfig(config, configPath);
    process.stdout.write(minimalConnectionOutput(config, pairingCode));
    return;
  }
  if (options.command === "service-install") {
    if (options.tunnel !== "off" && !existingGateway) {
      throw new Error("No authenticated gateway exists. Run `omnix-go gateway provision --name <name>` first.");
    }
    // A service is reconstructed from config on subsequent plain `omnix-go`
    // runs, so a workspace supplied here must survive beyond this invocation.
    if (options.workspaces.length > 0) await saveConfig(config, configPath);
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
      const pairingCode = createPairingCode();
      current.config.pairingSecretHash = pairingCodeHash(pairingCode);
      await saveConfig(current.config, current.configPath);
      process.stderr.write(minimalConnectionOutput(current.config, pairingCode));
      return;
    }
    if (!existingGateway) {
      const provisioned = await authenticateAndProvision({
        config,
        configPath,
      });
      await installService({ config, tunnel: "gateway", cliPath: path.resolve(process.argv[1]!) });
      process.stderr.write(minimalConnectionOutput(config, provisioned.pairingCode));
      return;
    }
    const result = await installService({
      config,
      tunnel: options.tunnel,
      cliPath: path.resolve(process.argv[1]!),
    });
    process.stderr.write(
      `OmniX Go installed its dependencies and started the per-user service at ${result.path}.\n` +
        "Run `omnix-go` again to show the connection URLs.\n",
    );
    return;
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
  if (server) void runtime.upstreams.restore();
  else await runtime.upstreams.restore();
  let localDashboard: string | undefined;
  if (server) {
    process.stdout.write(`OmniX Go is listening on ${localHttpOrigin(config)}.\n` +
      `For MCP pairing and the private dashboards, forward port ${config.port} from your computer:\n${sshForward(config.port)}\n` +
      "Run `omnix-go whatsapp --no-open` or `omnix-go approvals --no-open` on the server for a private link.\n");
    if (serverPairingCode) process.stdout.write(`Pairing code: ${serverPairingCode}\n`);
  } else {
    const dashboardSession = await localDashboardApi<{ url: string }>(config, "/api/dashboard/session", "POST");
    localDashboard = dashboardSession.url;
    process.stderr.write(`${tint.muted}  Dashboard         ${tint.cyan}${localDashboard}${tint.reset}\n`);
  }

  const tunnel = new GatewayTunnel(config, events);
  if (options.tunnel === "gateway") {
    try {
      const result = await tunnel.start();
      if (result.publicUrl) {
        process.stderr.write(
          `${tint.mint}\n  ● Gateway online${tint.reset}  ${tint.cyan}${result.publicUrl}/mcp${tint.reset}\n` +
            `${tint.muted}  OAuth metadata   ${result.publicUrl}/.well-known/oauth-protected-resource/mcp${tint.reset}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`\n  \x1b[31mOmniX gateway failed:\x1b[0m ${String(error)}\n`);
      process.stderr.write("  Local service is still running. Re-provision the gateway or run `omnix-go doctor`.\n");
    }
  }

  if (options.open && localDashboard) {
    await openUrl(localDashboard).catch(() => undefined);
  }

  const shutdown = () => {
    tunnel.stop();
    runtime.automations.stop();
    void runtime.whatsapp.stop().finally(() => httpServer.close(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`omnix-go: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
