import { generateKeyPair, exportJWK } from "jose";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./types.js";
import { ensureDir, randomToken, sha256 } from "./utils.js";

const DEFAULT_SKILL_ROOTS = [
  path.join(os.homedir(), ".codex", "skills"),
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
  path.join(os.homedir(), ".config", "skills"),
];

export interface LoadedConfig {
  config: AppConfig;
  pairingCode?: string;
  configPath: string;
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
    process.env.CHATGPT_CODE_HOME ??
    path.join(os.homedir(), ".chatgpt-code");
  await ensureDir(dataDir);
  await chmod(dataDir, 0o700);
  const configPath = path.join(dataDir, "config.json");

  let stored: AppConfig | undefined;
  try {
    stored = JSON.parse(await readFile(configPath, "utf8")) as AppConfig;
  } catch {
    stored = undefined;
  }

  let pairingCode: string | undefined;
  if (!stored) {
    pairingCode = `${randomToken(4).slice(0, 4)}-${randomToken(4).slice(0, 4)}`.toUpperCase();
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    stored = {
      host: "127.0.0.1",
      port: 3939,
      workspaceRoots: [path.resolve(options.cwd)],
      skillRoots: DEFAULT_SKILL_ROOTS,
      dataDir,
      dashboardToken: randomToken(),
      pairingSecretHash: sha256(pairingCode),
      jwtPrivateJwk: await exportJWK(privateKey),
      jwtPublicJwk: await exportJWK(publicKey),
      upstreams: [],
      maxParallelAgents: 3,
      commandTimeoutMs: 10 * 60 * 1000,
    };
    await saveConfig(stored, configPath);
  }

  const config: AppConfig = {
    ...stored,
    host: options.host ?? process.env.CHATGPT_CODE_HOST ?? stored.host,
    port: options.port ?? Number(process.env.CHATGPT_CODE_PORT || stored.port),
    workspaceRoots:
      options.workspaceRoots?.map((root) => path.resolve(root)) ?? stored.workspaceRoots,
    dataDir,
    ...(options.publicUrl ?? process.env.CHATGPT_CODE_PUBLIC_URL ?? stored.publicUrl
      ? { publicUrl: options.publicUrl ?? process.env.CHATGPT_CODE_PUBLIC_URL ?? stored.publicUrl }
      : {}),
  };

  return { config, ...(pairingCode === undefined ? {} : { pairingCode }), configPath };
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

export async function rotatePairingCode(
  config: AppConfig,
  configPath?: string,
): Promise<string> {
  const pairingCode = `${randomToken(4).slice(0, 4)}-${randomToken(4).slice(0, 4)}`.toUpperCase();
  const pairingSecretHash = sha256(pairingCode);
  const target = configPath ?? path.join(config.dataDir, "config.json");
  let latest = config;
  try {
    latest = JSON.parse(await readFile(target, "utf8")) as AppConfig;
  } catch {
    // Fall back to the caller's complete config when no current file is readable.
  }
  await saveConfig({ ...latest, pairingSecretHash }, target);
  config.pairingSecretHash = pairingSecretHash;
  return pairingCode;
}
