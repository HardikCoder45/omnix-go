import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { ActivityStore } from "../src/events.js";
import { createMcpRuntime } from "../src/mcp.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitForApproval(runtime: Awaited<ReturnType<typeof createMcpRuntime>>) {
  for (let i = 0; i < 100; i++) {
    const pending = runtime.upstreams.listPendingApprovals();
    if (pending.length) return pending[0]!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected owner approval did not appear");
}

function getApprovalAction(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return (JSON.parse(content[0]?.text ?? "{}") as { action?: string }).action ?? "";
}

describe("Codex CUA permission bridge", () => {
  it("uses owner approval when the downstream client has no form elicitation, then reuses only the approved app in session", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "omnix-codex-approval-"));
    dirs.push(dataDir);
    const loaded = await loadConfig({ cwd: dataDir, dataDir, workspaceRoots: [dataDir] });
    const runtime = await createMcpRuntime({
      config: loaded.config,
      events: new ActivityStore(),
      persist: () => saveConfig(loaded.config, loaded.configPath),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    const client = new Client({ name: "client-without-forms", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);
    await runtime.upstreams.connect({
      id: "codex-cua-wrapper", name: "Codex CUA Wrapper Validation",
      transport: "stdio", command: process.execPath,
      args: [path.resolve("test/fixtures/codex-approvals-upstream.mjs")],
      cwd: path.resolve("."), enabled: true,
    });
    const descriptors = runtime.upstreams.describe("codex-cua-wrapper");
    const appTool = descriptors.find((tool) => tool.name === "app_prompt")!.publicName;
    const unrelatedTool = descriptors.find((tool) => tool.name === "unrelated_prompt")!.publicName;
    const notionTool = descriptors.find((tool) => tool.name === "notion_prompt")!.publicName;
    const fieldsTool = descriptors.find((tool) => tool.name === "fields_prompt")!.publicName;
    try {
      const pendingCall = client.callTool({ name: appTool, arguments: {} });
      const pending = await waitForApproval(runtime);
      expect(pending).toMatchObject({
        name: "Codex CUA Wrapper Validation",
        appId: "com.apple.Safari",
        riskLevel: "high",
      });
      runtime.upstreams.answerPendingApproval(pending.id, "accept", true);
      const accepted = await pendingCall;
      expect(getApprovalAction(accepted)).toBe("accept");
      expect(runtime.upstreams.listPendingApprovals()).toEqual([]);

      const reused = await client.callTool({ name: appTool, arguments: {} });
      expect(getApprovalAction(reused)).toBe("accept");
      expect(runtime.upstreams.listPendingApprovals()).toEqual([]);

      const unrelatedCall = client.callTool({ name: unrelatedTool, arguments: {} });
      const unrelated = await waitForApproval(runtime);
      expect(unrelated.appId).toBeUndefined();
      runtime.upstreams.answerPendingApproval(unrelated.id, "decline");
      const declined = await unrelatedCall;
      expect(getApprovalAction(declined)).toBe("decline");

      const invalid = await client.callTool({ name: fieldsTool, arguments: {} });
      expect(invalid.isError).toBe(true);
      expect(runtime.upstreams.listPendingApprovals()).toEqual([]);

      // Owner's permanent all-app setting persists and applies to multiple apps,
      // but does not waive separate permissions for unrelated sensitive actions.
      await runtime.upstreams.setAllAppsAccess(true);
      expect(runtime.upstreams.getAllAppsAccess()).toBe(true);
      const reloaded = await loadConfig({ cwd: dataDir, dataDir, workspaceRoots: [dataDir] });
      expect(reloaded.config.codexAllAppsAccess).toBe(true);
      expect(getApprovalAction(await client.callTool({ name: notionTool, arguments: {} }))).toBe("accept");
      expect(getApprovalAction(await client.callTool({ name: appTool, arguments: {} }))).toBe("accept");
      expect(runtime.upstreams.listPendingApprovals()).toEqual([]);
      const sensitiveRequest = client.callTool({ name: unrelatedTool, arguments: {} });
      const sensitivePending = await waitForApproval(runtime);
      expect(sensitivePending.appId).toBeUndefined();
      runtime.upstreams.answerPendingApproval(sensitivePending.id, "decline");
      expect(getApprovalAction(await sensitiveRequest)).toBe("decline");

      await runtime.upstreams.setAllAppsAccess(false);
      expect(runtime.upstreams.getAllAppsAccess()).toBe(false);
      const off = await loadConfig({ cwd: dataDir, dataDir, workspaceRoots: [dataDir] });
      expect(off.config.codexAllAppsAccess).toBe(false);
      const pendingNotion = client.callTool({ name: notionTool, arguments: {} });
      const notionApproval = await waitForApproval(runtime);
      expect(notionApproval.appId).toBe("notion.id");
      runtime.upstreams.answerPendingApproval(notionApproval.id, "decline");
      expect(getApprovalAction(await pendingNotion)).toBe("decline");
    } finally {
      await runtime.upstreams.disconnect("codex-cua-wrapper");
      await client.close();
    }
  }, 20_000);
});