import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ActivityStore } from "./events.js";
import type { PathGuard } from "./paths.js";
import { limitText } from "./utils.js";

const execFileAsync = promisify(execFile);

function pathsFromPatch(patch: string): string[] {
  const results: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^(?:---|\+\+\+) (?:a\/|b\/)?([^\t]+)(?:\t.*)?$/.exec(line);
    if (!match || match[1] === "/dev/null") continue;
    results.push(match[1]!);
  }
  return results;
}

export class GitService {
  constructor(
    private readonly paths: PathGuard,
    private readonly events: ActivityStore,
  ) {}

  async status(cwd?: string): Promise<{ cwd: string; status: string }> {
    const workspace = await this.paths.workspace(cwd);
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--branch", "--untracked-files=all"],
      { cwd: workspace, maxBuffer: 5 * 1024 * 1024 },
    );
    return { cwd: workspace, status: stdout };
  }

  async diff(input: {
    cwd?: string;
    staged?: boolean;
    path?: string;
  }): Promise<{ cwd: string; diff: string }> {
    const workspace = await this.paths.workspace(input.cwd);
    const args = ["diff", "--no-ext-diff", "--unified=3"];
    if (input.staged) args.push("--cached");
    if (input.path) {
      const target = await this.paths.resolve(path.resolve(workspace, input.path));
      args.push("--", path.relative(workspace, target));
    }
    const { stdout } = await execFileAsync("git", args, {
      cwd: workspace,
      maxBuffer: 20 * 1024 * 1024,
    });
    this.events.publish("diff", "Git diff read", "success", workspace, {
      staged: input.staged ?? false,
      diff: limitText(stdout, 300_000),
    });
    return { cwd: workspace, diff: limitText(stdout, 300_000) };
  }

  async applyPatch(input: {
    cwd?: string;
    patch: string;
    checkOnly?: boolean;
  }): Promise<{ cwd: string; applied: boolean; checkOnly: boolean }> {
    const workspace = await this.paths.workspace(input.cwd);
    const patchPaths = pathsFromPatch(input.patch);
    if (patchPaths.length === 0) throw new Error("Patch contains no file headers");
    for (const patchPath of patchPaths) {
      if (path.isAbsolute(patchPath) || patchPath.split(/[\\/]/).includes("..")) {
        throw new Error(`Unsafe patch path: ${patchPath}`);
      }
      await this.paths.resolve(path.join(workspace, patchPath), { allowCreate: true });
    }

    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "omnix-go-patch-"));
    const patchFile = path.join(tempDirectory, "change.patch");
    try {
      await writeFile(patchFile, input.patch, { encoding: "utf8", mode: 0o600 });
      await execFileAsync("git", ["apply", "--check", "--whitespace=error-all", patchFile], {
        cwd: workspace,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (!input.checkOnly) {
        await execFileAsync("git", ["apply", "--whitespace=fix", patchFile], {
          cwd: workspace,
          maxBuffer: 10 * 1024 * 1024,
        });
      }
      const appliedDiff = input.checkOnly
        ? input.patch
        : (
            await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3"], {
              cwd: workspace,
              maxBuffer: 20 * 1024 * 1024,
            })
          ).stdout;
      this.events.publish(
        "diff",
        input.checkOnly ? "Patch validated" : "Patch applied",
        "success",
        `${patchPaths.length} path(s)`,
        { diff: limitText(appliedDiff, 300_000) },
      );
      return {
        cwd: workspace,
        applied: !input.checkOnly,
        checkOnly: input.checkOnly ?? false,
      };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async showFile(cwd: string, revision: string, file: string): Promise<string> {
    const workspace = await this.paths.workspace(cwd);
    const target = await this.paths.resolve(path.join(workspace, file), {
      allowCreate: true,
    });
    const relative = path.relative(workspace, target);
    const { stdout } = await execFileAsync("git", ["show", `${revision}:${relative}`], {
      cwd: workspace,
      maxBuffer: 10 * 1024 * 1024,
    });
    return limitText(stdout, 250_000);
  }
}
