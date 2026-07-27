import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function compactId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function existingRealpath(candidate: string): Promise<string> {
  await access(candidate);
  return realpath(candidate);
}

export function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function limitText(value: string, max = 100_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n… truncated ${value.length - max} characters`;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function jsonText(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const structuredContent =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}
