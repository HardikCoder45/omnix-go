import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { ActivityStore } from "./events.js";
import type { AgentHarness } from "./harness.js";
import type {
  AgentTask,
  AppConfig,
  CronSchedule,
  CustomAgentProfile,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
} from "./types.js";

const MAX_WORKFLOWS = 250;
const MAX_NODES = 120;
const MAX_VISITS = 50;
const MAX_RUN_HISTORY = 500;
const DEFAULT_AGENT_TIMEOUT = 4 * 60 * 60 * 1000;
const AGENT_POLL_MS = 12_000;

interface AutomationStore {
  agents: CustomAgentProfile[];
  workflows: WorkflowDefinition[];
  schedules: CronSchedule[];
}

interface RunContext {
  run: WorkflowRun;
  workflow: WorkflowDefinition;
  joinArrivals: Map<string, Set<string>>;
}

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cleanText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function compactProgress(task: AgentTask): string | undefined {
  const source = task.latestAssistant || task.error || task.output;
  if (!source) return undefined;
  return source.replace(/\s+/g, " ").trim().slice(-420);
}

function inputValue(input: Record<string, unknown>, key?: string): unknown {
  if (!key) return undefined;
  return key.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

function renderTemplate(template: string, run: WorkflowRun): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (key === "run.id") return run.id;
    if (key === "workflow.id") return run.workflowId;
    if (key === "input") return JSON.stringify(run.input);
    const value = key.startsWith("input.")
      ? inputValue(run.input, key.slice("input.".length))
      : undefined;
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function nextCronDate(
  expression: string,
  timezone: string,
  currentDate: Date = new Date(),
): Date {
  return CronExpressionParser.parse(expression, {
    currentDate,
    tz: timezone,
    hashSeed: expression,
  }).next().toDate();
}

export class AutomationManager {
  private readonly storeFile: string;
  private readonly runsFile: string;
  private store: AutomationStore = { agents: [], workflows: [], schedules: [] };
  private runs: WorkflowRun[] = [];
  private scheduler?: NodeJS.Timeout;
  private agentSlots = 0;
  private readonly agentWaiters: Array<() => void> = [];
  private storeWrite: Promise<void> = Promise.resolve();
  private runsWrite: Promise<void> = Promise.resolve();

  private isCancelled(run: WorkflowRun): boolean {
    return (run.status as WorkflowRun["status"]) === "cancelled";
  }

  constructor(
    private readonly config: AppConfig,
    private readonly events: ActivityStore,
    private readonly harness: AgentHarness,
  ) {
    this.storeFile = path.join(config.dataDir, "automations.json");
    this.runsFile = path.join(config.dataDir, "workflow-runs.json");
  }

  async initialize(startScheduler = true): Promise<void> {
    this.store = await readJson<AutomationStore>(this.storeFile, {
      agents: [],
      workflows: [],
      schedules: [],
    });
    this.runs = await readJson<WorkflowRun[]>(this.runsFile, []);
    let changed = false;
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "interrupted";
        run.finishedAt = now();
        run.error = "OmniX Go restarted while this workflow was active. Run it again to resume safely without duplicating browser messages.";
        changed = true;
      }
    }
    for (const schedule of this.store.schedules) {
      try {
        schedule.nextRunAt = nextCronDate(schedule.cron, schedule.timezone).toISOString();
      } catch (error) {
        schedule.enabled = false;
        schedule.nextRunAt = undefined;
        this.events.publish(
          "automation",
          "Cron disabled after restore",
          "warning",
          `${schedule.name}: ${String(error)}`,
        );
        changed = true;
      }
    }
    if (changed) await Promise.all([this.persistStore(), this.persistRuns()]);
    if (startScheduler) this.startScheduler();
  }

  stop(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  snapshot(): {
    customAgents: CustomAgentProfile[];
    workflows: WorkflowDefinition[];
    schedules: CronSchedule[];
    workflowRuns: WorkflowRun[];
  } {
    return {
      customAgents: clone(this.store.agents),
      workflows: clone(this.store.workflows),
      schedules: clone(this.store.schedules),
      workflowRuns: clone(this.runs.slice(0, 100)),
    };
  }

  listCustomAgents(): CustomAgentProfile[] {
    return clone(this.store.agents);
  }

  async saveCustomAgent(input: {
    id?: string;
    name: string;
    description?: string;
    prompt: string;
    workspace?: string;
    model?: string;
    evaluationCommands?: string[];
    tags?: string[];
  }): Promise<CustomAgentProfile> {
    const name = cleanText(input.name);
    const prompt = cleanText(input.prompt);
    if (!name || !prompt) throw new Error("Custom agent name and prompt are required.");
    const existing = input.id
      ? this.store.agents.find((item) => item.id === input.id)
      : undefined;
    const timestamp = now();
    const profile: CustomAgentProfile = {
      id: existing?.id ?? randomUUID(),
      name: name.slice(0, 120),
      ...(cleanText(input.description) ? { description: cleanText(input.description).slice(0, 1_000) } : {}),
      prompt: prompt.slice(0, 20_000),
      ...(cleanText(input.workspace) ? { workspace: cleanText(input.workspace) } : {}),
      ...(cleanText(input.model) ? { model: cleanText(input.model) } : {}),
      evaluationCommands: (input.evaluationCommands ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 20),
      tags: (input.tags ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 20),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (existing) Object.assign(existing, profile);
    else this.store.agents.push(profile);
    await this.persistStore();
    this.events.publish("automation", "Custom agent saved", "success", profile.name, { agentId: profile.id });
    return clone(profile);
  }

  async deleteCustomAgent(id: string): Promise<{ deleted: boolean }> {
    const referenced = this.store.workflows.some((workflow) =>
      workflow.nodes.some((node) => node.agentTemplateId === id),
    );
    if (referenced) throw new Error("Custom agent is used by a workflow and cannot be deleted.");
    const before = this.store.agents.length;
    this.store.agents = this.store.agents.filter((item) => item.id !== id);
    if (this.store.agents.length === before) return { deleted: false };
    await this.persistStore();
    this.events.publish("automation", "Custom agent deleted", "warning", id);
    return { deleted: true };
  }

  async startCustomAgent(id: string, prompt?: string): Promise<AgentTask> {
    const profile = this.store.agents.find((item) => item.id === id);
    if (!profile) throw new Error(`Custom agent not found: ${id}`);
    return this.harness.start({
      prompt: [profile.prompt, cleanText(prompt)].filter(Boolean).join("\n\n"),
      ...(profile.workspace ? { workspace: profile.workspace } : {}),
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.evaluationCommands.length ? { evaluationCommands: profile.evaluationCommands } : {}),
    });
  }

  listWorkflows(): WorkflowDefinition[] {
    return clone(this.store.workflows);
  }

  getWorkflow(id: string): WorkflowDefinition {
    const workflow = this.store.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    return clone(workflow);
  }

  async saveWorkflow(input: {
    id?: string;
    name: string;
    description?: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    enabled?: boolean;
  }): Promise<WorkflowDefinition> {
    const existing = input.id
      ? this.store.workflows.find((item) => item.id === input.id)
      : undefined;
    if (!existing && this.store.workflows.length >= MAX_WORKFLOWS) {
      throw new Error(`Workflow limit reached (${MAX_WORKFLOWS}).`);
    }
    const timestamp = now();
    const workflow: WorkflowDefinition = {
      id: existing?.id ?? randomUUID(),
      name: cleanText(input.name).slice(0, 160),
      ...(cleanText(input.description) ? { description: cleanText(input.description).slice(0, 2_000) } : {}),
      nodes: clone(input.nodes),
      edges: clone(input.edges),
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.validateWorkflow(workflow);
    if (existing) Object.assign(existing, workflow);
    else this.store.workflows.push(workflow);
    await this.persistStore();
    this.events.publish("automation", "Workflow saved", "success", workflow.name, {
      workflowId: workflow.id,
      nodes: workflow.nodes.length,
      edges: workflow.edges.length,
    });
    return clone(workflow);
  }

  async deleteWorkflow(id: string): Promise<{ deleted: boolean }> {
    if (this.store.schedules.some((schedule) => schedule.workflowId === id)) {
      throw new Error("Workflow has one or more cron schedules and cannot be deleted.");
    }
    if (this.store.workflows.some((workflow) =>
      workflow.nodes.some((node) => node.type === "subworkflow" && node.workflowId === id),
    )) {
      throw new Error("Workflow is referenced as a sub-workflow and cannot be deleted.");
    }
    const before = this.store.workflows.length;
    this.store.workflows = this.store.workflows.filter((item) => item.id !== id);
    if (before === this.store.workflows.length) return { deleted: false };
    await this.persistStore();
    this.events.publish("automation", "Workflow deleted", "warning", id);
    return { deleted: true };
  }

  startWorkflow(
    workflowId: string,
    input: Record<string, unknown> = {},
    meta: { trigger?: WorkflowRun["trigger"]; scheduleId?: string; parentRunId?: string } = {},
  ): WorkflowRun {
    const workflow = this.store.workflows.find((item) => item.id === workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    if (!workflow.enabled) throw new Error(`Workflow is disabled: ${workflow.name}`);
    this.validateWorkflow(workflow);
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      trigger: meta.trigger ?? "manual",
      ...(meta.scheduleId ? { scheduleId: meta.scheduleId } : {}),
      ...(meta.parentRunId ? { parentRunId: meta.parentRunId } : {}),
      input: clone(input),
      status: "queued",
      createdAt: now(),
      nodeRuns: Object.fromEntries(
        workflow.nodes.map((node) => [node.id, this.blankNodeRun(node.id)]),
      ),
    };
    this.runs.unshift(run);
    this.runs = this.runs.slice(0, MAX_RUN_HISTORY);
    void this.persistRuns();
    void this.executeRun(run, workflow);
    return clone(run);
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    return clone(this.runs.filter((run) => !workflowId || run.workflowId === workflowId).slice(0, 100));
  }

  getRun(id: string): WorkflowRun {
    const run = this.runs.find((item) => item.id === id);
    if (!run) throw new Error(`Workflow run not found: ${id}`);
    return clone(run);
  }

  async waitForRun(id: string, timeoutMs = 30_000): Promise<WorkflowRun> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const run = this.getRun(id);
      if (!["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Workflow run ${id} did not finish within ${timeoutMs}ms.`);
  }

  async cancelRun(id: string): Promise<WorkflowRun> {
    const run = this.runs.find((item) => item.id === id);
    if (!run) throw new Error(`Workflow run not found: ${id}`);
    if (!["queued", "running"].includes(run.status)) return clone(run);
    run.status = "cancelled";
    run.finishedAt = now();
    const agentIds = Object.values(run.nodeRuns).flatMap((node) => node.agentIds);
    if (agentIds.length) await this.harness.cancelMany({ agents: agentIds }).catch(() => undefined);
    await this.persistRuns();
    this.events.publish("automation", "Workflow run cancelled", "warning", run.workflowName, { runId: run.id });
    return clone(run);
  }

  listSchedules(): CronSchedule[] {
    return clone(this.store.schedules);
  }

  async saveSchedule(input: {
    id?: string;
    name: string;
    workflowId: string;
    cron: string;
    timezone?: string;
    enabled?: boolean;
    overlapPolicy?: "skip" | "parallel";
    input?: Record<string, unknown>;
  }): Promise<CronSchedule> {
    if (!this.store.workflows.some((workflow) => workflow.id === input.workflowId)) {
      throw new Error(`Workflow not found: ${input.workflowId}`);
    }
    const timezone = cleanText(input.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    const cron = cleanText(input.cron);
    const nextRunAt = nextCronDate(cron, timezone).toISOString();
    const existing = input.id
      ? this.store.schedules.find((item) => item.id === input.id)
      : undefined;
    const timestamp = now();
    const schedule: CronSchedule = {
      id: existing?.id ?? randomUUID(),
      name: cleanText(input.name).slice(0, 160),
      workflowId: input.workflowId,
      cron,
      timezone,
      enabled: input.enabled ?? existing?.enabled ?? true,
      overlapPolicy: input.overlapPolicy ?? existing?.overlapPolicy ?? "skip",
      input: clone(input.input ?? existing?.input ?? {}),
      nextRunAt,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastRunId ? { lastRunId: existing.lastRunId } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (!schedule.name) throw new Error("Schedule name is required.");
    if (existing) Object.assign(existing, schedule);
    else this.store.schedules.push(schedule);
    await this.persistStore();
    this.events.publish("automation", "Cron schedule saved", "success", schedule.name, {
      scheduleId: schedule.id,
      cron: schedule.cron,
      nextRunAt: schedule.nextRunAt,
    });
    return clone(schedule);
  }

  async toggleSchedule(id: string, enabled: boolean): Promise<CronSchedule> {
    const schedule = this.store.schedules.find((item) => item.id === id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    schedule.enabled = enabled;
    schedule.updatedAt = now();
    schedule.nextRunAt = enabled
      ? nextCronDate(schedule.cron, schedule.timezone).toISOString()
      : undefined;
    await this.persistStore();
    this.events.publish("automation", enabled ? "Cron enabled" : "Cron paused", "success", schedule.name);
    return clone(schedule);
  }

  async deleteSchedule(id: string): Promise<{ deleted: boolean }> {
    const before = this.store.schedules.length;
    this.store.schedules = this.store.schedules.filter((item) => item.id !== id);
    if (before === this.store.schedules.length) return { deleted: false };
    await this.persistStore();
    this.events.publish("automation", "Cron schedule deleted", "warning", id);
    return { deleted: true };
  }

  async runScheduleNow(id: string): Promise<WorkflowRun> {
    const schedule = this.store.schedules.find((item) => item.id === id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    const run = this.startWorkflow(schedule.workflowId, schedule.input, {
      trigger: "cron",
      scheduleId: schedule.id,
    });
    schedule.lastRunAt = now();
    schedule.lastRunId = run.id;
    schedule.nextRunAt = nextCronDate(schedule.cron, schedule.timezone).toISOString();
    await this.persistStore();
    return run;
  }

  private validateWorkflow(workflow: WorkflowDefinition): void {
    if (!cleanText(workflow.name)) throw new Error("Workflow name is required.");
    if (!workflow.nodes.length) throw new Error("Workflow needs at least one node.");
    if (workflow.nodes.length > MAX_NODES) throw new Error(`Workflow supports at most ${MAX_NODES} nodes.`);
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    if (nodeIds.size !== workflow.nodes.length) throw new Error("Workflow node IDs must be unique.");
    const edgeIds = new Set(workflow.edges.map((edge) => edge.id));
    if (edgeIds.size !== workflow.edges.length) throw new Error("Workflow edge IDs must be unique.");
    for (const edge of workflow.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        throw new Error(`Workflow edge ${edge.id} references an unknown node.`);
      }
    }
    for (const node of workflow.nodes) {
      if (node.type === "agent" && !node.prompt && !node.agentTemplateId) {
        throw new Error(`Agent node ${node.name} needs a prompt or custom agent.`);
      }
      if (node.type === "loop" && (!node.iterations || node.iterations < 1 || node.iterations > 50)) {
        throw new Error(`Loop node ${node.name} needs 1–50 iterations.`);
      }
      if (node.type === "subworkflow" && (!node.workflowId || node.workflowId === workflow.id)) {
        throw new Error(`Sub-workflow node ${node.name} has an invalid workflow reference.`);
      }
    }
  }

  private blankNodeRun(nodeId: string): WorkflowNodeRun {
    return { nodeId, status: "queued", visits: 0, agentIds: [], conversationIds: [], conversationUrls: [] };
  }

  private async executeRun(run: WorkflowRun, workflow: WorkflowDefinition): Promise<void> {
    run.status = "running";
    run.startedAt = now();
    await this.persistRuns();
    this.events.publish("automation", "Workflow started", "running", workflow.name, { runId: run.id });
    try {
      const incoming = new Map(workflow.nodes.map((node) => [node.id, 0]));
      for (const edge of workflow.edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
      const starts = workflow.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
      if (!starts.length) throw new Error("Workflow has no start node. A bounded loop must still be reachable from an acyclic start.");
      const context: RunContext = { run, workflow, joinArrivals: new Map() };
      await Promise.all(starts.map((node) => this.executeNode(context, node.id)));
      if (this.isCancelled(run)) return;
      run.status = "completed";
      run.finishedAt = now();
      await this.persistRuns();
      this.events.publish("automation", "Workflow completed", "success", workflow.name, { runId: run.id });
    } catch (error) {
      if (this.isCancelled(run)) return;
      run.status = "failed";
      run.finishedAt = now();
      run.error = error instanceof Error ? error.message : String(error);
      await this.persistRuns();
      this.events.publish("automation", "Workflow failed", "error", `${workflow.name}: ${run.error}`, { runId: run.id });
    }
  }

  private async executeNode(context: RunContext, nodeId: string, incomingEdgeId?: string): Promise<void> {
    const { run, workflow } = context;
    if (this.isCancelled(run)) return;
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Workflow node disappeared: ${nodeId}`);
    if (node.type === "join") {
      const inbound = workflow.edges.filter((edge) => edge.target === node.id);
      const arrivals = context.joinArrivals.get(node.id) ?? new Set<string>();
      if (incomingEdgeId) arrivals.add(incomingEdgeId);
      context.joinArrivals.set(node.id, arrivals);
      if (arrivals.size < inbound.length) return;
      context.joinArrivals.set(node.id, new Set());
    }

    const state = run.nodeRuns[node.id] ?? this.blankNodeRun(node.id);
    run.nodeRuns[node.id] = state;
    state.visits += 1;
    if (state.visits > MAX_VISITS) throw new Error(`Node ${node.name} exceeded ${MAX_VISITS} visits. Check loop edges.`);
    state.status = "running";
    state.startedAt = now();
    delete state.finishedAt;
    delete state.error;
    await this.persistRuns();
    this.events.publish("automation", "Workflow node running", "running", node.name, {
      runId: run.id,
      nodeId: node.id,
      visit: state.visits,
    });

    let port: WorkflowEdge["sourcePort"] = "success";
    try {
      if (node.type === "agent") await this.executeAgentNode(context, node, state);
      else if (node.type === "delay") {
        const duration = Math.min(Math.max(node.delayMs ?? 1_000, 0), 24 * 60 * 60 * 1000);
        state.progress = `Waiting ${duration}ms`;
        await new Promise((resolve) => setTimeout(resolve, duration));
      } else if (node.type === "condition") {
        const value = inputValue(run.input, node.conditionKey);
        const result = node.condition === "always"
          ? true
          : node.condition === "input_equals"
            ? String(value ?? "") === String(node.conditionValue ?? "")
            : Boolean(value);
        port = result ? "true" : "false";
        state.progress = result ? "Condition matched" : "Condition did not match";
      } else if (node.type === "loop") {
        port = state.visits <= (node.iterations ?? 1) ? "loop" : "done";
        state.progress = `${Math.min(state.visits, node.iterations ?? 1)} / ${node.iterations ?? 1}`;
      } else if (node.type === "subworkflow") {
        const child = this.startWorkflow(node.workflowId!, run.input, {
          trigger: "workflow",
          parentRunId: run.id,
        });
        state.progress = `Child run ${child.id.slice(0, 8)}`;
        const finished = await this.waitForRun(child.id, node.timeoutMs ?? DEFAULT_AGENT_TIMEOUT);
        if (finished.status !== "completed") throw new Error(`Sub-workflow ${finished.workflowName} ${finished.status}.`);
      }
      if (this.isCancelled(run)) return;
      state.status = "completed";
      state.finishedAt = now();
      await this.persistRuns();
    } catch (error) {
      state.status = "failed";
      state.finishedAt = now();
      state.error = error instanceof Error ? error.message : String(error);
      port = "failure";
      await this.persistRuns();
    }

    const outgoing = workflow.edges.filter((edge) =>
      edge.source === node.id && this.edgeMatches(edge.sourcePort, port),
    );
    if (state.status === "failed" && !outgoing.length) throw new Error(state.error ?? `Node ${node.name} failed.`);
    await Promise.all(outgoing.map((edge) => this.executeNode(context, edge.target, edge.id)));
  }

  private edgeMatches(edgePort: WorkflowEdge["sourcePort"], resultPort: WorkflowEdge["sourcePort"]): boolean {
    const port = edgePort ?? "always";
    if (port === "always") return !["true", "false", "loop", "done", "failure"].includes(resultPort ?? "success");
    return port === resultPort;
  }

  private async executeAgentNode(
    context: RunContext,
    node: WorkflowNode,
    state: WorkflowNodeRun,
  ): Promise<void> {
    const profile = node.agentTemplateId
      ? this.store.agents.find((item) => item.id === node.agentTemplateId)
      : undefined;
    if (node.agentTemplateId && !profile) throw new Error(`Custom agent not found: ${node.agentTemplateId}`);
    const prompt = renderTemplate(
      [profile?.prompt, node.prompt].map((item) => cleanText(item)).filter(Boolean).join("\n\n"),
      context.run,
    );
    if (!prompt) throw new Error(`Agent node ${node.name} has an empty prompt.`);
    const task = await this.withAgentSlot(() => this.harness.start({
      prompt,
      ...(node.workspace || profile?.workspace ? { workspace: node.workspace || profile?.workspace } : {}),
      ...(profile?.model ? { model: profile.model } : {}),
      evaluationCommands: (node.evaluationCommands?.length
        ? node.evaluationCommands
        : profile?.evaluationCommands ?? []).slice(0, 20),
    }));
    this.captureAgentState(state, task);
    await this.persistRuns();
    if (node.waitForCompletion === false || task.status === "completed") return;
    if (task.status === "failed" || task.status === "cancelled") {
      throw new Error(task.error ?? `Agent ${task.id} ${task.status}.`);
    }
    const deadline = Date.now() + Math.min(Math.max(node.timeoutMs ?? DEFAULT_AGENT_TIMEOUT, 10_000), 24 * 60 * 60 * 1000);
    let current = task;
    while (Date.now() < deadline) {
      if (this.isCancelled(context.run)) return;
      await new Promise((resolve) => setTimeout(resolve, AGENT_POLL_MS));
      current = await this.withAgentSlot(() => this.harness.refresh(task.id));
      this.captureAgentState(state, current);
      await this.persistRuns();
      this.events.publish("automation", "Agent progress refreshed", current.status === "running" ? "running" : "info", node.name, {
        runId: context.run.id,
        nodeId: node.id,
        agentId: current.id,
        conversationId: current.conversationId,
        progress: state.progress,
      });
      if (current.status === "completed") return;
      if (current.status === "failed" || current.status === "cancelled") {
        throw new Error(current.error ?? `Agent ${current.id} ${current.status}.`);
      }
    }
    throw new Error(`Agent node ${node.name} timed out.`);
  }

  private captureAgentState(state: WorkflowNodeRun, task: AgentTask): void {
    if (!state.agentIds.includes(task.id)) state.agentIds.push(task.id);
    if (task.conversationId && !state.conversationIds.includes(task.conversationId)) {
      state.conversationIds.push(task.conversationId);
    }
    if (task.conversationUrl && !state.conversationUrls.includes(task.conversationUrl)) {
      state.conversationUrls.push(task.conversationUrl);
    }
    state.progress = compactProgress(task) ?? `${task.status} · ${task.agentName ?? task.id.slice(0, 8)}`;
  }

  private async withAgentSlot<T>(operation: () => Promise<T>): Promise<T> {
    const limit = Math.max(1, Math.min(this.config.maxParallelAgents, 12));
    if (this.agentSlots >= limit) {
      await new Promise<void>((resolve) => this.agentWaiters.push(resolve));
    }
    this.agentSlots += 1;
    try {
      return await operation();
    } finally {
      this.agentSlots -= 1;
      this.agentWaiters.shift()?.();
    }
  }

  private startScheduler(): void {
    if (this.scheduler) return;
    this.scheduler = setInterval(() => void this.tickSchedules(), 1_000);
    this.scheduler.unref();
  }

  private async tickSchedules(): Promise<void> {
    const timestamp = Date.now();
    let changed = false;
    for (const schedule of this.store.schedules.filter((item) => item.enabled)) {
      if (!schedule.nextRunAt) {
        schedule.nextRunAt = nextCronDate(schedule.cron, schedule.timezone).toISOString();
        changed = true;
        continue;
      }
      if (Date.parse(schedule.nextRunAt) > timestamp) continue;
      const active = this.runs.some((run) =>
        run.workflowId === schedule.workflowId && ["queued", "running"].includes(run.status),
      );
      if (active && schedule.overlapPolicy === "skip") {
        this.events.publish("automation", "Cron run skipped", "warning", `${schedule.name}: workflow already active`);
      } else {
        const run = this.startWorkflow(schedule.workflowId, schedule.input, {
          trigger: "cron",
          scheduleId: schedule.id,
        });
        schedule.lastRunAt = now();
        schedule.lastRunId = run.id;
      }
      schedule.nextRunAt = nextCronDate(schedule.cron, schedule.timezone, new Date(timestamp + 1_000)).toISOString();
      schedule.updatedAt = now();
      changed = true;
    }
    if (changed) await this.persistStore();
  }

  private async persistStore(): Promise<void> {
    const snapshot = clone(this.store);
    this.storeWrite = this.storeWrite.catch(() => undefined).then(() => writeJson(this.storeFile, snapshot));
    await this.storeWrite;
  }

  private async persistRuns(): Promise<void> {
    const snapshot = clone(this.runs.slice(0, MAX_RUN_HISTORY));
    this.runsWrite = this.runsWrite.catch(() => undefined).then(() => writeJson(this.runsFile, snapshot));
    await this.runsWrite;
  }
}
