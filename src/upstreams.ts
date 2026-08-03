import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export class UpstreamManager {
  private readonly connections = new Map<string, Connection>();
  private readonly servers = new Set<McpServer>();

  constructor(
    private readonly config: AppConfig,
    private readonly events: ActivityStore,
    private readonly persist: () => Promise<void>,
  ) {}

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
      }
    }
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
    if (this.connections.has(input.id)) await this.disconnect(input.id, false);
    const client = new Client(
      { name: `chatgpt-code-upstream-${input.id}`, version: "0.1.0" },
      {
        capabilities: {},
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
      id: compactId(input.id || input.name),
      enabled: true,
    };
    this.connections.set(normalized.id, {
      config: normalized,
      client,
      tools: new Map(),
      registrations: new Map(),
    });
    const existing = this.config.upstreams.findIndex((item) => item.id === normalized.id);
    if (existing >= 0) this.config.upstreams[existing] = normalized;
    else this.config.upstreams.push(normalized);
    await this.syncTools(normalized.id);
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
          this.call(connection.config.id, tool.name, args as Record<string, unknown>),
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
    const result = await connection.client.callTool({
      name: toolName,
      arguments: args,
    });
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

  async disconnect(id: string, save = true): Promise<{ disconnected: boolean }> {
    const connection = this.connections.get(id);
    if (!connection) return { disconnected: false };
    for (const registrations of connection.registrations.values()) {
      for (const registration of registrations.values()) registration.remove();
    }
    await connection.client.close();
    this.connections.delete(id);
    const config = this.config.upstreams.find((item) => item.id === id);
    if (config) config.enabled = false;
    if (save) await this.persist();
    for (const server of this.servers) {
      try {
        server.sendToolListChanged();
      } catch {
        // Disconnected request-scoped servers do not need a notification.
      }
    }
    this.events.publish("mcp", "Upstream MCP disconnected", "success", id);
    return { disconnected: true };
  }
}
