import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityStore } from "./events.js";
import {
  DefaultChatGptBrowser,
  formatAgentPrompt,
  parseConversationId,
  type AgentBrowser,
  type AgentConversationTarget,
} from "./chatgpt-browser.js";
import type {
  AgentTask,
  AppConfig,
  ChatGptConversationSnapshot,
} from "./types.js";
import type { PathGuard } from "./paths.js";
import type { TerminalChunk, TerminalManager } from "./terminal.js";
import { limitText } from "./utils.js";

const MAX_TRANSCRIPT_OUTPUT = 4_000_000;
const MAX_PAGE_TEXT = 4_000_000;

function transcriptOutput(snapshot: ChatGptConversationSnapshot): string {
  return limitText(
    snapshot.messages
      .map((message) => `${message.role.toUpperCase()}:\n${message.text}`)
      .join("\n\n"),
    MAX_TRANSCRIPT_OUTPUT,
  );
}

function cloneTask(task: AgentTask, outputLimit = 500_000): AgentTask {
  return {
    ...task,
    output: limitText(task.output, outputLimit),
    ...(task.transcript
      ? { transcript: task.transcript.map((message) => ({ ...message })) }
      : {}),
    ...(task.evaluation
      ? {
          evaluation: {
            ...task.evaluation,
            commands: [...task.evaluation.commands],
          },
        }
      : {}),
  };
}

export class AgentHarness {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly taskDirectory: string;
  private readonly browser: AgentBrowser;

  constructor(
    private readonly config: AppConfig,
    private readonly paths: PathGuard,
    private readonly terminal: TerminalManager,
    private readonly events: ActivityStore,
    browser?: AgentBrowser,
  ) {
    this.taskDirectory = path.join(config.dataDir, "tasks");
    this.browser = browser ?? new DefaultChatGptBrowser();
  }

  async restore(): Promise<void> {
    await mkdir(this.taskDirectory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.taskDirectory).catch(() => []);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const task = JSON.parse(
          await readFile(path.join(this.taskDirectory, file), "utf8"),
        ) as AgentTask;
        if (!task.backend) task.backend = "codex";
        if (task.backend === "chatgpt" && !task.agentName) {
          task.agentName = `OmniXGo-${task.id.slice(0, 8)}`;
        }
        if (
          task.backend === "codex" &&
          (task.status === "running" || task.status === "queued")
        ) {
          task.status = "failed";
          task.finishedAt = new Date().toISOString();
          task.output = limitText(
            `${task.output}\nLegacy Codex task was interrupted before the ChatGPT conversation-backed agent migration.`,
            MAX_TRANSCRIPT_OUTPUT,
          );
        }
        this.tasks.set(task.id, task);
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
    batchId?: string;
  }): Promise<AgentTask> {
    const workspace = await this.paths.workspace(input.workspace);
    const id = randomUUID();
    const task: AgentTask = {
      id,
      agentName: `OmniXGo-${id.slice(0, 8)}`,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      prompt: input.prompt,
      workspace,
      backend: "chatgpt",
      status: "queued",
      createdAt: new Date().toISOString(),
      output: "",
      messagesSent: 0,
      ...(input.evaluationCommands?.length
        ? { evaluation: { commands: input.evaluationCommands.slice(0, 20) } }
        : {}),
      ...(input.model ? { model: input.model } : {}),
    };
    this.tasks.set(task.id, task);
    await this.persist(task);
    this.events.publish(
      "agent",
      "ChatGPT agent conversation queued",
      "running",
      input.prompt,
      { taskId: task.id, workspace, backend: "chatgpt" },
    );

    task.status = "running";
    task.startedAt = new Date().toISOString();
    await this.persist(task);
    try {
      const snapshot = await this.browser.createConversation(
        formatAgentPrompt({
          prompt: input.prompt,
          workspace,
          evaluationCommands: task.evaluation?.commands,
        }),
      );
      task.messagesSent = 1;
      this.applySnapshot(task, snapshot);
      await this.persist(task);
      this.events.publish(
        "agent",
        "ChatGPT agent conversation started",
        "running",
        task.conversationUrl ?? task.id,
        {
          taskId: task.id,
          tabId: task.tabId,
          conversationId: task.conversationId,
          conversationUrl: task.conversationUrl,
        },
      );
      return cloneTask(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task.status = "failed";
      task.error = message;
      task.finishedAt = new Date().toISOString();
      task.output = limitText(`${task.output}\n${message}`.trim(), MAX_TRANSCRIPT_OUTPUT);
      await this.persist(task);
      this.events.publish(
        "agent",
        "ChatGPT agent conversation failed",
        "error",
        message,
        { taskId: task.id },
      );
      throw new Error(`Agent ${task.id} failed to start: ${message}`);
    }
  }

  get(reference: string): AgentTask {
    return cloneTask(this.resolve(reference));
  }

  async startMany(input: {
    agents: Array<{
      prompt: string;
      workspace?: string;
      model?: string;
      evaluationCommands?: string[];
    }>;
  }): Promise<{
    batchId: string;
    tasks: AgentTask[];
    failures: Array<{ index: number; prompt: string; taskId?: string; error: string }>;
  }> {
    const batchId = randomUUID();
    const tasks: AgentTask[] = [];
    const failures: Array<{ index: number; prompt: string; taskId?: string; error: string }> = [];
    for (const [index, agent] of input.agents.entries()) {
      try {
        tasks.push(await this.start({ ...agent, batchId }));
      } catch (error) {
        const failed = [...this.tasks.values()].find(
          (task) => task.batchId === batchId && task.prompt === agent.prompt,
        );
        failures.push({
          index,
          prompt: agent.prompt,
          ...(failed ? { taskId: failed.id } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.events.publish(
      "agent",
      "ChatGPT agent batch started",
      failures.length ? "warning" : "success",
      `${tasks.length}/${input.agents.length} conversations started`,
      { batchId, taskIds: tasks.map((task) => task.id), failures },
    );
    return { batchId, tasks, failures };
  }

  list(batchId?: string): AgentTask[] {
    return [...this.tasks.values()]
      .filter((task) => batchId === undefined || task.batchId === batchId)
      .map((task) => cloneTask(task, 20_000))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async refresh(reference: string): Promise<AgentTask> {
    const task = this.resolve(reference);
    this.assertChatGptTask(task);
    try {
      const snapshot = await this.browser.readConversation(this.target(task));
      this.applySnapshot(task, snapshot);
      await this.persist(task);
      this.events.publish(
        "agent",
        "ChatGPT agent synchronized",
        snapshot.state === "responding" ? "running" : "info",
        task.conversationUrl ?? task.id,
        {
          taskId: task.id,
          conversationId: task.conversationId,
          messages: snapshot.messages.length,
          conversationState: snapshot.state,
        },
      );
      return cloneTask(task);
    } catch (error) {
      await this.recordBrowserFailure(task, error, "Agent synchronization failed");
      throw error;
    }
  }

  async followUp(reference: string, prompt: string): Promise<AgentTask> {
    const task = this.resolve(reference);
    this.assertChatGptTask(task);
    task.status = "running";
    delete task.finishedAt;
    delete task.error;
    await this.persist(task);
    try {
      const snapshot = await this.browser.sendMessage(
        this.target(task),
        formatAgentPrompt({ prompt }),
      );
      task.messagesSent = (task.messagesSent ?? 0) + 1;
      this.applySnapshot(task, snapshot);
      await this.persist(task);
      this.events.publish(
        "agent",
        "ChatGPT agent follow-up sent",
        "running",
        prompt,
        {
          taskId: task.id,
          conversationId: task.conversationId,
          conversationUrl: task.conversationUrl,
          messagesSent: task.messagesSent,
        },
      );
      return cloneTask(task);
    } catch (error) {
      await this.recordBrowserFailure(task, error, "Agent follow-up failed");
      throw error;
    }
  }

  async coordinate(input: {
    agents?: string[];
    batchId?: string;
    instruction?: string;
  }): Promise<{
    tasks: AgentTask[];
    failures: Array<{ agent: string; error: string }>;
  }> {
    const references = input.agents?.length
      ? input.agents
      : input.batchId
        ? [...this.tasks.values()]
            .filter((task) => task.backend === "chatgpt" && task.batchId === input.batchId)
            .map((task) => task.id)
      : [...this.tasks.values()]
          .filter((task) => task.backend === "chatgpt")
          .map((task) => task.id);
    const uniqueReferences = [...new Set(references)].slice(0, 50);
    const tasks: AgentTask[] = [];
    const failures: Array<{ agent: string; error: string }> = [];

    for (const reference of uniqueReferences) {
      try {
        tasks.push(
          input.instruction
            ? await this.followUp(reference, input.instruction)
            : await this.refresh(reference),
        );
      } catch (error) {
        failures.push({
          agent: reference,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.events.publish(
      "agent",
      input.instruction ? "Agent coordination instruction sent" : "Agents monitored",
      failures.length ? "warning" : "success",
      `${tasks.length} succeeded; ${failures.length} failed`,
      {
        agentCount: uniqueReferences.length,
        instruction: input.instruction,
      },
    );
    return { tasks, failures };
  }

  async cancel(reference: string): Promise<{
    cancelled: boolean;
    stopped: boolean;
    task?: AgentTask;
  }> {
    let task: AgentTask;
    try {
      task = this.resolve(reference);
    } catch {
      return { cancelled: false, stopped: false };
    }
    if (task.backend !== "chatgpt") {
      return { cancelled: false, stopped: false, task: cloneTask(task) };
    }
    try {
      const result = await this.browser.stopConversation(this.target(task));
      this.applySnapshot(task, result.snapshot);
      const shouldCancel = result.stopped;
      if (shouldCancel) {
        task.status = "cancelled";
        task.finishedAt = new Date().toISOString();
      }
      await this.persist(task);
      this.events.publish(
        "agent",
        shouldCancel ? "ChatGPT agent cancelled" : "ChatGPT agent was not active",
        shouldCancel ? "warning" : "info",
        task.conversationUrl ?? task.id,
        {
          taskId: task.id,
          conversationId: task.conversationId,
          stopped: result.stopped,
        },
      );
      return {
        cancelled: shouldCancel,
        stopped: result.stopped,
        task: cloneTask(task),
      };
    } catch (error) {
      await this.recordBrowserFailure(task, error, "Agent cancellation failed");
      throw error;
    }
  }

  async cancelMany(input: {
    agents?: string[];
    batchId?: string;
  }): Promise<{
    tasks: AgentTask[];
    failures: Array<{ agent: string; error: string }>;
  }> {
    const references = input.agents?.length
      ? input.agents
      : input.batchId
        ? [...this.tasks.values()]
            .filter((task) => task.backend === "chatgpt" && task.batchId === input.batchId)
            .map((task) => task.id)
        : [];
    const uniqueReferences = [...new Set(references)].slice(0, 50);
    if (!uniqueReferences.length) {
      throw new Error(
        input.batchId
          ? `No ChatGPT agents found for batch ${input.batchId}.`
          : "Provide at least one agent or batchId.",
      );
    }

    const tasks: AgentTask[] = [];
    const failures: Array<{ agent: string; error: string }> = [];
    for (const reference of uniqueReferences) {
      try {
        const result = await this.cancel(reference);
        if (result.task) {
          tasks.push(result.task);
        } else {
          failures.push({ agent: reference, error: "Agent was not found." });
        }
      } catch (error) {
        failures.push({
          agent: reference,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const stopped = tasks.filter((task) => task.status === "cancelled").length;
    this.events.publish(
      "agent",
      "ChatGPT agent stop requests completed",
      failures.length ? "warning" : "success",
      `${stopped}/${uniqueReferences.length} active responses stopped; ${failures.length} failed`,
      {
        agentCount: uniqueReferences.length,
        batchId: input.batchId,
        taskIds: tasks.map((task) => task.id),
        failures,
      },
    );
    return { tasks, failures };
  }

  async evaluate(input: {
    workspace?: string;
    commands: string[];
    onProgress?: (event: {
      stage: "command-start" | "command-output" | "command-complete";
      command: string;
      index: number;
      total: number;
      chunk?: TerminalChunk;
      passed?: boolean;
      exitCode?: number;
    }) => void | Promise<void>;
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
    const commands = input.commands.slice(0, 20);
    for (const [index, command] of commands.entries()) {
      await input.onProgress?.({
        stage: "command-start",
        command,
        index,
        total: commands.length,
      });
      const result = await this.terminal.run({
        command,
        cwd: workspace,
        timeoutMs: 30 * 60 * 1000,
        onChunk: input.onProgress
          ? async (chunk) => {
              await input.onProgress?.({
                stage: "command-output",
                command,
                index,
                total: commands.length,
                chunk,
              });
            }
          : undefined,
      });
      results.push({
        command,
        passed: result.status === "completed",
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        output: result.output,
      });
      await input.onProgress?.({
        stage: "command-complete",
        command,
        index,
        total: commands.length,
        passed: result.status === "completed",
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
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

  private resolve(reference: string): AgentTask {
    const cleanReference = reference.trim();
    const direct = this.tasks.get(cleanReference);
    if (direct) return direct;

    const conversationId = parseConversationId(cleanReference);
    const task = [...this.tasks.values()].find(
      (candidate) =>
        candidate.conversationUrl === cleanReference ||
        (conversationId && candidate.conversationId === conversationId),
    );
    if (!task) {
      throw new Error(
        `Unknown agent reference: ${reference}. Use a local task ID, persisted ChatGPT conversation ID, or conversation URL.`,
      );
    }
    return task;
  }

  private assertChatGptTask(task: AgentTask): void {
    if (task.backend !== "chatgpt") {
      throw new Error(
        `Agent ${task.id} is a legacy Codex task and has no ChatGPT conversation mapping.`,
      );
    }
  }

  private target(task: AgentTask): AgentConversationTarget {
    return {
      ...(task.tabId ? { tabId: task.tabId } : {}),
      ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      ...(task.conversationUrl ? { conversationUrl: task.conversationUrl } : {}),
    };
  }

  private applySnapshot(
    task: AgentTask,
    snapshot: ChatGptConversationSnapshot,
  ): void {
    task.backend = "chatgpt";
    task.browser = snapshot.browser;
    task.tabId = snapshot.tabId;
    task.conversationId = snapshot.conversationId;
    task.conversationUrl = snapshot.conversationUrl;
    task.conversationState = snapshot.state;
    task.transcript = snapshot.messages.map((message) => ({ ...message }));
    task.pageText = limitText(snapshot.pageText, MAX_PAGE_TEXT);
    task.latestAssistant = snapshot.latestAssistant;
    task.lastSyncedAt = snapshot.capturedAt;
    task.output = transcriptOutput(snapshot);
    delete task.error;

    if (task.status === "cancelled") return;
    if (snapshot.state === "login_required" || snapshot.state === "unavailable") {
      task.status = "failed";
      task.error =
        snapshot.state === "login_required"
          ? `ChatGPT login is required in ${snapshot.browser ?? "the default browser"}.`
          : snapshot.diagnostic ?? "The ChatGPT conversation page is unavailable.";
      task.finishedAt = new Date().toISOString();
      return;
    }
    const awaitingAssistant =
      snapshot.userMessageCount > snapshot.assistantMessageCount;
    task.status =
      snapshot.state === "responding" || awaitingAssistant ? "running" : "completed";
    if (task.status === "completed") {
      task.finishedAt = new Date().toISOString();
    } else {
      delete task.finishedAt;
    }
  }

  private async recordBrowserFailure(
    task: AgentTask,
    error: unknown,
    title: string,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    task.status = "failed";
    task.error = message;
    task.finishedAt = new Date().toISOString();
    task.output = limitText(`${task.output}\n${message}`.trim(), MAX_TRANSCRIPT_OUTPUT);
    await this.persist(task);
    this.events.publish("agent", title, "error", message, { taskId: task.id });
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
