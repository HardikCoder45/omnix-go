import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { importJWK, SignJWT } from "jose";
import { loadConfig, rotatePairingCode, saveConfig } from "../src/config.js";
import { ActivityStore } from "../src/events.js";
import { PathGuard } from "../src/paths.js";
import { SkillInventory } from "../src/skills.js";
import { createMcpRuntime } from "../src/mcp.js";
import { LocalOAuth, ALL_SCOPES } from "../src/auth.js";
import { startHttpServer } from "../src/http.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chatgpt-code-test-"));
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

describe("workspace isolation", () => {
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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(30);
    expect(tools.tools.map((tool) => tool.name)).toContain("show_activity_dashboard");
    expect(tools.tools.map((tool) => tool.name)).toContain("read_chatgpt_code_guide");
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "call_connected_mcp_tool",
    );

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      "ui://chatgpt-code/tool-result-v2.html",
    );
    const widget = await client.readResource({
      uri: "ui://chatgpt-code/tool-result-v2.html",
    });
    expect(widget.contents[0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: { prefersBorder: false },
        "openai/widgetPrefersBorder": false,
      },
    });
    expect("text" in widget.contents[0]! ? widget.contents[0].text : "").toContain(
      "CHATGPT CODE",
    );

    const target = path.join(workspace, "hello.txt");
    const written = await client.callTool({
      name: "write_file",
      arguments: { path: target, content: "hello\n" },
    });
    expect(written.isError).not.toBe(true);

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
    const echoed = await client.callTool({
      name: "mcp_fixture__echo",
      arguments: { text: "dynamic tool ready" },
    });
    expect(JSON.stringify(echoed)).toContain("dynamic tool ready");
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
        kid: "chatgpt-code-local",
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
      expect(rawToolList.result.tools).toHaveLength(37);
      expect(
        rawToolList.result.tools.every(
          (tool) =>
            Array.isArray(tool.securitySchemes) &&
            typeof tool.annotations?.readOnlyHint === "boolean" &&
            typeof tool.annotations?.destructiveHint === "boolean" &&
            typeof tool.annotations?.openWorldHint === "boolean" &&
            tool._meta?.ui?.resourceUri ===
              "ui://chatgpt-code/tool-result-v2.html" &&
            tool._meta?.["openai/outputTemplate"] ===
              "ui://chatgpt-code/tool-result-v2.html",
        ),
      ).toBe(true);
      expect(
        rawToolList.result.tools.filter((tool) => tool.outputSchema).length,
      ).toBeGreaterThanOrEqual(33);
      const widget = await client.readResource({
        uri: "ui://chatgpt-code/tool-result-v2.html",
      });
      expect(widget.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect("text" in widget.contents[0]! ? widget.contents[0].text : "").toContain(
        "CHATGPT CODE",
      );

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
            uri: "ui://chatgpt-code/tool-result-v2.html",
          })
        ).contents[0]?.mimeType,
      ).toBe("text/html;profile=mcp-app");
    } finally {
      await client.close().catch(() => {});
      await sseClient.close().catch(() => {});
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe("OAuth pairing", () => {
  it("accepts a code rotated by another process while the service is running", async () => {
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

    try {
      const registrationResponse = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "OAuth rotation test",
          redirect_uris: ["http://127.0.0.1/oauth/callback"],
        }),
      });
      expect(registrationResponse.status).toBe(201);
      const registration = (await registrationResponse.json()) as {
        client_id: string;
      };

      // A separate config object reproduces `chatgpt-code auth rotate` running
      // in another process while the service retains its startup config.
      const externalConfig = await loadConfig({ cwd: workspace, dataDir });
      const pairingCode = await rotatePairingCode(
        externalConfig.config,
        externalConfig.configPath,
      );
      expect(loaded.config.pairingSecretHash).not.toBe(
        externalConfig.config.pairingSecretHash,
      );

      const verifier = "oauth-rotation-test-verifier-which-is-long-enough";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorizationResponse = await fetch(`${base}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          pairing_code: pairingCode,
          client_id: registration.client_id,
          redirect_uri: "http://127.0.0.1/oauth/callback",
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: `${base}/mcp`,
          scope: ALL_SCOPES.join(" "),
          state: "rotation-test",
        }),
      });
      expect(authorizationResponse.status).toBe(302);
      const redirect = new URL(authorizationResponse.headers.get("location")!);
      expect(redirect.searchParams.get("state")).toBe("rotation-test");
      const authorizationCode = redirect.searchParams.get("code");
      expect(authorizationCode).toBeTruthy();

      const tokenResponse = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode!,
          client_id: registration.client_id,
          redirect_uri: "http://127.0.0.1/oauth/callback",
          code_verifier: verifier,
        }),
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = (await tokenResponse.json()) as {
        access_token?: string;
        refresh_token?: string;
      };
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
