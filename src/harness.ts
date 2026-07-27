import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ActivityStore } from "./events.js";
import type { AppConfig, AgentTask } from "./types.js";
import type { PathGuard } from "./paths.js";
import type { TerminalManager } from "./terminal.js";
import { limitText } from "./utils.js";

interface LiveTask {
  task: AgentTask;
  process?: ChildProcessByStdio<null, Readable, Readable>;
}

export class AgentHarness {
  private readonly tasks = new Map<string, LiveTask>();
  private readonly queue: string[] = [];
  private readonly taskDirectory: string;

  constructor(
    private readonly config: AppConfig,
    private readonly paths: PathGuard,
    private readonly terminal: TerminalManager,
    private readonly events: ActivityStore,
  ) {
    this.taskDirectory = path.join(config.dataDir, "tasks");
  }

  async restore(): Promise<void> {
    await mkdir(this.taskDirectory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.taskDirectory).catch(() => []);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const task = JSON.parse(
          await readFile(path.join(this.taskDirectory, file), "utf8"),
        ) as AgentTask;
        if (task.status === "running" || task.status === "queued") {
          task.status = "failed";
          task.finishedAt = new Date().toISOString();
          task.output += "\nTask was interrupted by a service restart.";
        }
        this.tasks.set(task.id, { task });
      } catch {
        // Ignore corrupt task snapshots without blocking service startup.
      }
    }
  }

  async start(input: {
    prompt: string;
    workspace?: string;
    model?: string;
    evaluationCommands?: string[];
  }): Promise<AgentTask> {
    const workspace = await this.paths.workspace(input.workspace);
    const task: AgentTask = {
      id: randomUUID(),
      prompt: input.prompt,
      workspace,
      status: "queued",
      createdAt: new Date().toISOString(),
      output: "",
      ...(input.evaluationCommands?.length
        ? { evaluation: { commands: input.evaluationCommands } }
        : {}),
      ...(input.model ? { model: input.model } : {}),
    };
    const live: LiveTask = { task };
    this.tasks.set(task.id, live);
    this.queue.push(task.id);
    await this.persist(task);
    this.events.publish("agent", "Agent task queued", "running", input.prompt, {
      taskId: task.id,
      workspace,
    });
    queueMicrotask(() => void this.pump());
    return task;
  }

  private runningCount(): number {
    return [...this.tasks.values()].filter((item) => item.task.status === "running")
      .length;
  }

  private async pump(): Promise<void> {
    while (
      this.queue.length > 0 &&
      this.runningCount() < this.config.maxParallelAgents
    ) {
      const id = this.queue.shift()!;
      const live = this.tasks.get(id);
      if (!live || live.task.status !== "queued") continue;
      void this.execute(live);
    }
  }

  private async execute(live: LiveTask): Promise<void> {
    const task = live.task;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      task.workspace,
    ];
    if (task.model) args.push("--model", task.model);
    args.push(task.prompt);
    const child = spawn("codex", args, {
      cwd: task.workspace,
      env: { ...process.env, CHATGPT_CODE_AGENT_TASK_ID: task.id },
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.process = child;
    task.pid = child.pid;
    await this.persist(task);
    this.events.publish("agent", "Agent task started", "running", task.prompt, {
      taskId: task.id,
      pid: child.pid,
    });

    const append = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      task.output = limitText(task.output + text, 4_000_000);
      this.events.publish("agent", `Agent ${stream}`, "info", text, {
        taskId: task.id,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.once("error", async (error) => {
      task.status = "failed";
      task.output += `\n${error.message}`;
      task.finishedAt = new Date().toISOString();
      await this.persist(task);
      this.events.publish("agent", "Agent task failed", "error", error.message, {
        taskId: task.id,
      });
      void this.pump();
    });
    child.once("close", async (code) => {
      task.exitCode = code ?? -1;
      if (task.status !== "cancelled") {
        task.status = code === 0 ? "completed" : "failed";
      }
      if (task.status === "completed" && task.evaluation?.commands.length) {
        const results: string[] = [];
        let passed = true;
        for (const command of task.evaluation.commands) {
          const result = await this.terminal
            .run({ command, cwd: task.workspace, timeoutMs: 30 * 60 * 1000 })
            .catch((error: unknown) => ({
              sessionId: "",
              status: "failed" as const,
              output: String(error),
              exitCode: -1,
            }));
          results.push(`$ ${command}\n${result.output}`);
          if (result.status !== "completed") passed = false;
        }
        task.evaluation.passed = passed;
        task.evaluation.output = limitText(results.join("\n\n"), 500_000);
        if (!passed) task.status = "failed";
      }
      task.finishedAt = new Date().toISOString();
      await this.persist(task);
      this.events.publish(
        "agent",
        "Agent task finished",
        task.status === "completed" ? "success" : "error",
        `${task.id}: ${task.status}`,
      );
      void this.pump();
    });
  }

  get(id: string): AgentTask {
    const task = this.tasks.get(id)?.task;
    if (!task) throw new Error(`Unknown agent task: ${id}`);
    return { ...task, output: limitText(task.output, 500_000) };
  }

  list(): AgentTask[] {
    return [...this.tasks.values()]
      .map(({ task }) => ({ ...task, output: limitText(task.output, 20_000) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async cancel(id: string): Promise<{ cancelled: boolean }> {
    const live = this.tasks.get(id);
    if (!live || !["queued", "running"].includes(live.task.status)) {
      return { cancelled: false };
    }
    live.task.status = "cancelled";
    live.task.finishedAt = new Date().toISOString();
    live.process?.kill("SIGTERM");
    const queueIndex = this.queue.indexOf(id);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    await this.persist(live.task);
    this.events.publish("agent", "Agent task cancelled", "warning", id);
    return { cancelled: true };
  }

  async evaluate(input: {
    workspace?: string;
    commands: string[];
  }): Promise<{
    passed: boolean;
    results: Array<{
      command: string;
      passed: boolean;
      exitCode?: number;
      output: string;
    }>;
  }> {
    const workspace = await this.paths.workspace(input.workspace);
    const results = [];
    for (const command of input.commands.slice(0, 20)) {
      const result = await this.terminal.run({
        command,
        cwd: workspace,
        timeoutMs: 30 * 60 * 1000,
      });
      results.push({
        command,
        passed: result.status === "completed",
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        output: result.output,
      });
    }
    const passed = results.every((result) => result.passed);
    this.events.publish(
      "agent",
      "Evaluation completed",
      passed ? "success" : "error",
      `${results.filter((result) => result.passed).length}/${results.length} passed`,
    );
    return { passed, results };
  }

  private async persist(task: AgentTask): Promise<void> {
    await mkdir(this.taskDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(this.taskDirectory, `${task.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, target);
  }
}
