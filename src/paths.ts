import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./types.js";
import { isWithin } from "./utils.js";

export class PathGuard {
  readonly roots: string[];

  private constructor(roots: string[]) {
    this.roots = roots;
  }

  static async create(config: AppConfig): Promise<PathGuard> {
    const roots: string[] = [];
    for (const root of config.workspaceRoots) {
      await mkdir(root, { recursive: true });
      roots.push(await realpath(root));
    }
    return new PathGuard(roots);
  }

  async resolve(candidate: string, options?: { allowCreate?: boolean }): Promise<string> {
    const absolute = path.resolve(candidate);
    if (!options?.allowCreate) {
      const resolved = await realpath(absolute);
      if (!this.roots.some((root) => isWithin(resolved, root))) {
        throw new Error(`Path is outside configured workspace roots: ${candidate}`);
      }
      return resolved;
    }

    let parent = absolute;
    while (true) {
      try {
        const stat = await lstat(parent);
        if (stat.isSymbolicLink()) {
          const resolved = await realpath(parent);
          if (!this.roots.some((root) => isWithin(resolved, root))) {
            throw new Error(`Parent symlink escapes configured workspace roots: ${candidate}`);
          }
        }
        const resolvedParent = await realpath(parent);
        const canonicalCandidate = path.join(
          resolvedParent,
          path.relative(parent, absolute),
        );
        if (!this.roots.some((root) => isWithin(canonicalCandidate, root))) {
          throw new Error(`Parent path escapes configured workspace roots: ${candidate}`);
        }
        return canonicalCandidate;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          const next = path.dirname(parent);
          if (next === parent) throw error;
          parent = next;
          continue;
        }
        throw error;
      }
    }
  }

  async workspace(candidate?: string): Promise<string> {
    if (!candidate) return this.roots[0]!;
    const resolved = await this.resolve(candidate);
    if (!this.roots.some((root) => isWithin(resolved, root))) {
      throw new Error(`Not a configured workspace: ${candidate}`);
    }
    return resolved;
  }
}
