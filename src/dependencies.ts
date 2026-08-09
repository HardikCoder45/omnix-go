import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLOUDFLARED_RELEASE_API =
  "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const MAX_BINARY_BYTES = 100 * 1024 * 1024;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

interface ReleaseResponse {
  tag_name?: string;
  assets?: ReleaseAsset[];
}

function executableName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function releaseAssetName(): string {
  const architecture =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? process.platform === "win32"
          ? "amd64"
          : "arm64"
        : process.arch === "ia32"
          ? "386"
          : undefined;
  if (!architecture) {
    throw new Error(`cloudflared is not available for ${process.platform}/${process.arch}`);
  }
  if (process.platform === "darwin") return `cloudflared-darwin-${architecture}.tgz`;
  if (process.platform === "win32") return `cloudflared-windows-${architecture}.exe`;
  if (process.platform === "linux") return `cloudflared-linux-${architecture}`;
  throw new Error(`Automatic cloudflared setup is not supported on ${process.platform}`);
}

async function fileExists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

async function downloadAsset(asset: ReleaseAsset): Promise<Buffer> {
  const response = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "omnix-go" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Cloudflare download failed with HTTP ${response.status}`);
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_BINARY_BYTES) throw new Error("Cloudflare download is too large");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BINARY_BYTES) throw new Error("Cloudflare download is too large");
  const expected = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (!expected) throw new Error("Cloudflare release did not include a SHA-256 digest");
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) throw new Error("Cloudflare binary checksum verification failed");
  return buffer;
}

export function managedCloudflaredPath(dataDir: string): string {
  return path.join(dataDir, "bin", executableName());
}

export async function ensureCloudflared(dataDir: string): Promise<string> {
  const override = process.env.OMNIX_GO_CLOUDFLARED_PATH ?? process.env.CLOUDFLARED_PATH;
  if (override) {
    const resolved = path.resolve(override);
    if (!(await fileExists(resolved))) {
      throw new Error(`OMNIX_GO_CLOUDFLARED_PATH does not exist: ${resolved}`);
    }
    return resolved;
  }

  const target = managedCloudflaredPath(dataDir);
  if (await fileExists(target)) return target;

  const releaseResponse = await fetch(CLOUDFLARED_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "omnix-go",
    },
  });
  if (!releaseResponse.ok) {
    throw new Error(`Unable to resolve the Cloudflare release: HTTP ${releaseResponse.status}`);
  }
  const release = (await releaseResponse.json()) as ReleaseResponse;
  const assetName = releaseAssetName();
  const asset = release.assets?.find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(
      `Cloudflare release ${release.tag_name ?? "latest"} has no ${assetName} asset`,
    );
  }

  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.download`;
  const archive = `${temporary}.tgz`;
  try {
    const binary = await downloadAsset(asset);
    if (process.platform === "darwin") {
      await writeFile(archive, binary, { mode: 0o600 });
      const extractionDirectory = path.join(directory, `.cloudflared-${process.pid}`);
      await mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
      await execFileAsync("/usr/bin/tar", ["-xzf", archive, "-C", extractionDirectory]);
      await rename(path.join(extractionDirectory, "cloudflared"), temporary);
      await rm(extractionDirectory, { recursive: true, force: true });
    } else {
      await writeFile(temporary, binary, { mode: 0o700 });
    }
    if (process.platform !== "win32") await chmod(temporary, 0o700);
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    await rm(archive, { force: true }).catch(() => undefined);
  }
}

export async function dependencyStatus(dataDir: string): Promise<{
  cloudflared: string;
  installed: boolean;
}> {
  const cloudflared = managedCloudflaredPath(dataDir);
  return { cloudflared, installed: await fileExists(cloudflared) };
}
