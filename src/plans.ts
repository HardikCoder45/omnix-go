import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppConfig,
  PlanStatus,
  PlanStepStatus,
  WorkPlan,
} from "./types.js";
import type { ActivityStore } from "./events.js";

interface PlanStore {
  version: 1;
  activePlanId?: string;
  plans: WorkPlan[];
}

export interface PlanView extends WorkPlan {
  progress: {
    completed: number;
    total: number;
    percent: number;
    currentStepId?: string;
    allTasksComplete: boolean;
  };
}

interface NewPlan {
  goal: string;
  context?: string;
  successCriteria: string[];
  assumptions?: string[];
  steps: Array<{
    title: string;
    description?: string;
    verification?: string;
  }>;
}

interface StepUpdate {
  stepId: string;
  status: PlanStepStatus;
  note?: string;
}

export class PlanManager {
  private readonly storagePath: string;
  private store: PlanStore = { version: 1, plans: [] };
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    config: AppConfig,
    private readonly events: ActivityStore,
  ) {
    this.storagePath = path.join(config.dataDir, "plans.json");
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.storagePath, "utf8")) as PlanStore;
      if (parsed.version !== 1 || !Array.isArray(parsed.plans)) {
        throw new Error("unsupported plan store format");
      }
      this.store = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new Error(`Unable to load ${this.storagePath}: ${(error as Error).message}`);
      }
      await this.persist();
    }
  }

  async create(input: NewPlan): Promise<PlanView> {
    let result!: PlanView;
    await this.mutate(async () => {
      const now = new Date().toISOString();
      const plan: WorkPlan = {
        id: randomUUID(),
        goal: input.goal,
        ...(input.context === undefined ? {} : { context: input.context }),
        successCriteria: [...input.successCriteria],
        assumptions: [...(input.assumptions ?? [])],
        steps: input.steps.map((step) => ({
          id: randomUUID(),
          title: step.title,
          ...(step.description === undefined ? {} : { description: step.description }),
          ...(step.verification === undefined ? {} : { verification: step.verification }),
          status: "pending",
          notes: [],
          createdAt: now,
          updatedAt: now,
        })),
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      this.store.plans.push(plan);
      this.store.activePlanId = plan.id;
      await this.persist();
      result = this.view(plan);
      this.events.publish(
        "plan",
        "Plan created",
        "success",
        `${plan.steps.length} checklist steps · ${plan.goal}`,
        result,
      );
    });
    return result;
  }

  get(id?: string): PlanView {
    const plan = this.resolve(id);
    return this.view(plan);
  }

  list(status?: PlanStatus): PlanView[] {
    return this.store.plans
      .filter((plan) => status === undefined || plan.status === status)
      .slice()
      .reverse()
      .map((plan) => this.view(plan));
  }

  async update(
    id: string | undefined,
    updates: StepUpdate[],
    completionSummary?: string,
  ): Promise<{ plan: PlanView; autoCompleted: boolean }> {
    let result!: { plan: PlanView; autoCompleted: boolean };
    await this.mutate(async () => {
      const plan = this.resolve(id);
      if (plan.status === "completed") {
        throw new Error(`Plan ${plan.id} is already completed`);
      }
      const now = new Date().toISOString();
      const requestedInProgress = updates.find((update) => update.status === "in_progress");
      if (requestedInProgress) {
        for (const step of plan.steps) {
          if (step.status === "in_progress" && step.id !== requestedInProgress.stepId) {
            step.status = "pending";
            step.updatedAt = now;
          }
        }
      }
      for (const update of updates) {
        const step = plan.steps.find((candidate) => candidate.id === update.stepId);
        if (!step) throw new Error(`Unknown plan step: ${update.stepId}`);
        step.status = update.status;
        step.updatedAt = now;
        if (update.note) step.notes.push(update.note);
        if (update.status === "completed") {
          step.completedAt = now;
        } else {
          delete step.completedAt;
        }
      }
      plan.updatedAt = now;
      const autoCompleted = plan.steps.every((step) => step.status === "completed");
      if (autoCompleted) {
        plan.status = "completed";
        plan.completedAt = now;
        if (completionSummary) plan.outcome = completionSummary;
        if (this.store.activePlanId === plan.id) delete this.store.activePlanId;
      } else {
        this.store.activePlanId = plan.id;
      }
      await this.persist();
      result = { plan: this.view(plan), autoCompleted };
      this.events.publish(
        "plan",
        autoCompleted ? "Plan checklist completed" : "Plan progress updated",
        autoCompleted ? "success" : "info",
        `${result.plan.progress.completed}/${result.plan.progress.total} complete · ${plan.goal}`,
        result.plan,
      );
    });
    return result;
  }

  async complete(
    id: string | undefined,
    outcome: string,
    evidence: string[] = [],
  ): Promise<PlanView> {
    let result!: PlanView;
    await this.mutate(async () => {
      const plan = this.resolve(id);
      const incomplete = plan.steps.filter((step) => step.status !== "completed");
      if (incomplete.length) {
        throw new Error(
          `Cannot complete plan; ${incomplete.length} checklist step(s) remain: ${incomplete
            .map((step) => `${step.id} (${step.title})`)
            .join(", ")}`,
        );
      }
      const now = new Date().toISOString();
      plan.status = "completed";
      plan.completedAt ??= now;
      plan.updatedAt = now;
      plan.outcome = outcome;
      plan.evidence = [...evidence];
      if (this.store.activePlanId === plan.id) delete this.store.activePlanId;
      await this.persist();
      result = this.view(plan);
      this.events.publish("plan", "Plan finalized", "success", plan.goal, result);
    });
    return result;
  }

  private resolve(id?: string): WorkPlan {
    const targetId =
      id ??
      this.store.activePlanId ??
      this.store.plans[this.store.plans.length - 1]?.id;
    if (!targetId) throw new Error("No plans exist. Create one with create_plan first.");
    const plan = this.store.plans.find((candidate) => candidate.id === targetId);
    if (!plan) throw new Error(`Unknown plan: ${targetId}`);
    return plan;
  }

  private view(plan: WorkPlan): PlanView {
    const completed = plan.steps.filter((step) => step.status === "completed").length;
    const current =
      plan.steps.find((step) => step.status === "in_progress") ??
      plan.steps.find((step) => step.status === "blocked") ??
      plan.steps.find((step) => step.status === "pending");
    return structuredClone({
      ...plan,
      progress: {
        completed,
        total: plan.steps.length,
        percent: plan.steps.length ? Math.round((completed / plan.steps.length) * 100) : 100,
        ...(current === undefined ? {} : { currentStepId: current.id }),
        allTasksComplete: completed === plan.steps.length,
      },
    });
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.storagePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.store, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.storagePath);
    await chmod(this.storagePath, 0o600);
  }
}
