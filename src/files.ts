import { createTwoFilesPatch } from "diff";
import fg from "fast-glob";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ActivityStore } from "./events.js";
import type { PathGuard } from "./paths.js";
import { limitText } from "./utils.js";

export class FileService {
  constructor(
    private readonly paths: PathGuard,
    private readonly events: ActivityStore,
  ) {}

  async read(filePath: string, startLine = 1, endLine?: number): Promise<{
    path: string;
    content: string;
    lines: number;
    size: number;
  }> {
    const target = await this.paths.resolve(filePath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Path is not a regular file");
    if (info.size > 5 * 1024 * 1024) throw new Error("File exceeds 5 MB read limit");
    const source = await readFile(target, "utf8");
    const lines = source.split("\n");
    const from = Math.max(0, startLine - 1);
    const to = endLine ? Math.min(lines.length, endLine) : lines.length;
    const content = limitText(lines.slice(from, to).join("\n"), 250_000);
    this.events.publish("file", "File read", "success", target, {
      startLine,
      endLine: to,
    });
    return { path: target, content, lines: lines.length, size: info.size };
  }

  async list(
    directory: string,
    options?: { depth?: number; includeHidden?: boolean },
  ): Promise<{
    path: string;
    entries: Array<{
      name: string;
      path: string;
      type: "file" | "directory" | "symlink" | "other";
      size?: number;
    }>;
  }> {
    const target = await this.paths.resolve(directory);
    const depth = Math.min(Math.max(options?.depth ?? 1, 1), 8);
    const patterns = options?.includeHidden ? ["**/*", "**/.*"] : ["**/*"];
    const names = await fg(patterns, {
      cwd: target,
      onlyFiles: false,
      markDirectories: false,
      dot: options?.includeHidden ?? false,
      deep: depth,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ["**/.git/**", "**/node_modules/**"],
    });
    const entries = await Promise.all(
      names.slice(0, 2_000).map(async (name) => {
        const absolute = path.join(target, name);
        const info = await lstat(absolute);
        const type = info.isFile()
          ? "file"
          : info.isDirectory()
            ? "directory"
            : info.isSymbolicLink()
              ? "symlink"
              : "other";
        return {
          name,
          path: absolute,
          type,
          ...(info.isFile() ? { size: info.size } : {}),
        } as const;
      }),
    );
    this.events.publish("file", "Directory listed", "success", target, {
      count: entries.length,
    });
    return { path: target, entries };
  }

  async search(input: {
    directory: string;
    pattern: string;
    glob?: string;
    maxResults?: number;
  }): Promise<{
    matches: Array<{ path: string; line: number; text: string }>;
    truncated: boolean;
  }> {
    const directory = await this.paths.resolve(input.directory);
    const maxResults = Math.min(input.maxResults ?? 200, 1_000);
    const files = await fg(input.glob || "**/*", {
      cwd: directory,
      absolute: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**"],
    });
    const expression = new RegExp(input.pattern, "i");
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = false;
    for (const file of files) {
      try {
        const info = await stat(file);
        if (info.size > 2 * 1024 * 1024) continue;
        const lines = (await readFile(file, "utf8")).split("\n");
        for (let index = 0; index < lines.length; index++) {
          const text = lines[index]!;
          if (!expression.test(text)) continue;
          matches.push({ path: file, line: index + 1, text: text.slice(0, 1_000) });
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      } catch {
        // Binary/unreadable files are skipped.
      }
      if (truncated) break;
    }
    this.events.publish("file", "Workspace searched", "success", input.pattern, {
      count: matches.length,
    });
    return { matches, truncated };
  }

  async write(filePath: string, content: string, createDirectories = true): Promise<{
    path: string;
    bytes: number;
    diff: string;
  }> {
    const target = await this.paths.resolve(filePath, { allowCreate: true });
    let previous = "";
    try {
      previous = await readFile(target, "utf8");
    } catch {
      previous = "";
    }
    if (createDirectories) await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.omnix-go.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
    const diff = createTwoFilesPatch(target, target, previous, content, "before", "after");
    this.events.publish("file", "File written", "success", target, {
      bytes: Buffer.byteLength(content),
    });
    this.events.publish("diff", "File diff", "info", target, { diff });
    return { path: target, bytes: Buffer.byteLength(content), diff: limitText(diff, 200_000) };
  }

  async edit(input: {
    path: string;
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  }): Promise<{ path: string; replacements: number; diff: string }> {
    const target = await this.paths.resolve(input.path);
    const previous = await readFile(target, "utf8");
    const occurrences = previous.split(input.oldText).length - 1;
    if (occurrences === 0) throw new Error("oldText was not found");
    if (!input.replaceAll && occurrences !== 1) {
      throw new Error(
        `oldText matched ${occurrences} times; provide a unique match or set replaceAll`,
      );
    }
    const next = input.replaceAll
      ? previous.split(input.oldText).join(input.newText)
      : previous.replace(input.oldText, input.newText);
    const temporary = `${target}.${process.pid}.omnix-go.tmp`;
    await writeFile(temporary, next, "utf8");
    await rename(temporary, target);
    const replacements = input.replaceAll ? occurrences : 1;
    const diff = createTwoFilesPatch(target, target, previous, next, "before", "after");
    this.events.publish("file", "File edited", "success", target, { replacements });
    this.events.publish("diff", "Edit diff", "info", target, { diff });
    return { path: target, replacements, diff: limitText(diff, 200_000) };
  }

  async roots(): Promise<{ roots: string[] }> {
    return { roots: this.paths.roots };
  }
}
