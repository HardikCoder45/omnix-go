import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ActivityStore } from "../src/events.js";
import { AutomationManager, nextCronDate } from "../src/automations.js";
import type { AgentHarness } from "../src/harness.js";
import type { AgentTask } from "../src/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnix-automation-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeHarness {
  prompts: string[] = [];
  cancelled: string[] = [];

  async start(input: { prompt: string; workspace?: string }): Promise<AgentTask> {
    this.prompts.push(input.prompt);
    const taskId = `agent-${this.prompts.length}`;
    return {
      id: taskId,
      prompt: input.prompt,
      workspace: input.workspace ?? process.cwd(),
      status: "completed",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      output: "done",
      latestAssistant: `Completed ${input.prompt}`,
      conversationId: `conversation-${this.prompts.length}`,
      conversationUrl: `https://chatgpt.com/c/conversation-${this.prompts.length}`,
    };
  }

  async refresh(reference: string): Promise<AgentTask> {
    throw new Error(`Unexpected refresh: ${reference}`);
  }

  async cancelMany(input: { references: string[] }): Promise<{ cancelled: string[] }> {
    this.cancelled.push(...input.references);
    return { cancelled: input.references };
  }
}

async function manager(): Promise<{ manager: AutomationManager; harness: FakeHarness; dataDir: string }> {
  const dataDir = await temporaryDirectory();
  const workspace = await temporaryDirectory();
  const { config } = await loadConfig({ cwd: workspace, dataDir, workspaceRoots: [workspace] });
  const harness = new FakeHarness();
  const automation = new AutomationManager(config, new ActivityStore(), harness as unknown as AgentHarness);
  await automation.initialize(false);
  return { manager: automation, harness, dataDir };
}

describe("AutomationManager", () => {
  it("runs parallel agent branches and joins only after both complete", async () => {
    const { manager: automation, harness } = await manager();
    const workflow = await automation.saveWorkflow({
      name: "Parallel review",
      nodes: [
        { id: "start", type: "split", name: "Parallel", x: 0, y: 0 },
        { id: "a", type: "agent", name: "Architecture", x: 200, y: 0, prompt: "Review architecture" },
        { id: "b", type: "agent", name: "Tests", x: 200, y: 120, prompt: "Review tests" },
        { id: "join", type: "join", name: "Join", x: 420, y: 60 },
      ],
      edges: [
        { id: "sa", source: "start", target: "a" },
        { id: "sb", source: "start", target: "b" },
        { id: "aj", source: "a", target: "join" },
        { id: "bj", source: "b", target: "join" },
      ],
    });
    const started = automation.startWorkflow(workflow.id, {});
    const run = await automation.waitForRun(started.id, 2_000);
    expect(run.status).toBe("completed");
    expect(harness.prompts.sort()).toEqual(["Review architecture", "Review tests"]);
    expect(run.nodeRuns.join?.visits).toBe(1);
    expect(run.nodeRuns.a?.conversationIds).toHaveLength(1);
    expect(run.nodeRuns.a?.conversationUrls[0]).toMatch(/^https:\/\/chatgpt\.com\/c\/conversation-/);
  });

  it("executes bounded loop and done branches without an unbounded graph", async () => {
    const { manager: automation, harness } = await manager();
    const workflow = await automation.saveWorkflow({
      name: "Iterative research",
      nodes: [
        { id: "start", type: "split", name: "Start", x: 0, y: 0 },
        { id: "loop", type: "loop", name: "Two passes", x: 150, y: 0, iterations: 2 },
        { id: "body", type: "agent", name: "Research", x: 300, y: 0, prompt: "Research {{input.topic}}" },
        { id: "done", type: "agent", name: "Summarize", x: 300, y: 150, prompt: "Summarize {{input.topic}}" },
      ],
      edges: [
        { id: "sl", source: "start", target: "loop" },
        { id: "lb", source: "loop", target: "body", sourcePort: "loop" },
        { id: "bl", source: "body", target: "loop" },
        { id: "ld", source: "loop", target: "done", sourcePort: "done" },
      ],
    });
    const started = automation.startWorkflow(workflow.id, { topic: "MCP auth" });
    const run = await automation.waitForRun(started.id, 2_000);
    expect(run.status).toBe("completed");
    expect(harness.prompts).toEqual(["Research MCP auth", "Research MCP auth", "Summarize MCP auth"]);
    expect(run.nodeRuns.loop?.visits).toBe(3);
    expect(run.nodeRuns.body?.visits).toBe(2);
  });

  it("persists workflows and schedules and computes timezone-aware next runs", async () => {
    const { manager: first, dataDir } = await manager();
    const workflow = await first.saveWorkflow({
      name: "Hourly worker",
      nodes: [{ id: "agent", type: "agent", name: "Worker", x: 0, y: 0, prompt: "Do the work" }],
      edges: [],
    });
    const schedule = await first.saveSchedule({ name: "Every hour", workflowId: workflow.id, cron: "@hourly", timezone: "Asia/Kolkata" });
    expect(new Date(schedule.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(nextCronDate("0 9 * * *", "Asia/Kolkata", new Date("2026-09-02T00:00:00Z")).toISOString()).toBe("2026-09-02T03:30:00.000Z");

    const workspace = await temporaryDirectory();
    const { config } = await loadConfig({ cwd: workspace, dataDir, workspaceRoots: [workspace] });
    const restored = new AutomationManager(config, new ActivityStore(), new FakeHarness() as unknown as AgentHarness);
    await restored.initialize(false);
    expect(restored.listWorkflows()).toHaveLength(1);
    expect(restored.listSchedules()).toHaveLength(1);
  });
});
