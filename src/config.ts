import { generateKeyPair, exportJWK } from "jose";
import { access, chmod, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./types.js";
import { ensureDir, randomToken } from "./utils.js";
import { readGatewaySettings } from "./gateway.js";

const DEFAULT_SKILL_ROOTS = [
  path.join(os.homedir(), ".codex", "skills"),
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
  path.join(os.homedir(), ".config", "skills"),
];

export interface LoadedConfig {
  config: AppConfig;
  configPath: string;
}

async function defaultDataDirectory(): Promise<string> {
  const preferred = path.join(os.homedir(), ".omnix-go");
  const legacy = path.join(os.homedir(), ".chatgpt-code");
  if (await access(preferred).then(() => true, () => false)) return preferred;
  if (await access(legacy).then(() => true, () => false)) {
    await rename(legacy, preferred);
  }
  return preferred;
}

export async function loadConfig(options: {
  cwd: string;
  port?: number;
  host?: string;
  dataDir?: string;
  workspaceRoots?: string[];
  publicUrl?: string;
}): Promise<LoadedConfig> {
  const dataDir =
    options.dataDir ??
    process.env.OMNIX_GO_HOME ??
    process.env.CHATGPT_CODE_HOME ??
    await defaultDataDirectory();
  await ensureDir(dataDir);
  await chmod(dataDir, 0o700);
  const configPath = path.join(dataDir, "config.json");

  let stored: AppConfig | undefined;
  try {
    stored = JSON.parse(await readFile(configPath, "utf8")) as AppConfig;
  } catch {
    stored = undefined;
  }

  if (!stored) {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    stored = {
      host: "127.0.0.1",
      port: 8111,
      // New installations are intentionally computer-wide within the signed-in
      // user's home directory, independent of where `omnix-go` was invoked.
      workspaceRoots: [os.homedir()],
      skillRoots: DEFAULT_SKILL_ROOTS,
      dataDir,
      dashboardToken: randomToken(),
      jwtPrivateJwk: await exportJWK(privateKey),
      jwtPublicJwk: await exportJWK(publicKey),
      upstreams: [],
      maxParallelAgents: 3,
      commandTimeoutMs: 10 * 60 * 1000,
    };
    await saveConfig(stored, configPath);
  }

  const gateway = await readGatewaySettings(dataDir).catch(() => undefined);
  const storedPort = stored.port === 3939 ? 8111 : stored.port;

  const config: AppConfig = {
    ...stored,
    host: options.host ?? process.env.OMNIX_GO_HOST ?? process.env.CHATGPT_CODE_HOST ?? stored.host,
    port: options.port ?? Number(process.env.OMNIX_GO_PORT || process.env.CHATGPT_CODE_PORT || storedPort),
    workspaceRoots:
      options.workspaceRoots?.map((root) => path.resolve(root)) ?? stored.workspaceRoots,
    dataDir,
    ...(options.publicUrl ?? process.env.OMNIX_GO_PUBLIC_URL ?? gateway?.goUrl
      ? { publicUrl: options.publicUrl ?? process.env.OMNIX_GO_PUBLIC_URL ?? gateway?.goUrl }
      : {}),
    ...(gateway ? { gatewayName: gateway.gatewayName, gatewayOwnerUserId: gateway.ownerUserId } : {}),
  };

  return { config, configPath };
}

export async function saveConfig(config: AppConfig, configPath?: string): Promise<void> {
  const target = configPath ?? path.join(config.dataDir, "config.json");
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}
