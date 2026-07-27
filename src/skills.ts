import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { ActivityStore } from "./events.js";
import type { AppConfig, SkillRecord } from "./types.js";
import { compactId, limitText } from "./utils.js";

function parseFrontmatter(source: string): Record<string, string> {
  if (!source.startsWith("---\n")) return {};
  const end = source.indexOf("\n---", 4);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of source.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

function sourceFor(root: string): SkillRecord["source"] {
  if (root.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  if (root.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  if (root.includes(`${path.sep}.agents${path.sep}`)) return "agents";
  return "other";
}

export class SkillInventory {
  private records = new Map<string, SkillRecord>();

  constructor(
    private readonly config: AppConfig,
    private readonly events: ActivityStore,
  ) {}

  async refresh(): Promise<SkillRecord[]> {
    const next = new Map<string, SkillRecord>();
    for (const root of this.config.skillRoots) {
      const files = await fg("**/SKILL.md", {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        deep: 8,
      });
      for (const skillPath of files) {
        try {
          const text = await readFile(skillPath, "utf8");
          const metadata = parseFrontmatter(text);
          const folder = path.dirname(skillPath);
          const name = metadata.name || path.basename(folder);
          const id = `${sourceFor(root)}:${compactId(name)}:${compactId(
            path.relative(root, folder),
          )}`;
          const relatedFiles = await fg(["**/*", "!**/.git/**", "!**/node_modules/**"], {
            cwd: folder,
            onlyFiles: true,
            followSymbolicLinks: false,
            suppressErrors: true,
            deep: 5,
          });
          const warnings = this.evaluateText(text);
          const fileStat = await stat(skillPath);
          next.set(id, {
            id,
            name,
            description: metadata.description || "No description provided.",
            path: skillPath,
            root,
            source: sourceFor(root),
            modifiedAt: fileStat.mtime.toISOString(),
            files: relatedFiles.slice(0, 250),
            valid: warnings.length === 0,
            warnings,
          });
        } catch (error) {
          this.events.publish(
            "skill",
            "Skill scan failed",
            "warning",
            `${skillPath}: ${String(error)}`,
          );
        }
      }
    }
    this.records = next;
    this.events.publish(
      "skill",
      "Skill inventory refreshed",
      "success",
      `${next.size} skills discovered across ${this.config.skillRoots.length} roots`,
    );
    return this.list();
  }

  list(query?: string): SkillRecord[] {
    const records = [...this.records.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (!query) return records;
    const needle = query.toLowerCase();
    return records.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.source.includes(needle),
    );
  }

  get(idOrName: string): SkillRecord | undefined {
    return (
      this.records.get(idOrName) ??
      [...this.records.values()].find(
        (record) => record.name.toLowerCase() === idOrName.toLowerCase(),
      )
    );
  }

  async read(idOrName: string, file = "SKILL.md"): Promise<{
    skill: SkillRecord;
    file: string;
    content: string;
  }> {
    const skill = this.get(idOrName);
    if (!skill) throw new Error(`Unknown skill: ${idOrName}`);
    const folder = path.dirname(skill.path);
    const target = path.resolve(folder, file);
    const relative = path.relative(folder, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Skill file path escapes the skill directory");
    }
    return {
      skill,
      file: relative,
      content: limitText(await readFile(target, "utf8"), 200_000),
    };
  }

  async create(input: {
    name: string;
    description: string;
    instructions: string;
    root?: string;
  }): Promise<SkillRecord> {
    const root = input.root ?? this.config.skillRoots[0]!;
    if (!this.config.skillRoots.includes(root)) {
      throw new Error("Skill root is not in the configured inventory roots");
    }
    const folderName = compactId(input.name).replaceAll("_", "-");
    if (!folderName) throw new Error("Skill name must contain letters or numbers");
    const folder = path.join(root, folderName);
    await mkdir(folder, { recursive: false, mode: 0o700 });
    const source = `---\nname: "${input.name.replaceAll('"', '\\"')}"\ndescription: "${input.description.replaceAll('"', '\\"')}"\n---\n\n# ${input.name}\n\n${input.instructions.trim()}\n`;
    await writeFile(path.join(folder, "SKILL.md"), source, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await this.refresh();
    const created = this.list().find((record) => record.path === path.join(folder, "SKILL.md"));
    if (!created) throw new Error("Skill was written but could not be indexed");
    this.events.publish("skill", "Skill created", "success", created.path);
    return created;
  }

  async evaluate(idOrName: string): Promise<{
    skill: SkillRecord;
    score: number;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  }> {
    const skill = this.get(idOrName);
    if (!skill) throw new Error(`Unknown skill: ${idOrName}`);
    const source = await readFile(skill.path, "utf8");
    const frontmatter = parseFrontmatter(source);
    const checks = [
      {
        name: "frontmatter",
        passed: source.startsWith("---\n") && source.indexOf("\n---", 4) > 0,
        detail: "SKILL.md starts with parseable YAML-style frontmatter.",
      },
      {
        name: "name",
        passed: Boolean(frontmatter.name),
        detail: "Frontmatter has a stable skill name.",
      },
      {
        name: "description",
        passed: Boolean(frontmatter.description && frontmatter.description.length >= 20),
        detail: "Description is specific enough for routing.",
      },
      {
        name: "instructions",
        passed: source.split(/\s+/).length >= 40,
        detail: "Instructions contain enough substance to guide a task.",
      },
      {
        name: "size",
        passed: source.length <= 100_000,
        detail: "Primary instructions fit within a practical context budget.",
      },
      {
        name: "assets",
        passed: skill.files.length <= 250,
        detail: "Skill asset inventory remains bounded.",
      },
    ];
    const score = Math.round(
      (checks.filter((check) => check.passed).length / checks.length) * 100,
    );
    return { skill, score, checks };
  }

  private evaluateText(source: string): string[] {
    const warnings: string[] = [];
    const metadata = parseFrontmatter(source);
    if (!metadata.name) warnings.push("Missing frontmatter name.");
    if (!metadata.description) warnings.push("Missing frontmatter description.");
    if (source.length > 100_000) warnings.push("SKILL.md exceeds 100 KB.");
    if (source.split(/\s+/).length < 20) warnings.push("Instructions are unusually short.");
    return warnings;
  }
}
