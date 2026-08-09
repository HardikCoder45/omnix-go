import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  browserDescriptorForBundleId,
  formatAgentPrompt,
  parseConversationId,
  parseDefaultBrowserBundleId,
  type AgentBrowser,
  type AgentConversationTarget,
} from "../src/chatgpt-browser.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { ActivityStore } from "../src/events.js";
import { createMcpRuntime } from "../src/mcp.js";
import { AgentHarness } from "../src/harness.js";
import { PathGuard } from "../src/paths.js";
import { TerminalManager } from "../src/terminal.js";
import type {
  ChatGptConversationSnapshot,
  ChatGptMessage,
} from "../src/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chatgpt-agent-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function cloneSnapshot(
  snapshot: ChatGptConversationSnapshot,
): ChatGptConversationSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map((message) => ({ ...message })),
  };
}

class FakeAgentBrowser implements AgentBrowser {
  readonly createdPrompts: string[] = [];
  readonly sentPrompts: Array<{ conversationId: string; prompt: string }> = [];
  readonly stopped: string[] = [];
  private readonly conversations = new Map<string, ChatGptConversationSnapshot>();
  private counter = 0;

  async createConversation(prompt: string): Promise<ChatGptConversationSnapshot> {
    this.counter += 1;
    const conversationId = `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
    const userMessage: ChatGptMessage = {
      id: "conversation-turn-1",
      role: "user",
      text: prompt,
    };
    const snapshot: ChatGptConversationSnapshot = {
      tabId: `browser-tab-${this.counter}`,
      browser: "Arc",
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      title: `Agent ${this.counter}`,
      state: "responding",
      messages: [userMessage],
      pageText: prompt,
      userMessageCount: 1,
      assistantMessageCount: 0,
      capturedAt: new Date().toISOString(),
    };
    this.createdPrompts.push(prompt);
    this.conversations.set(conversationId, snapshot);
    return cloneSnapshot(snapshot);
  }

  async readConversation(
    target: AgentConversationTarget,
  ): Promise<ChatGptConversationSnapshot> {
    return cloneSnapshot(this.resolve(target));
  }

  async sendMessage(
    target: AgentConversationTarget,
    prompt: string,
  ): Promise<ChatGptConversationSnapshot> {
    const snapshot = this.resolve(target);
    const conversationId = snapshot.conversationId!;
    snapshot.messages.push({
      id: `conversation-turn-${snapshot.messages.length + 1}`,
      role: "user",
      text: prompt,
    });
    snapshot.userMessageCount += 1;
    snapshot.state = "responding";
    snapshot.pageText = snapshot.messages.map((message) => message.text).join("\n");
    snapshot.capturedAt = new Date().toISOString();
    this.sentPrompts.push({ conversationId, prompt });
    return cloneSnapshot(snapshot);
  }

  async stopConversation(target: AgentConversationTarget): Promise<{
    stopped: boolean;
    snapshot: ChatGptConversationSnapshot;
  }> {
    const snapshot = this.resolve(target);
    snapshot.state = "ready";
    snapshot.capturedAt = new Date().toISOString();
    this.stopped.push(snapshot.conversationId!);
    return { stopped: true, snapshot: cloneSnapshot(snapshot) };
  }

  complete(conversationId: string, response: string): void {
    const snapshot = this.conversations.get(conversationId);
    if (!snapshot) throw new Error(`Unknown fake conversation: ${conversationId}`);
    snapshot.messages.push({
      id: `conversation-turn-${snapshot.messages.length + 1}`,
      role: "assistant",
      text: response,
    });
    snapshot.assistantMessageCount += 1;
    snapshot.latestAssistant = response;
    snapshot.pageText = snapshot.messages.map((message) => message.text).join("\n");
    snapshot.state = "ready";
    snapshot.capturedAt = new Date().toISOString();
  }

  private resolve(target: AgentConversationTarget): ChatGptConversationSnapshot {
    const conversationId =
      target.conversationId ?? parseConversationId(target.conversationUrl);
    if (conversationId) {
      const snapshot = this.conversations.get(conversationId);
      if (snapshot) return snapshot;
    }
    const byTab = [...this.conversations.values()].find(
      (snapshot) => snapshot.tabId === target.tabId,
    );
    if (byTab) return byTab;
    throw new Error("Fake conversation was not found.");
  }
}

async function createHarness(input?: {
  dataDir?: string;
  workspace?: string;
  browser?: FakeAgentBrowser;
}): Promise<{
  harness: AgentHarness;
  browser: FakeAgentBrowser;
  dataDir: string;
  workspace: string;
}> {
  const workspace = input?.workspace ?? await temporaryDirectory();
  const dataDir = input?.dataDir ?? await temporaryDirectory();
  const { config } = await loadConfig({
    cwd: workspace,
    dataDir,
    workspaceRoots: [workspace],
  });
  const events = new ActivityStore();
  const paths = await PathGuard.create(config);
  const terminal = new TerminalManager(config, paths, events);
  const browser = input?.browser ?? new FakeAgentBrowser();
  const harness = new AgentHarness(config, paths, terminal, events, browser);
  await harness.restore();
  return { harness, browser, dataDir, workspace };
}

describe("ChatGPT agent prompt and conversation helpers", () => {
  it("adds one canonical @OmniX Go prefix and includes initial task context", () => {
    expect(
      formatAgentPrompt({
        prompt: "@omnix: Implement the parser",
        workspace: "/tmp/project",
        evaluationCommands: ["npm test", "npm run typecheck"],
      }),
    ).toBe(
      "@OmniX Go\n\nImplement the parser\n\nWorkspace: /tmp/project\n\n" +
        "Verification commands:\n- npm test\n- npm run typecheck\n\n" +
        "Execution boundary: Do not spawn, delegate to, or ask any subagent or nested agent to work on this task. Complete the work yourself using the available OmniX tools.",
    );
  });

  it("parses ChatGPT conversation IDs without treating arbitrary text as an ID", () => {
    const id = "6a74824f-3468-83e8-b9e6-8cfaddd0d45e";
    expect(parseConversationId(`https://chatgpt.com/c/${id}`)).toBe(id);
    expect(parseConversationId(id)).toBe(id);
    expect(parseConversationId("not an agent reference")).toBeUndefined();
  });

  it("detects the default browser bundle ID and resolves supported adapters", () => {
    const launchServices = `(
      {
        LSHandlerPreferredVersions = {
          LSHandlerRoleAll = "77089.0";
        };
        LSHandlerRoleAll = "company.thebrowser.browser";
        LSHandlerURLScheme = https;
      },
      {
        LSHandlerRoleAll = "com.google.Chrome";
        LSHandlerURLScheme = ftp;
      }
    )`;
    expect(parseDefaultBrowserBundleId(launchServices)).toBe(
      "company.thebrowser.browser",
    );
    expect(browserDescriptorForBundleId("company.thebrowser.browser")).toMatchObject({
      name: "Arc",
      family: "arc",
    });
    expect(browserDescriptorForBundleId("com.google.Chrome")).toMatchObject({
      name: "Google Chrome",
      family: "chromium",
    });
    expect(browserDescriptorForBundleId("com.apple.Safari")).toMatchObject({
      name: "Safari",
      family: "safari",
    });
  });
});

describe("ChatGPT conversation-backed AgentHarness", () => {
  it("starts and tracks a batch of independent ChatGPT conversations", async () => {
    const { harness, browser } = await createHarness();
    const batch = await harness.startMany({
      agents: [
        { prompt: "Inspect the API contract and report findings" },
        { prompt: "Inspect the test suite and report findings" },
      ],
    });

    expect(batch.failures).toEqual([]);
    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks.every((task) => task.batchId === batch.batchId)).toBe(true);
    expect(browser.createdPrompts).toHaveLength(2);
    expect(browser.createdPrompts.every((prompt) => prompt.startsWith("@OmniX Go\n\n"))).toBe(true);
    expect(harness.list(batch.batchId)).toHaveLength(2);

    const monitored = await harness.coordinate({ batchId: batch.batchId });
    expect(monitored.failures).toEqual([]);
    expect(monitored.tasks.map((task) => task.id).sort()).toEqual(
      batch.tasks.map((task) => task.id).sort(),
    );

    const cancelled = await harness.cancelMany({ batchId: batch.batchId });
    expect(cancelled.failures).toEqual([]);
    expect(cancelled.tasks).toHaveLength(2);
    expect(cancelled.tasks.every((task) => task.status === "cancelled")).toBe(true);
    expect(browser.stopped).toEqual(
      expect.arrayContaining(batch.tasks.map((task) => task.conversationId)),
    );
  });

  it("starts, persists, refreshes, follows up, coordinates, cancels, and restores agents", async () => {
    const { harness, browser, dataDir, workspace } = await createHarness();
    const started = await harness.start({
      prompt: "Implement a durable parser and tests",
      workspace,
      evaluationCommands: ["npm test"],
    });

    expect(started.backend).toBe("chatgpt");
    expect(started.status).toBe("running");
    expect(started.conversationId).toBeTruthy();
    expect(started.conversationUrl).toBe(
      `https://chatgpt.com/c/${started.conversationId}`,
    );
    expect(started.agentName).toMatch(/^OmniXGo-[a-f0-9]{8}$/i);
    expect(started.browser).toBe("Arc");
    expect(started.tabId).toBe("browser-tab-1");
    expect(browser.createdPrompts[0]).toMatch(/^@OmniX Go\n\n/);
    expect(browser.createdPrompts[0]).toContain(`Workspace: ${started.workspace}`);
    expect(browser.createdPrompts[0]).toContain("Verification commands:\n- npm test");

    const persisted = JSON.parse(
      await readFile(path.join(dataDir, "tasks", `${started.id}.json`), "utf8"),
    ) as { conversationId?: string; backend?: string };
    expect(persisted).toMatchObject({
      backend: "chatgpt",
      conversationId: started.conversationId,
    });

    browser.complete(started.conversationId!, "Parser implementation is complete.");
    const refreshedByConversationId = await harness.refresh(started.conversationId!);
    expect(refreshedByConversationId.status).toBe("completed");
    expect(refreshedByConversationId.latestAssistant).toBe(
      "Parser implementation is complete.",
    );
    expect(refreshedByConversationId.transcript).toHaveLength(2);

    const followedUp = await harness.followUp(
      started.conversationUrl!,
      "@OmniX Go Review the edge cases",
    );
    expect(followedUp.status).toBe("running");
    expect(followedUp.messagesSent).toBe(2);
    expect(browser.sentPrompts.at(-1)?.prompt).toBe(
      "@OmniX Go\n\nReview the edge cases\n\nExecution boundary: Do not spawn, delegate to, or ask any subagent or nested agent to work on this task. Complete the work yourself using the available OmniX tools.",
    );

    browser.complete(started.conversationId!, "Edge cases reviewed.");
    const monitored = await harness.coordinate({ agents: [started.id] });
    expect(monitored.failures).toEqual([]);
    expect(monitored.tasks[0]?.latestAssistant).toBe("Edge cases reviewed.");

    const second = await harness.start({
      prompt: "Inspect the documentation for stale agent behavior",
      workspace,
    });
    const coordinated = await harness.coordinate({
      agents: [started.id, second.conversationId!],
      instruction: "Report blockers and the next concrete action",
    });
    expect(coordinated.failures).toEqual([]);
    expect(coordinated.tasks).toHaveLength(2);
    expect(browser.sentPrompts.slice(-2).every(({ prompt }) =>
      prompt.startsWith("@OmniX Go\n\nReport blockers"),
    )).toBe(true);

    const cancelled = await harness.cancel(second.conversationId!);
    expect(cancelled).toMatchObject({ cancelled: true, stopped: true });
    expect(cancelled.task?.status).toBe("cancelled");
    expect(browser.stopped).toContain(second.conversationId);

    const restored = await createHarness({ dataDir, workspace, browser });
    const restoredTask = restored.harness.get(started.id);
    expect(restoredTask.backend).toBe("chatgpt");
    expect(restoredTask.conversationId).toBe(started.conversationId);
    expect(restoredTask.status).not.toBe("failed");
  });

  it("rejects unknown references without opening an unrelated conversation", async () => {
    const { harness, browser } = await createHarness();
    await expect(
      harness.followUp(randomUUID(), "Continue the work"),
    ).rejects.toThrow("Unknown agent reference");
    expect(browser.sentPrompts).toEqual([]);
  });

  it("registers and invokes the ChatGPT-backed MCP agent tools", async () => {
    const workspace = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const loaded = await loadConfig({
      cwd: workspace,
      dataDir,
      workspaceRoots: [workspace],
    });
    loaded.config.skillRoots = [];
    const browser = new FakeAgentBrowser();
    const runtime = await createMcpRuntime({
      config: loaded.config,
      events: new ActivityStore(),
      persist: () => saveConfig(loaded.config, loaded.configPath),
      agentBrowser: browser,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    const client = new Client({ name: "agent-test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "start_agent",
      "start_agents",
      "agent_status",
      "list_agents",
      "follow_up_agent",
      "coordinate_agents",
      "cancel_agent",
      "cancel_agents",
    ]));
    for (const name of ["agent_status", "follow_up_agent", "cancel_agent"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?._meta?.["openai/widgetAccessible"]).toBe(true);
    }

    const started = await client.callTool({
      name: "start_agent",
      arguments: {
        prompt: "Implement the parser through a ChatGPT agent conversation",
        workspace,
      },
    });
    const startedData = started.structuredContent as {
      id: string;
      conversationId: string;
      conversationUrl: string;
    };
    expect(startedData.conversationId).toBeTruthy();
    expect(browser.createdPrompts[0]).toMatch(/^@OmniX Go\n\n/);

    const batch = await client.callTool({
      name: "start_agents",
      arguments: {
        agents: [
          { prompt: "Inspect the parser contract in a separate ChatGPT session" },
          { prompt: "Inspect the test contract in a separate ChatGPT session" },
        ],
      },
    });
    const batchData = batch.structuredContent as {
      batchId: string;
      tasks: Array<{ batchId?: string }>;
      failures: unknown[];
    };
    expect(batchData.failures).toEqual([]);
    expect(batchData.tasks).toHaveLength(2);
    expect(batchData.tasks.every((task) => task.batchId === batchData.batchId)).toBe(true);

    const batchCancelled = await client.callTool({
      name: "cancel_agents",
      arguments: { batchId: batchData.batchId },
    });
    expect(batchCancelled.structuredContent).toMatchObject({ failures: [] });
    expect((batchCancelled.structuredContent as { tasks: unknown[] }).tasks).toHaveLength(2);

    const status = await client.callTool({
      name: "agent_status",
      arguments: { agent: startedData.conversationUrl },
    });
    expect(status.structuredContent).toMatchObject({
      id: startedData.id,
      conversationId: startedData.conversationId,
    });

    await client.callTool({
      name: "follow_up_agent",
      arguments: {
        agent: startedData.conversationId,
        prompt: "Report the current blocker",
      },
    });
    expect(browser.sentPrompts.at(-1)?.prompt).toBe(
      "@OmniX Go\n\nReport the current blocker\n\nExecution boundary: Do not spawn, delegate to, or ask any subagent or nested agent to work on this task. Complete the work yourself using the available OmniX tools.",
    );

    const coordinated = await client.callTool({
      name: "coordinate_agents",
      arguments: { agents: [startedData.id] },
    });
    expect(coordinated.structuredContent).toMatchObject({ failures: [] });
  });
});
