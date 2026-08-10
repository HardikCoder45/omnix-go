import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { importJWK, SignJWT } from "jose";
import { COMPUTER_USE_UPSTREAM, loadConfig, saveConfig } from "../src/config.js";
import { ActivityStore } from "../src/events.js";
import { PathGuard } from "../src/paths.js";
import { SkillInventory } from "../src/skills.js";
import { PlanManager } from "../src/plans.js";
import { toolUiUri } from "../src/ui.js";
import { createMcpRuntime } from "../src/mcp.js";
import { LocalOAuth, ALL_SCOPES, pairingCodeHash } from "../src/auth.js";
import { startHttpServer } from "../src/http.js";
import { managedCloudflaredPath } from "../src/dependencies.js";
import { servicePath } from "../src/service.js";
import { checkGatewayNameAvailability, createDesktopAuthorization, fetchCurrentGateway, gatewayTokenPath, provisionGateway, readGatewaySettings, resolveGatewayName } from "../src/gateway.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnix-go-test-"));
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

describe("self-contained installation", () => {
  it("uses per-user connector and autostart locations on every supported platform", async () => {
    const dataDir = await temporaryDirectory();
    expect(managedCloudflaredPath(dataDir)).toBe(
      path.join(dataDir, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared"),
    );
    expect(servicePath("darwin")).toContain(
      path.join("Library", "LaunchAgents", "com.omnix.go.plist"),
    );
    expect(servicePath("win32")).toContain(path.join("Startup", "OmniX Go.cmd"));
    expect(servicePath("linux")).toContain(
      path.join(".config", "systemd", "user", "omnix-go.service"),
    );
  });

  it("preconfigures the bundled computer-use MCP for every installation", async () => {
    const dataDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const loaded = await loadConfig({ cwd, dataDir });
    const { config } = loaded;
    expect(config.upstreams).toContainEqual(COMPUTER_USE_UPSTREAM);

    config.upstreams[0]!.enabled = false;
    await saveConfig(config, loaded.configPath);
    const restored = await loadConfig({ cwd, dataDir });
    expect(restored.config.upstreams).toContainEqual(COMPUTER_USE_UPSTREAM);
  });
});

describe("workspace isolation", () => {
  it("defaults new installations to the signed-in user's home directory", async () => {
    const dataDir = await temporaryDirectory();
    const { config } = await loadConfig({ cwd: await temporaryDirectory(), dataDir });
    expect(config.workspaceRoots).toEqual([os.homedir()]);
  });

  it("allows workspace files and rejects paths outside it", async () => {
    const workspace = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const { config } = await loadConfig({
      cwd: workspace,
      dataDir,
      workspaceRoots: [workspace],
    });
    const guard = await PathGuard.create(config);
    await writeFile(path.join(workspace, "inside.txt"), "safe");
    await expect(guard.resolve(path.join(workspace, "inside.txt"))).resolves.toBe(
      await realpath(path.join(workspace, "inside.txt")),
    );
    await expect(guard.resolve("/etc/hosts")).rejects.toThrow(
      "outside configured workspace",
    );
  });
});

describe("skill inventory", () => {
  it("discovers and evaluates local skills", async () => {
    const workspace = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const skillRoot = path.join(workspace, "skills");
    await mkdir(path.join(skillRoot, "careful-code"), { recursive: true });
    await writeFile(
      path.join(skillRoot, "careful-code", "SKILL.md"),
      `---
name: careful-code
description: Carefully inspect, implement, and verify local code changes.
---

# Careful code

Inspect relevant files before making focused changes. Run the most relevant tests,
review the resulting diff, and report any remaining risk to the user.
`,
    );
    const { config } = await loadConfig({ cwd: workspace, dataDir });
    config.skillRoots = [skillRoot];
    const inventory = new SkillInventory(config, new ActivityStore());
    const skills = await inventory.refresh();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("careful-code");
    expect((await inventory.evaluate("careful-code")).score).toBeGreaterThanOrEqual(80);
  });
});

describe("persistent work plans", () => {
  it("requires every checklist item and restores completed plans", async () => {
    const workspace = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const { config } = await loadConfig({ cwd: workspace, dataDir });
    const events = new ActivityStore();
    const plans = new PlanManager(config, events);
    await plans.initialize();

    const created = await plans.create({
      goal: "Implement and verify a persistent planning workflow",
      successCriteria: ["Every checklist item is completed"],
      assumptions: ["The plan store remains local"],
      steps: [
        { title: "Implement the plan manager", verification: "Typecheck passes" },
        { title: "Verify persistence", verification: "Reload the stored plan" },
      ],
    });
    expect(created.progress).toMatchObject({ completed: 0, total: 2, percent: 0 });

    await plans.update(undefined, [
      { stepId: created.steps[0]!.id, status: "completed", note: "Implemented" },
    ]);
    await expect(
      plans.complete(undefined, "Should not finish yet"),
    ).rejects.toThrow("checklist step(s) remain");

    const finished = await plans.update(
      undefined,
      [{ stepId: created.steps[1]!.id, status: "completed", note: "Reload verified" }],
      "All implementation and persistence checks passed.",
    );
    expect(finished.autoCompleted).toBe(true);
    expect(finished.plan).toMatchObject({
      status: "completed",
      progress: { completed: 2, total: 2, percent: 100, allTasksComplete: true },
    });

    const restored = new PlanManager(config, new ActivityStore());
    await restored.initialize();
    expect(restored.get(created.id).status).toBe("completed");
    expect(events.snapshot().some((event) => event.kind === "plan")).toBe(true);
  });
});

describe("MCP runtime", () => {
  it("advertises the full harness and performs guarded file operations", async () => {
    const workspace = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const loaded = await loadConfig({
      cwd: workspace,
      dataDir,
      workspaceRoots: [workspace],
    });
    loaded.config.skillRoots = [];
    const events = new ActivityStore();
    const runtime = await createMcpRuntime({
      config: loaded.config,
      events,
      persist: () => saveConfig(loaded.config, loaded.configPath),
    });
    await expect(
      runtime.upstreams.disconnect("omnix-computer-use"),
    ).resolves.toEqual({ disconnected: false, managed: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(30);
    expect(tools.tools.map((tool) => tool.name)).toContain("show_activity_dashboard");
    expect(tools.tools.map((tool) => tool.name)).toContain("create_plan");
    expect(tools.tools.map((tool) => tool.name)).toContain("update_plan");
    expect(tools.tools.map((tool) => tool.name)).toContain("complete_plan");
    expect(tools.tools.map((tool) => tool.name)).toContain("read_omnix_go_guide");
    expect(tools.tools.map((tool) => tool.name)).toContain("start_agent");
    expect(tools.tools.map((tool) => tool.name)).toContain("follow_up_agent");
    expect(tools.tools.map((tool) => tool.name)).toContain("coordinate_agents");
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "call_connected_mcp_tool",
    );

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      toolUiUri("git_diff"),
    );
    const widget = await client.readResource({
      uri: toolUiUri("git_diff"),
    });
    expect(widget.contents[0]).toMatchObject({
      mimeType: "text/html+skybridge",
      _meta: {
        ui: { prefersBorder: false },
        "openai/widgetPrefersBorder": false,
      },
    });
    expect("text" in widget.contents[0]! ? widget.contents[0].text : "").toContain(
      "OmniX",
    );
    expect("text" in widget.contents[0]! ? widget.contents[0].text : "").toContain(
      'const configuredView = "auto"',
    );

    const target = path.join(workspace, "hello.txt");
    const written = await client.callTool({
      name: "write_file",
      arguments: { path: target, content: "hello\n" },
    });
    expect(written.isError).not.toBe(true);
    expect(written._meta).toMatchObject({
      ui: { resourceUri: toolUiUri("write_file") },
      "openai/outputTemplate": toolUiUri("write_file"),
      omnixGo: { toolName: "write_file", view: "diff" },
      mcp_tool_result: { isError: undefined },
    });

    const read = await client.callTool({
      name: "read_file",
      arguments: { path: target },
    });
    const readContent = read.content as Array<{ type: string; text?: string }>;
    expect(readContent[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(readContent)).toContain("hello");
    expect(events.snapshot().some((event) => event.kind === "diff")).toBe(true);

    await runtime.upstreams.connect({
      id: "fixture",
      name: "Fixture MCP",
      transport: "stdio",
      command: process.execPath,
      args: [path.resolve("test/fixtures/upstream.mjs")],
      cwd: path.resolve("."),
      enabled: true,
    });
    const toolsAfterConnect = await client.listTools();
    expect(toolsAfterConnect.tools.map((tool) => tool.name)).toContain(
      "mcp_fixture__echo",
    );
    expect(
      toolsAfterConnect.tools.find((tool) => tool.name === "mcp_fixture__echo")
        ?._meta,
    ).toMatchObject({
      ui: { resourceUri: toolUiUri("mcp_fixture__echo") },
      "openai/outputTemplate": toolUiUri("mcp_fixture__echo"),
    });
    expect(
      (await client.listResources()).resources.map((resource) => resource.uri),
    ).toContain(toolUiUri("mcp_fixture__echo"));
    const echoed = await client.callTool({
      name: "mcp_fixture__echo",
      arguments: { text: "dynamic tool ready" },
    });
    expect(JSON.stringify(echoed)).toContain("dynamic tool ready");
    expect(echoed._meta).toMatchObject({
      ui: { resourceUri: toolUiUri("mcp_fixture__echo") },
      "openai/outputTemplate": toolUiUri("mcp_fixture__echo"),
      omnixGo: { toolName: "mcp_fixture__echo", view: "auto" },
    });
    expect(JSON.stringify(echoed._meta)).toContain("dynamic tool ready");
    const inspected = await client.callTool({
      name: "inspect_connected_mcp_tools",
      arguments: { id: "fixture" },
    });
    expect(JSON.stringify(inspected)).toContain("mcp_fixture__echo");
    const bridged = await client.callTool({
      name: "call_connected_mcp_tool",
      arguments: {
        id: "fixture",
        tool: "echo",
        arguments: { text: "stable bridge ready" },
      },
    });
    expect(JSON.stringify(bridged)).toContain("stable bridge ready");
    await runtime.upstreams.disconnect("fixture");

    await client.close();
  });

  it("serves authenticated multi-request Streamable HTTP including the UI template", async () => {
    const workspace = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const loaded = await loadConfig({
      cwd: workspace,
      dataDir,
      workspaceRoots: [workspace],
      port: 0,
    });
    loaded.config.skillRoots = [];
    const events = new ActivityStore();
    const runtime = await createMcpRuntime({
      config: loaded.config,
      events,
      persist: () => saveConfig(loaded.config, loaded.configPath),
    });
    const oauth = new LocalOAuth(loaded.config, events);
    await oauth.initialize();
    const httpServer = await startHttpServer({
      config: loaded.config,
      runtime,
      oauth,
      events,
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    loaded.config.port = address.port;
    const base = `http://${loaded.config.host}:${address.port}`;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      scope: ALL_SCOPES.join(" "),
      client_id: "integration-test",
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: "omnix-go-local",
        typ: "JWT",
      })
      .setIssuer(base)
      .setSubject("local-computer-user")
      .setAudience(`${base}/mcp`)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomUUID())
      .sign(await importJWK(loaded.config.jwtPrivateJwk, "EdDSA"));

    const client = new Client({ name: "http-integration", version: "1.0.0" });
    const sseClient = new Client({ name: "sse-integration", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      expect((await client.listTools()).tools.length).toBeGreaterThanOrEqual(35);
      const rawToolListResponse = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "descriptor-test",
          method: "tools/list",
          params: {},
        }),
      });
      expect(rawToolListResponse.status).toBe(200);
      const prefixedToolListResponse = await fetch(`${base}/go/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "go-prefix", method: "tools/list", params: {} }),
      });
      expect(prefixedToolListResponse.status).toBe(200);
      const rawToolList = (await rawToolListResponse.json()) as {
        result: {
          tools: Array<{
            name: string;
            securitySchemes?: unknown[];
            outputSchema?: unknown;
            _meta?: {
              ui?: { resourceUri?: string };
              "openai/outputTemplate"?: string;
            };
            annotations?: {
              readOnlyHint?: boolean;
              destructiveHint?: boolean;
              openWorldHint?: boolean;
            };
          }>;
        };
      };
      expect(rawToolList.result.tools).toHaveLength(46);
      expect(
        rawToolList.result.tools.every(
          (tool) =>
            Array.isArray(tool.securitySchemes) &&
            typeof tool.annotations?.readOnlyHint === "boolean" &&
            typeof tool.annotations?.destructiveHint === "boolean" &&
            typeof tool.annotations?.openWorldHint === "boolean" &&
            tool._meta?.ui?.resourceUri === toolUiUri(tool.name) &&
            tool._meta?.["openai/outputTemplate"] === toolUiUri(tool.name),
        ),
      ).toBe(true);
      expect(
        rawToolList.result.tools.filter((tool) => tool.outputSchema).length,
      ).toBeGreaterThanOrEqual(33);
      const resources = await client.listResources();
      const omnixGoResources = resources.resources.filter((resource) =>
        resource.uri.startsWith("ui://omnix-go/"),
      );
      expect(omnixGoResources).toHaveLength(1);
      expect(omnixGoResources[0]?.uri).toBe(toolUiUri("read_file"));
      expect(omnixGoResources[0]?.name).toBe("omnix-go-tool-result");
      expect(omnixGoResources[0]?.title).toBe("OmniX Go");
      expect(omnixGoResources[0]?.description).toBe(
        "Clean inline progress and file changes from OmniX Go.",
      );
      const widget = await client.readResource({
        uri: toolUiUri("read_file"),
      });
      expect(widget.contents[0]?.mimeType).toBe("text/html+skybridge");
      const widgetHtml = "text" in widget.contents[0]! ? widget.contents[0].text : "";
      expect(widgetHtml).toContain("<title>OmniX Go</title>");
      expect(widgetHtml).toContain('aria-label="OmniX Go logo"');
      expect(widgetHtml).toContain('src="data:image/png;base64,');
      expect(widgetHtml).toContain('class="brand">OmniX</h1>');
      expect(widgetHtml).toContain('id="action">Doing this</div>');
      expect(widgetHtml).toContain('id="content"');
      expect(widgetHtml).toContain('const configuredView = "auto"');
      expect(widgetHtml).toContain('write_file: "Writing this file"');
      expect(widgetHtml).toContain("function renderDiff(output, input)");
      expect(widgetHtml).toContain("function enhanceLongContent()");
      expect(widgetHtml).toContain('shell.dataset.expandable = "true"');
      expect(widgetHtml).toContain('shell.setAttribute("aria-expanded", "false")');
      expect(widgetHtml).toContain('shell.onclick = (event) =>');
      expect(widgetHtml).toContain('max-height: 260px');
      expect(widgetHtml).not.toContain("Show full result");
      expect(widgetHtml).toContain("new ResizeObserver(notify)");
      expect(widgetHtml).not.toContain('class="tabs"');
      expect(widgetHtml).not.toContain(">Visual</button>");
      expect(widgetHtml).not.toContain(">Raw</button>");
      expect(widgetHtml).not.toContain("Tool input");
      expect(widgetHtml).not.toContain("Tool output");
      expect(widgetHtml).not.toContain("raw-grid");
      expect(widgetHtml).not.toContain("max-height: min(");

      const authorization = `Bearer ${token}`;
      const sseProbeController = new AbortController();
      const sseProbe = await fetch(`${base}/sse`, {
        headers: {
          Accept: "text/event-stream",
          Authorization: authorization,
        },
        signal: sseProbeController.signal,
      });
      expect(sseProbe.status).toBe(200);
      sseProbeController.abort();
      await sseClient.connect(
        new SSEClientTransport(new URL(`${base}/sse`), {
          requestInit: { headers: { Authorization: authorization } },
          fetch: async (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set("Authorization", authorization);
            const response = await fetch(url, {
              ...init,
              headers,
            });
            return response;
          },
        }),
      );
      expect((await sseClient.listTools()).tools.length).toBeGreaterThanOrEqual(35);
      expect(
        (
          await sseClient.readResource({
            uri: toolUiUri("git_diff"),
          })
        ).contents[0]?.mimeType,
      ).toBe("text/html+skybridge");
    } finally {
      await client.close().catch(() => {});
      await sseClient.close().catch(() => {});
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe("authenticated OmniX gateway", () => {
  it("builds a PKCE desktop authorization request with a strict loopback callback", () => {
    const authorization = createDesktopAuthorization("http://127.0.0.1:48111/auth/callback");
    const url = new URL(authorization.url);
    expect(url.origin).toBe("https://auth.omnix.work");
    expect(url.pathname).toBe("/desktop");
    expect(url.searchParams.get("client_id")).toBe("omnix-desktop");
    expect(url.searchParams.get("redirect_uri")).toBe("omnix://auth/callback");
    expect(url.searchParams.get("loopback_uri")).toBe("http://127.0.0.1:48111/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.state.length).toBeGreaterThanOrEqual(32);
    expect(authorization.verifier.length).toBeGreaterThanOrEqual(64);
  });

  it("discovers the signed-in account's permanent gateway", async () => {
    const originalFetch = global.fetch;
    let authorization = "";
    global.fetch = async (url, init = {}) => {
      expect(String(url)).toBe("https://server.omnix.work/api/gateways/current");
      authorization = String((init.headers as Record<string, string>).Authorization);
      return Response.json({
        ok: true,
        gateway: { gatewayName: "hardik", gatewayUrl: "https://hardik.omnix.work" },
      });
    };
    try {
      await expect(fetchCurrentGateway("firebase-id-token")).resolves.toMatchObject({
        gatewayName: "hardik",
      });
      expect(authorization).toBe("Bearer firebase-id-token");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("accepts a chosen gateway for new users but protects permanent assignments", () => {
    expect(resolveGatewayName("My-Code", undefined)).toBe("my-code");
    expect(resolveGatewayName(undefined, "hardik")).toBe("hardik");
    expect(resolveGatewayName("hardik", "hardik")).toBe("hardik");
    expect(() => resolveGatewayName("different", "hardik")).toThrow(
      "permanently assigned to hardik.omnix.work",
    );
    expect(() => resolveGatewayName("not_valid", undefined)).toThrow(
      "lowercase letters, numbers, and hyphens",
    );
  });

  it("checks registry and hosted-hostname availability through the authenticated server", async () => {
    const originalFetch = global.fetch;
    let requestUrl = "";
    let authorization = "";
    global.fetch = async (url, init = {}) => {
      requestUrl = String(url);
      authorization = String((init.headers as Record<string, string>).Authorization);
      return Response.json({
        ok: true,
        gatewayName: "fresh-name",
        hostname: "fresh-name.omnix.work",
        available: true,
        ownedByRequester: false,
        reason: "available",
      });
    };
    try {
      await expect(checkGatewayNameAvailability("firebase-id-token", "Fresh-Name"))
        .resolves.toMatchObject({ available: true, hostname: "fresh-name.omnix.work" });
      expect(new URL(requestUrl).pathname).toBe("/api/gateways/availability");
      expect(new URL(requestUrl).searchParams.get("gatewayName")).toBe("fresh-name");
      expect(authorization).toBe("Bearer firebase-id-token");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("provisions through server.omnix.work and stores only private connector state", async () => {
    const dataDir = await temporaryDirectory();
    const originalFetch = global.fetch;
    let request: { url: string; init: RequestInit } | undefined;
    global.fetch = async (url, init = {}) => {
      request = { url: String(url), init };
      return Response.json({
        ok: true,
        gatewayName: "my-go",
        hostname: "my-go.omnix.work",
        gatewayUrl: "https://my-go.omnix.work",
        goUrl: "https://my-go.omnix.work/go",
        tunnelId: "tunnel-id",
        tunnelToken: "scoped-connector-token-that-is-long-enough",
        ownerUserId: "firebase-owner",
        firebaseProjectId: "omnix",
        permanent: true,
      });
    };
    try {
      const gateway = await provisionGateway({
        dataDir,
        gatewayName: "my-go",
        identityToken: "firebase-id-token",
        expectedOwnerUserId: "firebase-owner",
      });
      expect(request?.url).toBe("https://server.omnix.work/api/gateways/provision");
      expect((request?.init.headers as Record<string, string>).Authorization).toBe("Bearer firebase-id-token");
      expect(gateway.goUrl).toBe("https://my-go.omnix.work/go");
      expect((await readGatewaySettings(dataDir))?.ownerUserId).toBe("firebase-owner");
      expect(await readFile(gatewayTokenPath(dataDir), "utf8")).toContain("scoped-connector-token");
      if (process.platform !== "win32") expect((await stat(gatewayTokenPath(dataDir))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(dataDir, "gateway.json"), "utf8")).not.toContain("connector-token");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("authorizes only the gateway owner and rotates MCP refresh tokens", async () => {
    const workspace = await temporaryDirectory();
    const dataDir = await temporaryDirectory();
    const loaded = await loadConfig({ cwd: workspace, dataDir, workspaceRoots: [workspace], port: 0 });
    loaded.config.skillRoots = [];
    loaded.config.gatewayOwnerUserId = "firebase-owner";
    loaded.config.pairingSecretHash = pairingCodeHash("ABCD-2345");
    const events = new ActivityStore();
    const runtime = await createMcpRuntime({
      config: loaded.config,
      events,
      persist: () => saveConfig(loaded.config, loaded.configPath),
    });
    const oauth = new LocalOAuth(loaded.config, events);
    await oauth.initialize();
    let httpServer = await startHttpServer({ config: loaded.config, runtime, oauth, events });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    loaded.config.port = address.port;
    const base = `http://127.0.0.1:${address.port}`;
    loaded.config.publicUrl = `${base}/go`;
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url) === "https://auth.omnix.work/api/desktop/token") {
        return Response.json({ accessToken: "firebase-id-token", user: { id: "firebase-owner" } });
      }
      return originalFetch(url, init);
    };
    try {
      const registrationResponse = await fetch(`${base}/go/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/oauth/callback"] }),
      });
      const registration = await registrationResponse.json() as { client_id: string };
      const verifier = "chatgpt-pkce-verifier-long-enough-for-this-test";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorizationResponse = await fetch(`${base}/go/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: registration.client_id,
        redirect_uri: "http://127.0.0.1/oauth/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${base}/go/mcp`,
        state: "chatgpt-state",
      })}`, { redirect: "manual" });
      expect(authorizationResponse.status).toBe(302);
      const identityLocation = new URL(authorizationResponse.headers.get("location")!);
      expect(identityLocation.origin).toBe("https://auth.omnix.work");
      const identityState = identityLocation.searchParams.get("state")!;
      const ownerCallback = await fetch(`${base}/auth/callback?code=one-time-code&state=${encodeURIComponent(identityState)}`, { redirect: "manual" });
      expect(ownerCallback.status).toBe(302);
      const pairingLocation = new URL(ownerCallback.headers.get("location")!);
      expect(pairingLocation.pathname).toBe("/go/oauth/pair");
      const pairingPage = await fetch(`${base}${pairingLocation.pathname}${pairingLocation.search}`);
      expect(pairingPage.status).toBe(200);
      expect(await pairingPage.text()).toContain("Confirm this computer");
      const rejectedPairing = await fetch(`${base}/go/oauth/pair`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ state: identityState, pairing_code: "WRONG-000" }),
        redirect: "manual",
      });
      expect(rejectedPairing.status).toBe(403);
      const pairingResponse = await fetch(`${base}/go/oauth/pair`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ state: identityState, pairing_code: "ABCD-2345" }),
        redirect: "manual",
      });
      expect(pairingResponse.status).toBe(302);
      const clientRedirect = new URL(pairingResponse.headers.get("location")!);
      expect(clientRedirect.searchParams.get("state")).toBe("chatgpt-state");
      const tokenResponse = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: clientRedirect.searchParams.get("code")!,
          client_id: registration.client_id,
          redirect_uri: "http://127.0.0.1/oauth/callback",
          code_verifier: verifier,
        }),
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = await tokenResponse.json() as { refresh_token: string; expires_in: number };
      expect(tokens.expires_in).toBe(300);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      const restartedOAuth = new LocalOAuth(loaded.config, events);
      await restartedOAuth.initialize();
      httpServer = await startHttpServer({ config: loaded.config, runtime, oauth: restartedOAuth, events });
      const refresh = async (refreshToken: string) => fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: registration.client_id }),
      });
      const rotatedResponse = await refresh(tokens.refresh_token);
      expect(rotatedResponse.status).toBe(200);
      const rotated = await rotatedResponse.json() as { refresh_token: string };
      expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      expect(await readFile(path.join(dataDir, "oauth-state.json"), "utf8")).not.toContain(tokens.refresh_token);
    } finally {
      global.fetch = originalFetch;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
