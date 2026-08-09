import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:http";
import type { Readable } from "node:stream";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ActivityStore } from "./events.js";
import type { AppConfig } from "./types.js";
import { ensureCloudflared } from "./dependencies.js";
import { ensureDir } from "./utils.js";

const execFileAsync = promisify(execFile);
export const AUTH_ORIGIN = "https://auth.omnix.work";
export const SERVER_ORIGIN = "https://server.omnix.work";
export const DESKTOP_CLIENT_ID = "omnix-desktop";
export const DESKTOP_REDIRECT_URI = "omnix://auth/callback";

export interface OmnixIdentity {
  id: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface DesktopSession {
  accessToken: string;
  user: OmnixIdentity;
}

export interface GatewaySettings {
  gatewayName: string;
  hostname: string;
  gatewayUrl: string;
  goUrl: string;
  tunnelId: string;
  ownerUserId: string;
  firebaseProjectId?: string;
  permanent: true;
}

export interface AccountGateway {
  gatewayName: string;
  gatewayUrl?: string;
  goUrl?: string;
}

export interface GatewayAvailability {
  gatewayName: string;
  hostname: string;
  available: boolean;
  ownedByRequester: boolean;
  reason: "available" | "assigned_to_requester" | "registered" | "hostname_in_use" | string;
}

interface GatewayProvisionResponse extends GatewaySettings {
  ok: true;
  tunnelToken: string;
}

function settingsPath(dataDir: string): string {
  return path.join(dataDir, "gateway.json");
}

export function gatewayTokenPath(dataDir: string): string {
  return path.join(dataDir, "gateway-token");
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function validGatewayName(name: string): boolean {
  return /^(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

function validateSettings(value: unknown): GatewaySettings {
  const candidate = value as Partial<GatewaySettings>;
  if (
    !candidate ||
    !validGatewayName(String(candidate.gatewayName ?? "")) ||
    candidate.hostname !== `${candidate.gatewayName}.omnix.work` ||
    candidate.gatewayUrl !== `https://${candidate.hostname}` ||
    candidate.goUrl !== `${candidate.gatewayUrl}/go` ||
    !candidate.tunnelId ||
    !candidate.ownerUserId ||
    candidate.permanent !== true
  ) {
    throw new Error("The OmniX gateway response was invalid.");
  }
  return {
    gatewayName: String(candidate.gatewayName),
    hostname: String(candidate.hostname),
    gatewayUrl: String(candidate.gatewayUrl),
    goUrl: String(candidate.goUrl),
    tunnelId: String(candidate.tunnelId),
    ownerUserId: String(candidate.ownerUserId),
    ...(candidate.firebaseProjectId ? { firebaseProjectId: String(candidate.firebaseProjectId) } : {}),
    permanent: true,
  };
}

export async function readGatewaySettings(dataDir: string): Promise<GatewaySettings | undefined> {
  try {
    return validateSettings(JSON.parse(await readFile(settingsPath(dataDir), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writePrivateFile(target: string, value: string): Promise<void> {
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export function createDesktopAuthorization(loopbackUri: string): {
  url: string;
  state: string;
  verifier: string;
} {
  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(64));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("/desktop", AUTH_ORIGIN);
  url.searchParams.set("client_id", DESKTOP_CLIENT_ID);
  url.searchParams.set("redirect_uri", DESKTOP_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("loopback_uri", loopbackUri);
  return { url: url.toString(), state, verifier };
}

export async function exchangeDesktopCode(code: string, verifier: string): Promise<DesktopSession> {
  const response = await fetch(`${AUTH_ORIGIN}/api/desktop/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientId: DESKTOP_CLIENT_ID,
      redirectUri: DESKTOP_REDIRECT_URI,
      code,
      codeVerifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    accessToken?: unknown;
    user?: Partial<OmnixIdentity>;
    error?: unknown;
  };
  if (!response.ok || typeof payload.accessToken !== "string" || !payload.user?.id) {
    throw new Error(typeof payload.error === "string" ? payload.error : "OmniX authentication failed.");
  }
  return { accessToken: payload.accessToken, user: payload.user as OmnixIdentity };
}

async function openBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    const preferred = String(process.env.OMNIX_GO_BROWSER ?? "").trim();
    if (/^[\p{L}\p{N} ._-]{1,80}$/u.test(preferred)) await execFileAsync("open", ["-a", preferred, url]);
    else await execFileAsync("open", [url]);
  }
  else if (process.platform === "win32") await execFileAsync("cmd", ["/c", "start", "", url]);
  else await execFileAsync("xdg-open", [url]);
}

export async function authenticateWithOmnix(): Promise<DesktopSession> {
  let settle: ((value: { code: string; state: string }) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/auth/callback") {
      response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Not found");
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    response.writeHead(code ? 200 : 400, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(code
      ? "<!doctype html><title>OmniX Go connected</title><body style='font:16px system-ui;padding:40px;background:#0b0d0c;color:#e9eadf'><h1>OmniX Go connected</h1><p>You can close this tab and return to the terminal.</p></body>"
      : "<!doctype html><title>Authentication failed</title><p>Authentication failed.</p>");
    if (code) settle?.({ code, state });
    else fail?.(new Error("The OmniX callback did not contain an authorization code."));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not create the loopback callback.");
    const loopback = `http://127.0.0.1:${address.port}/auth/callback`;
    const authorization = createDesktopAuthorization(loopback);
    await openBrowser(authorization.url);
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OmniX sign-in timed out.")), 5 * 60 * 1000);
      timer.unref();
    });
    const result = await Promise.race([callback, timeout]);
    if (result.state !== authorization.state) throw new Error("OmniX authentication state did not match.");
    return await exchangeDesktopCode(result.code, authorization.verifier);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function provisionGateway(input: {
  dataDir: string;
  gatewayName: string;
  identityToken: string;
  expectedOwnerUserId: string;
}): Promise<GatewaySettings> {
  const gatewayName = input.gatewayName.trim().toLowerCase();
  if (!validGatewayName(gatewayName)) throw new Error("Gateway names use lowercase letters, numbers, and hyphens only.");
  const response = await fetch(`${SERVER_ORIGIN}/api/gateways/provision`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.identityToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ gatewayName }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as Partial<GatewayProvisionResponse> & { error?: string };
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || `Gateway provisioning failed (${response.status}).`);
  const settings = validateSettings(payload);
  if (settings.ownerUserId !== input.expectedOwnerUserId) throw new Error("The gateway owner did not match the signed-in user.");
  if (typeof payload.tunnelToken !== "string" || payload.tunnelToken.length < 32) throw new Error("The gateway did not return a valid connector token.");
  await writePrivateFile(gatewayTokenPath(input.dataDir), `${payload.tunnelToken}\n`);
  await writePrivateFile(settingsPath(input.dataDir), `${JSON.stringify(settings, null, 2)}\n`);
  await unlink(path.join(input.dataDir, "cloudflare-managed.json")).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  });
  return settings;
}

export async function fetchCurrentGateway(identityToken: string): Promise<AccountGateway | undefined> {
  const response = await fetch(`${SERVER_ORIGIN}/api/gateways/current`, {
    headers: { Authorization: `Bearer ${identityToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    ok?: boolean;
    gateway?: Partial<AccountGateway> | null;
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Gateway lookup failed (${response.status}).`);
  }
  if (!payload.gateway) return undefined;
  const gatewayName = String(payload.gateway.gatewayName ?? "").trim().toLowerCase();
  if (!validGatewayName(gatewayName)) throw new Error("The assigned OmniX gateway name was invalid.");
  return {
    gatewayName,
    ...(typeof payload.gateway.gatewayUrl === "string" ? { gatewayUrl: payload.gateway.gatewayUrl } : {}),
    ...(typeof payload.gateway.goUrl === "string" ? { goUrl: payload.gateway.goUrl } : {}),
  };
}

export function resolveGatewayName(
  requestedName: string | undefined,
  assignedName: string | undefined,
): string | undefined {
  const requested = requestedName?.trim().toLowerCase();
  const assigned = assignedName?.trim().toLowerCase();
  if (requested && !validGatewayName(requested)) {
    throw new Error("Gateway names use lowercase letters, numbers, and hyphens only.");
  }
  if (assigned && !validGatewayName(assigned)) {
    throw new Error("The assigned OmniX gateway name was invalid.");
  }
  if (requested && assigned && requested !== assigned) {
    throw new Error(
      `This account is permanently assigned to ${assigned}.omnix.work. Use --name ${assigned}.`,
    );
  }
  return requested ?? assigned;
}

export async function checkGatewayNameAvailability(
  identityToken: string,
  gatewayName: string,
): Promise<GatewayAvailability> {
  const normalized = resolveGatewayName(gatewayName, undefined);
  if (!normalized) throw new Error("A gateway name is required.");
  const url = new URL(`${SERVER_ORIGIN}/api/gateways/availability`);
  url.searchParams.set("gatewayName", normalized);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${identityToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as Partial<GatewayAvailability> & {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || payload.ok === false || typeof payload.available !== "boolean") {
    throw new Error(payload.error || `Gateway availability check failed (${response.status}).`);
  }
  if (payload.gatewayName !== normalized || payload.hostname !== `${normalized}.omnix.work`) {
    throw new Error("The gateway availability response did not match the requested hostname.");
  }
  return {
    gatewayName: normalized,
    hostname: payload.hostname,
    available: payload.available,
    ownedByRequester: payload.ownedByRequester === true,
    reason: String(payload.reason || (payload.available ? "available" : "hostname_in_use")),
  };
}

export class GatewayTunnel {
  private process?: ChildProcessByStdio<null, Readable, Readable>;

  constructor(private readonly config: AppConfig, private readonly events: ActivityStore) {}

  async start(): Promise<{ publicUrl: string; pid?: number }> {
    const settings = await readGatewaySettings(this.config.dataDir);
    if (!settings) throw new Error("No OmniX gateway is configured. Run `omnix-go gateway provision --name <name>` first.");
    const tokenFile = gatewayTokenPath(this.config.dataDir);
    await chmod(tokenFile, 0o600);
    const cloudflared = await ensureCloudflared(this.config.dataDir);
    const child = spawn(cloudflared, ["tunnel", "--no-autoupdate", "run", "--token-file", tokenFile], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.config.publicUrl = settings.goUrl;
    this.config.gatewayName = settings.gatewayName;
    this.config.gatewayOwnerUserId = settings.ownerUserId;
    this.events.publish("system", "OmniX gateway connector starting", "running", settings.hostname, { pid: child.pid });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the OmniX gateway connector.")), 30_000);
      const onData = (chunk: Buffer) => {
        const message = chunk.toString("utf8").replace(/[A-Za-z0-9_-]{100,}/g, "[redacted]");
        this.events.publish("system", "Gateway connector", "info", message);
        if (/Registered tunnel connection/i.test(message)) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`Gateway connector exited with code ${code ?? -1}`)); } });
    });
    this.events.publish("system", "OmniX gateway ready", "success", settings.goUrl);
    return { publicUrl: settings.goUrl, ...(child.pid === undefined ? {} : { pid: child.pid }) };
  }

  stop(): void {
    this.process?.kill("SIGTERM");
    this.process = undefined;
  }
}
