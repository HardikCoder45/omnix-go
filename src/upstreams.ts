import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import type { AppConfig, UpstreamConfig } from "./types.js";
import type { ActivityStore } from "./events.js";
import { compactId } from "./utils.js";

interface Connection {
  config: UpstreamConfig;
  client: Client;
  tools: Map<string, UpstreamTool>;
  registrations: Map<McpServer, Map<string, RegisteredTool>>;
  activeCallers: Map<McpServer, number>;
}

interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
}

export interface ConnectedToolDescriptor extends UpstreamTool {
  mcpId: string;
  mcpName: string;
  publicName: string;
}

function environment(input?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...input };
}

function schemaToZod(schema: unknown): ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.unknown();
  const value = schema as Record<string, unknown>;
  if (Array.isArray(value.enum)) {
    const literals = value.enum.map((entry) => z.literal(entry as never));
    if (literals.length === 1) return literals[0]!;
    if (literals.length > 1) {
      return z.union(
        literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]],
      );
    }
  }
  if (Array.isArray(value.anyOf)) {
    const options = value.anyOf.map(schemaToZod);
    if (options.length >= 2) {
      return z.union(options as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    }
  }
  if (Array.isArray(value.oneOf)) {
    const options = value.oneOf.map(schemaToZod);
    if (options.length >= 2) {
      return z.union(options as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    }
  }
  switch (value.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array":
      return z.array(schemaToZod(value.items));
    case "object":
    default: {
      const properties =
        value.properties && typeof value.properties === "object"
          ? (value.properties as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(value.required)
          ? value.required.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, child] of Object.entries(properties)) {
        const parsed = schemaToZod(child);
        shape[key] = required.has(key) ? parsed : parsed.optional();
      }
      return z.object(shape).passthrough();
    }
  }
}

type ApprovalResult = { action: "accept" | "decline"; content?: Record<string, string | number | boolean> };

interface PendingOwnerApproval {
  id: string;
  upstreamId: string;
  name: string;
  message: string;
  riskLevel: string;
  subtitle?: string;
  appId?: string;
  createdAt: number;
  expiresAt: number;
  resolve: (decision: ApprovalResult) => void;
}

function isEmptyApprovalForm(params: { mode?: string; requestedSchema?: unknown }): boolean {
  const schema = params.requestedSchema as { type?: string; properties?: Record<string, unknown>; required?: unknown } | undefined;
  return params.mode !== "url" && schema?.type === "object" && Object.keys(schema.properties ?? {}).length === 0
    && (!Array.isArray(schema.required) || schema.required.length === 0);
}

export class UpstreamManager {
  private readonly pendingOwnerApprovals = new Map<string, PendingOwnerApproval>();
  private readonly sessionAppGrants = new Map<string, Set<string>>();
  private readonly connections = new Map<string, Connection>();
  private readonly servers = new Set<McpServer>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectAttempts = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly events: ActivityStore,
    private readonly persist: () => Promise<void>,
  ) {}

  getAllAppsAccess(): boolean {
    return this.config.codexAllAppsAccess === true;
  }

  async setAllAppsAccess(enabled: boolean): Promise<void> {
    const previous = this.config.codexAllAppsAccess;
    this.config.codexAllAppsAccess = enabled;
    try {
      await this.persist();
    } catch (error) {
      this.config.codexAllAppsAccess = previous;
      throw error;
    }
    this.events.publish("security", enabled
      ? "Owner enabled persistent Codex all-app access"
      : "Owner disabled persistent Codex all-app access", "success");
  }

  private codexAppPermission(upstreamId: string, params: { message: string; mode?: string; requestedSchema?: unknown; _meta?: Record<string, unknown> }): string | undefined {
    if (upstreamId !== "codex-cua-wrapper" && upstreamId !== "codex-cua-direct") return undefined;
    if (!isEmptyApprovalForm(params)) return undefined;
    const meta = params._meta ?? {};
    const toolParams = meta.tool_params as Record<string, unknown> | undefined;
    return meta.codex_approval_kind === "mcp_tool_call"
      && meta.tool_name === "get_app_state"
      && typeof toolParams?.app === "string" && toolParams.app.length > 0
      && /^Allow Computer Use to use ".+"\?$/.test(params.message)
      ? toolParams.app : undefined;
  }

  listPendingApprovals(): Array<{
    id: string;
    upstreamId: string;
    name: string;
    message: string;
    riskLevel: string;
    subtitle?: string;
    appId?: string;
    expiresAt: number;
  }> {
    return [...this.pendingOwnerApprovals.values()].map(({ id, upstreamId, name, message, riskLevel, subtitle, appId, expiresAt }) => ({
      id, upstreamId, name, message, riskLevel,
      ...(subtitle ? { subtitle } : {}),
      ...(appId ? { appId } : {}),
      expiresAt,
    }));
  }

  answerPendingApproval(id: string, action: "accept" | "decline", rememberSession = false): void {
    const pending = this.pendingOwnerApprovals.get(id);
    if (!pending) throw new Error("Approval request has expired or is unknown.");
    if (action === "accept" && rememberSession && pending.appId) {
      const grants = this.sessionAppGrants.get(pending.upstreamId) ?? new Set<string>();
      grants.add(pending.appId);
      this.sessionAppGrants.set(pending.upstreamId, grants);
    }
    pending.resolve(action === "accept" ? { action: "accept", content: {} } : { action: "decline" });
    this.events.publish("security", "Computer-use approval decided by local owner", "success", pending.name);
  }

  private requestLocalApproval(
    upstreamId: string,
    name: string,
    params: { message: string; mode?: string; requestedSchema?: unknown; _meta?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ApprovalResult> {
    if (!isEmptyApprovalForm(params)) {
      throw new Error("This MCP approval needs a form with fields; use an MCP client that supports elicitation.");
    }
    if (signal.aborted) return Promise.resolve({ action: "decline" });
    const meta = params._meta ?? {};
    const appId = this.codexAppPermission(upstreamId, params);
    if (this.pendingOwnerApprovals.size >= 10) throw new Error("Local approval inbox is full.");
    const id = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + 45_000;
    return new Promise<ApprovalResult>((resolve) => {
      const finish = (decision: ApprovalResult) => {
        clearTimeout(timer);
        this.pendingOwnerApprovals.delete(id);
        signal.removeEventListener("abort", cancel);
        resolve(decision);
      };
      const cancel = () => finish({ action: "decline" });
      const timer = setTimeout(() => {
        this.events.publish("security", "MCP approval expired without owner decision", "warning", name);
        cancel();
      }, 45_000);
      timer.unref?.();
      this.pendingOwnerApprovals.set(id, {
        id, upstreamId, name, message: params.message,
        riskLevel: String(meta.riskLevel ?? "unspecified"),
        ...(typeof meta.subtitle === "string" ? { subtitle: meta.subtitle } : {}),
        ...(appId ? { appId } : {}),
        createdAt, expiresAt, resolve: finish,
      });
      signal.addEventListener("abort", cancel, { once: true });
      this.events.publish("security", "MCP permission requires local owner approval", "warning", name);
    });
  }

  attachServer(server: McpServer): void {
    if (this.servers.has(server)) return;
    this.servers.add(server);
    for (const connection of this.connections.values()) {
      this.syncServerRegistrations(connection, server);
    }
  }

  detachServer(server: McpServer): void {
    for (const connection of this.connections.values()) {
      const registrations = connection.registrations.get(server);
      if (!registrations) continue;
      for (const registration of registrations.values()) registration.remove();
      connection.registrations.delete(server);
    }
    this.servers.delete(server);
  }

  async restore(): Promise<void> {
    for (const upstream of this.config.upstreams.filter((item) => item.enabled)) {
      try {
        await this.connect(upstream, false);
      } catch (error) {
        this.events.publish(
          "mcp",
          "Upstream restore failed",
          "warning",
          `${upstream.name}: ${String(error)}`,
        );
        this.scheduleReconnect(upstream);
      }
    }
  }

  private removeRegistrations(connection: Connection): void {
    for (const registrations of connection.registrations.values()) {
      for (const registration of registrations.values()) registration.remove();
    }
    for (const server of this.servers) {
      try {
        server.sendToolListChanged();
      } catch {
        // Request-scoped servers without an active transport need no notification.
      }
    }
  }

  private scheduleReconnect(config: UpstreamConfig): void {
    if (!config.enabled || this.reconnectTimers.has(config.id)) return;
    const attempt = (this.reconnectAttempts.get(config.id) ?? 0) + 1;
    this.reconnectAttempts.set(config.id, attempt);
    const delay = Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000);
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(config.id);
      try {
        await this.connect(config, false);
        this.reconnectAttempts.delete(config.id);
        this.events.publish(
          "mcp",
          "Upstream MCP reconnected",
          "success",
          config.name,
        );
      } catch (error) {
        this.events.publish(
          "mcp",
          "Upstream reconnect failed",
          "warning",
          `${config.name}: ${String(error)}`,
        );
        this.scheduleReconnect(config);
      }
    }, delay);
    timer.unref();
    this.reconnectTimers.set(config.id, timer);
    this.events.publish(
      "mcp",
      "Upstream reconnect scheduled",
      "warning",
      `${config.name}: retrying in ${Math.round(delay / 1_000)}s`,
    );
  }

  private handleUnexpectedClose(id: string, client: Client): void {
    const connection = this.connections.get(id);
    if (!connection || connection.client !== client) return;
    this.connections.delete(id);
    this.clearConnectionApprovals(id);
    this.removeRegistrations(connection);
    this.events.publish(
      "mcp",
      "Upstream MCP disconnected unexpectedly",
      "warning",
      connection.config.name,
    );
    this.scheduleReconnect(connection.config);
  }

  list(): Array<
    UpstreamConfig & { connected: boolean; toolCount: number; tools: string[] }
  > {
    return this.config.upstreams.map((config) => {
      const connection = this.connections.get(config.id);
      return {
        ...config,
        ...(config.headers
          ? {
              headers: Object.fromEntries(
                Object.keys(config.headers).map((key) => [key, "[configured]"]),
              ),
            }
          : {}),
        connected: Boolean(connection),
        toolCount: connection?.tools.size ?? 0,
        tools: connection ? [...connection.tools.keys()] : [],
      };
    });
  }

  describe(id?: string): ConnectedToolDescriptor[] {
    const connections = id
      ? [this.connections.get(compactId(id))].filter(
          (connection): connection is Connection => Boolean(connection),
        )
      : [...this.connections.values()];
    if (id && connections.length === 0) {
      throw new Error(`Connected MCP not found: ${id}`);
    }
    return connections.flatMap((connection) =>
      [...connection.tools.values()].map((tool) => ({
        ...tool,
        mcpId: connection.config.id,
        mcpName: connection.config.name,
        publicName: this.publicToolName(connection.config.id, tool.name),
      })),
    );
  }

  async connect(input: UpstreamConfig, save = true): Promise<ReturnType<UpstreamManager["list"]>[number]> {
    const managedConfig = this.config.upstreams.find(
      (item) => item.id === input.id && item.managed,
    );
    if (managedConfig && !input.managed) {
      throw new Error(`Managed MCP cannot be replaced: ${input.id}`);
    }
    if (this.connections.has(input.id)) await this.disconnect(input.id, false, true);
    const client = new Client(
      { name: `omnix-go-upstream-${input.id}`, version: "0.4.1" },
      {
        capabilities: {
          elicitation: { form: {} },
        },
        listChanged: {
          tools: {
            onChanged: (error) => {
              if (error) {
                this.events.publish(
                  "mcp",
                  "Upstream tool refresh failed",
                  "error",
                  `${input.name}: ${error.message}`,
                );
                return;
              }
              void this.syncTools(input.id);
            },
          },
        },
      },
    );
    const connectionId = compactId(input.id || input.name);
    client.setRequestHandler(ElicitRequestSchema, async (request, { signal }) => {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        throw new Error(`Cannot route elicitation for disconnected MCP: ${input.name}`);
      }
      const activeServers = [...connection.activeCallers.entries()]
        .filter(([, count]) => count > 0)
        .map(([server]) => server);
      if (activeServers.length === 0) {
        throw new Error(
          `${input.name} requested user input outside an active downstream tool call.`,
        );
      }
      // Owner grants are limited to empty, exact native-app access requests.
      const appId = this.codexAppPermission(connectionId, request.params);
      if (appId && this.getAllAppsAccess()) {
        this.events.publish("security", "Using persistent owner-approved Codex all-app access", "success", appId);
        return { action: "accept" as const, content: {} };
      }
      if (appId && this.sessionAppGrants.get(connectionId)?.has(appId)) {
        this.events.publish("security", "Reusing explicit owner-approved app grant", "success", appId);
        return { action: "accept" as const, content: {} };
      }
      if (activeServers.length > 1) {
        throw new Error(
          `${input.name} requested user input while multiple downstream MCP sessions were active; refusing ambiguous routing.`,
        );
      }
      try {
        return await activeServers[0]!.server.elicitInput(request.params, { signal });
      } catch (error) {
        // Some ChatGPT MCP clients cannot display form elicitation at all.
        // For Codex CUA, hand the request to a local owner-only inbox instead
        // of permanently blocking the upstream or silently accepting it.
        if ((connectionId !== "codex-cua-wrapper" && connectionId !== "codex-cua-direct")
          || !(String(error).includes("Client does not support form elicitation")
            || (error instanceof McpError && error.code === ErrorCode.MethodNotFound))) {
          throw error;
        }
        return this.requestLocalApproval(connectionId, input.name, request.params, signal);
      }
    });

    const headers = input.headers ?? {};
    if (input.transport === "stdio") {
      if (!input.command) throw new Error("stdio MCP requires command");
      await client.connect(
        new StdioClientTransport({
          command: input.command,
          args: input.args ?? [],
          ...(input.cwd ? { cwd: input.cwd } : {}),
          env: environment(),
          stderr: "pipe",
        }),
      );
    } else if (input.transport === "http") {
      if (!input.url) throw new Error("HTTP MCP requires url");
      await client.connect(
        new StreamableHTTPClientTransport(new URL(input.url), {
          requestInit: { headers },
        }),
      );
    } else {
      if (!input.url) throw new Error("SSE MCP requires url");
      await client.connect(
        new SSEClientTransport(new URL(input.url), {
          requestInit: { headers },
          eventSourceInit: {
            fetch: (url, init) => {
              const eventHeaders = new Headers(init?.headers);
              for (const [key, value] of Object.entries(headers)) {
                eventHeaders.set(key, value);
              }
              return fetch(url, {
                ...init,
                headers: eventHeaders,
              });
            },
          },
        }),
      );
    }

    const normalized: UpstreamConfig = {
      ...input,
      id: connectionId,
      enabled: true,
    };
    this.connections.set(normalized.id, {
      config: normalized,
      client,
      tools: new Map(),
      registrations: new Map(),
      activeCallers: new Map(),
    });
    client.onclose = () => this.handleUnexpectedClose(normalized.id, client);
    client.onerror = (error) => {
      this.events.publish(
        "mcp",
        "Upstream MCP transport error",
        "warning",
        `${normalized.name}: ${error.message}`,
      );
    };
    const existing = this.config.upstreams.findIndex((item) => item.id === normalized.id);
    if (existing >= 0) this.config.upstreams[existing] = normalized;
    else this.config.upstreams.push(normalized);
    await this.syncTools(normalized.id);
    this.reconnectAttempts.delete(normalized.id);
    if (save) await this.persist();
    this.events.publish("mcp", "Upstream MCP connected", "success", normalized.name);
    return this.list().find((item) => item.id === normalized.id)!;
  }

  private async syncTools(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    const listed = await connection.client.listTools();
    connection.tools = new Map(
      listed.tools.map((tool) => [
        tool.name,
        {
          name: tool.name,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        },
      ]),
    );
    for (const server of this.servers) this.syncServerRegistrations(connection, server);
    this.events.publish(
      "mcp",
      "Tool inventory updated",
      "success",
      `${connection.config.name}: ${connection.tools.size} tools`,
    );
  }

  private syncServerRegistrations(connection: Connection, server: McpServer): void {
    let registrations = connection.registrations.get(server);
    if (!registrations) {
      registrations = new Map();
      connection.registrations.set(server, registrations);
    }
    for (const [upstreamName, registration] of registrations) {
      if (!connection.tools.has(upstreamName)) {
        registration.remove();
        registrations.delete(upstreamName);
      }
    }
    for (const tool of connection.tools.values()) {
      if (registrations.has(tool.name)) continue;
      const publicName = this.publicToolName(connection.config.id, tool.name);
      const registration = server.registerTool(
        publicName,
        {
          title: `${connection.config.name} · ${tool.title ?? tool.name}`,
          description: `Connected MCP “${connection.config.name}”: ${tool.description ?? tool.name}`,
          inputSchema: schemaToZod(tool.inputSchema),
          ...(tool.outputSchema && typeof tool.outputSchema === "object"
            ? { outputSchema: schemaToZod(tool.outputSchema) }
            : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          _meta: {
            securitySchemes: [{ type: "oauth2", scopes: ["mcp:connect"] }],
            "openai/toolInvocation/invoking": `Calling ${connection.config.name}…`,
            "openai/toolInvocation/invoked": `${connection.config.name} returned a result.`,
            upstreamMcp: connection.config.id,
            upstreamTool: tool.name,
            originalInputSchema: tool.inputSchema,
          },
        },
        async (args) =>
          this.call(
            connection.config.id,
            tool.name,
            args as Record<string, unknown>,
            server,
          ),
      );
      registrations.set(tool.name, registration);
    }
    try {
      server.sendToolListChanged();
    } catch {
      // A newly created HTTP server may not have a transport until its request starts.
    }
  }

  async call(
    id: string,
    toolName: string,
    args: Record<string, unknown> = {},
    downstreamServer?: McpServer,
  ): Promise<CallToolResult> {
    const connection = this.connections.get(compactId(id));
    if (!connection) throw new Error(`Connected MCP not found: ${id}`);
    if (!connection.tools.has(toolName)) {
      throw new Error(
        `Tool “${toolName}” was not found on ${connection.config.name}. ` +
          `Available tools: ${[...connection.tools.keys()].join(", ") || "(none)"}`,
      );
    }
    this.events.publish(
      "mcp",
      `Calling ${connection.config.name}`,
      "running",
      toolName,
      { arguments: args },
    );
    const result = await (async () => {
      if (downstreamServer) {
        connection.activeCallers.set(
          downstreamServer,
          (connection.activeCallers.get(downstreamServer) ?? 0) + 1,
        );
      }
      try {
        return await connection.client.callTool({
          name: toolName,
          arguments: args,
        });
      } finally {
        if (downstreamServer) {
          const remaining = (connection.activeCallers.get(downstreamServer) ?? 1) - 1;
          if (remaining <= 0) connection.activeCallers.delete(downstreamServer);
          else connection.activeCallers.set(downstreamServer, remaining);
        }
      }
    })();
    const normalized: CallToolResult =
      "content" in result
        ? (result as CallToolResult)
        : {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
    this.events.publish(
      "mcp",
      `Completed ${connection.config.name}`,
      normalized.isError ? "error" : "success",
      toolName,
    );
    return normalized;
  }

  private publicToolName(id: string, toolName: string): string {
    return `mcp_${compactId(id)}__${compactId(toolName)}`.slice(0, 120);
  }

  private clearConnectionApprovals(id: string): void {
    this.sessionAppGrants.delete(id);
    for (const pending of this.pendingOwnerApprovals.values()) {
      if (pending.upstreamId === id) pending.resolve({ action: "decline" });
    }
  }

  async disconnect(
    id: string,
    save = true,
    allowManaged = false,
  ): Promise<{ disconnected: boolean; managed?: boolean }> {
    const configured = this.config.upstreams.find((item) => item.id === id);
    if (configured?.managed && !allowManaged) {
      return { disconnected: false, managed: true };
    }
    const connection = this.connections.get(id);
    if (!connection) return { disconnected: false };
    if (configured) configured.enabled = false;
    const reconnectTimer = this.reconnectTimers.get(id);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.reconnectTimers.delete(id);
    this.reconnectAttempts.delete(id);
    this.connections.delete(id);
    this.clearConnectionApprovals(id);
    this.removeRegistrations(connection);
    await connection.client.close();
    if (save) await this.persist();
    this.events.publish("mcp", "Upstream MCP disconnected", "success", id);
    return { disconnected: true };
  }
}
