import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityStore } from "./events.js";
import type { AppConfig } from "./types.js";

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

interface ManagedTunnelSettings {
  tunnelToken?: string;
  apiToken?: string;
  accountId?: string;
  hostname?: string;
  publicUrl?: string;
  zoneId?: string;
  tunnelName?: string;
  tunnelId?: string;
}

export function isQuickTunnelUrl(url: string | undefined): boolean {
  return typeof url === "string" && /\.trycloudflare\.com$/i.test(url.replace(/\/+$/, ""));
}

function managedSettingsPath(dataDir: string): string {
  return path.join(dataDir, "cloudflare-managed.json");
}

async function readManagedSettings(dataDir: string): Promise<ManagedTunnelSettings> {
  try {
    return JSON.parse(
      await readFile(managedSettingsPath(dataDir), "utf8"),
    ) as ManagedTunnelSettings;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

async function writeManagedSettings(
  dataDir: string,
  settings: ManagedTunnelSettings,
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = managedSettingsPath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function prepareManagedCloudflare(dataDir: string): Promise<{
  configured: boolean;
  hostname?: string;
}> {
  const existing = await readManagedSettings(dataDir);
  const settings: ManagedTunnelSettings = {
    ...existing,
    ...(process.env.CLOUDFLARE_TUNNEL_TOKEN
      ? { tunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN }
      : {}),
    ...(process.env.CLOUDFLARE_API_TOKEN
      ? { apiToken: process.env.CLOUDFLARE_API_TOKEN }
      : {}),
    ...(process.env.CLOUDFLARE_ACCOUNT_ID
      ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
      : {}),
    ...(process.env.CHATGPT_CODE_HOSTNAME
      ? { hostname: process.env.CHATGPT_CODE_HOSTNAME }
      : {}),
    ...(process.env.CHATGPT_CODE_PUBLIC_URL
      ? { publicUrl: process.env.CHATGPT_CODE_PUBLIC_URL }
      : {}),
    ...(process.env.CLOUDFLARE_ZONE_ID
      ? { zoneId: process.env.CLOUDFLARE_ZONE_ID }
      : {}),
    ...(process.env.CHATGPT_CODE_TUNNEL_NAME
      ? { tunnelName: process.env.CHATGPT_CODE_TUNNEL_NAME }
      : {}),
  };
  const configured = Boolean(
    (settings.tunnelToken && (settings.publicUrl || settings.hostname)) ||
      (settings.apiToken && settings.accountId && settings.hostname),
  );
  if (configured) await writeManagedSettings(dataDir, settings);
  return {
    configured,
    ...(settings.hostname ? { hostname: settings.hostname } : {}),
  };
}

export class CloudflareTunnel {
  private process?: ChildProcessByStdio<null, Readable, Readable>;

  constructor(
    private readonly config: AppConfig,
    private readonly events: ActivityStore,
    private readonly persist: () => Promise<void>,
  ) {}

  async start(mode: "off" | "quick" | "managed" = "quick"): Promise<{
    mode: string;
    publicUrl?: string;
    pid?: number;
  }> {
    if (mode === "off") return { mode };
    const localUrl = `http://${this.config.host}:${this.config.port}`;
    let args: string[];
    let publicUrl = this.config.publicUrl;

    if (mode === "managed") {
      await prepareManagedCloudflare(this.config.dataDir);
      const managed = await readManagedSettings(this.config.dataDir);
      const provisioned = managed.tunnelToken
        ? undefined
        : await this.provisionManaged(localUrl, managed);
      const tunnelToken = managed.tunnelToken ?? provisioned?.token;
      if (!tunnelToken) {
        throw new Error(
          "Managed Cloudflare mode is not configured. Set CLOUDFLARE_TUNNEL_TOKEN plus CHATGPT_CODE_PUBLIC_URL, or set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CHATGPT_CODE_HOSTNAME, and optionally CLOUDFLARE_ZONE_ID once before installing the service.",
        );
      }
      args = ["tunnel", "--no-autoupdate", "run", "--token", tunnelToken];
      publicUrl =
        process.env.CHATGPT_CODE_PUBLIC_URL ??
        (process.env.CHATGPT_CODE_HOSTNAME
          ? `https://${process.env.CHATGPT_CODE_HOSTNAME}`
          : managed.publicUrl ??
            (managed.hostname ? `https://${managed.hostname}` : publicUrl));
      if (isQuickTunnelUrl(publicUrl)) {
        publicUrl = undefined;
      }
      if (!publicUrl) {
        throw new Error(
          "Managed Cloudflare mode needs a stable CHATGPT_CODE_HOSTNAME or CHATGPT_CODE_PUBLIC_URL; refusing to fall back to a temporary tunnel.",
        );
      }
      await writeManagedSettings(this.config.dataDir, {
        tunnelToken,
        publicUrl,
        ...(managed.hostname ? { hostname: managed.hostname } : {}),
        ...(managed.tunnelName ? { tunnelName: managed.tunnelName } : {}),
        ...(provisioned?.tunnelId ? { tunnelId: provisioned.tunnelId } : {}),
      });
    } else {
      args = ["tunnel", "--no-autoupdate", "--url", localUrl];
    }

    const child = spawn("cloudflared", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.events.publish("system", "Cloudflare tunnel starting", "running", mode, {
      pid: child.pid,
    });

    const url = await new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (mode === "managed" && publicUrl) resolve(publicUrl);
        else reject(new Error("Timed out waiting for Cloudflare tunnel URL"));
      }, 30_000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.events.publish("system", "cloudflared", "info", text);
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
        if (mode === "managed" && /Registered tunnel connection/i.test(text)) {
          clearTimeout(timeout);
          resolve(publicUrl);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited with code ${code ?? -1}`));
        }
      });
    });

    if (url) {
      const keepStable = mode === "quick" && !isQuickTunnelUrl(this.config.publicUrl);
      if (!keepStable) {
        this.config.publicUrl = url;
        await this.persist();
      }
      this.events.publish("system", "Cloudflare tunnel ready", "success", url);
    }
    return {
      mode,
      ...(url ? { publicUrl: url } : {}),
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    };
  }

  stop(): void {
    this.process?.kill("SIGTERM");
    this.process = undefined;
  }

  private async provisionManaged(
    localUrl: string,
    settings: ManagedTunnelSettings,
  ): Promise<{ token: string; tunnelId: string }> {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? settings.apiToken;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? settings.accountId;
    const hostname = process.env.CHATGPT_CODE_HOSTNAME ?? settings.hostname;
    if (!apiToken || !accountId || !hostname) {
      throw new Error(
        "Managed setup requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CHATGPT_CODE_HOSTNAME",
      );
    }
    const tunnelName =
      process.env.CHATGPT_CODE_TUNNEL_NAME ??
      settings.tunnelName ??
      "chatgpt-code";
    const api = async <T>(method: string, endpoint: string, body?: unknown): Promise<T> => {
      const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const envelope = (await response.json()) as CloudflareEnvelope<T>;
      if (!response.ok || !envelope.success) {
        throw new Error(
          `Cloudflare API ${response.status}: ${envelope.errors?.map((e) => e.message).join(", ") || "unknown error"}`,
        );
      }
      return envelope.result;
    };

    const existing = await api<Array<{ id: string; name: string }>>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`,
    );
    const tunnel =
      existing[0] ??
      (await api<{ id: string; name: string }>(
        "POST",
        `/accounts/${accountId}/cfd_tunnel`,
        {
          name: tunnelName,
          tunnel_secret: randomBytes(32).toString("base64"),
        },
      ));

    await api(
      "PUT",
      `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`,
      {
        config: {
          ingress: [
            { hostname, service: localUrl },
            { service: "http_status:404" },
          ],
        },
      },
    );

    const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? settings.zoneId;
    if (zoneId) {
      const name = hostname.replace(/\.$/, "");
      const records = await api<Array<{ id: string; name: string }>>(
        "GET",
        `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
      );
      const recordBody = {
        type: "CNAME",
        name,
        content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true,
      };
      if (records[0]) {
        await api("PUT", `/zones/${zoneId}/dns_records/${records[0].id}`, recordBody);
      } else {
        await api("POST", `/zones/${zoneId}/dns_records`, recordBody);
      }
    }
    const token = await api<string>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`,
    );
    return { token, tunnelId: tunnel.id };
  }
}
