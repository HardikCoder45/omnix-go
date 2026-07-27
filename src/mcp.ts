import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppConfig, UpstreamConfig } from "./types.js";
import type { ActivityStore } from "./events.js";
import { PathGuard } from "./paths.js";
import { FileService } from "./files.js";
import { TerminalManager } from "./terminal.js";
import { GitService } from "./git.js";
import { ComputerService } from "./computer.js";
import { SkillInventory } from "./skills.js";
import { AgentHarness } from "./harness.js";
import { UpstreamManager } from "./upstreams.js";
import { jsonText } from "./utils.js";

const TOOL_UI_URI = "ui://chatgpt-code/tool-result-v2.html";

export interface McpRuntime {
  server: McpServer;
  createServer: () => McpServer;
  disposeServer: (server: McpServer) => void;
  paths: PathGuard;
  files: FileService;
  terminal: TerminalManager;
  git: GitService;
  computer: ComputerService;
  skills: SkillInventory;
  harness: AgentHarness;
  upstreams: UpstreamManager;
}

function authMeta(scope: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    securitySchemes: [{ type: "oauth2", scopes: [scope] }],
    ui: { resourceUri: TOOL_UI_URI },
    "openai/outputTemplate": TOOL_UI_URI,
    "openai/toolInvocation/invoking": "Working locally…",
    "openai/toolInvocation/invoked": "Local result ready.",
    ...extra,
  };
}

function requireScope(
  extra: { authInfo?: { scopes: string[] } },
  scope: string,
): void {
  if (extra.authInfo && !extra.authInfo.scopes.includes(scope)) {
    throw new Error(`OAuth token is missing required scope: ${scope}`);
  }
}

interface AdvertisedTool {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  outputSchema?: Record<string, unknown>;
  securitySchemes?: unknown;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ToolListResult {
  tools: AdvertisedTool[];
  [key: string]: unknown;
}

/**
 * The base MCP SDK currently preserves ChatGPT security declarations only in
 * `_meta`. Current ChatGPT plugin discovery also reads the top-level
 * `securitySchemes` extension. Enrich the outgoing descriptor without changing
 * the standard MCP registration and invocation behavior.
 */
function installChatGptToolDescriptorCompatibility(server: McpServer): void {
  const protocol = server.server;
  const originalSetRequestHandler = protocol.setRequestHandler.bind(protocol);
  const textOnlyTools = new Set(["computer_screenshot", "read_chatgpt_code_guide"]);

  type RequestHandler = (
    request: unknown,
    extra: unknown,
  ) => unknown | Promise<unknown>;

  const compatibleSetRequestHandler = (
    schema: unknown,
    handler: RequestHandler,
  ): void => {
    if (schema !== ListToolsRequestSchema) {
      originalSetRequestHandler(schema as never, handler as never);
      return;
    }
    originalSetRequestHandler(
      schema as never,
      (async (request: unknown, extra: unknown) => {
        const result = (await handler(request, extra)) as ToolListResult;
        return {
          ...result,
          tools: result.tools.map((tool) => {
            const securitySchemes =
              tool.securitySchemes ?? tool._meta?.securitySchemes;
            const readOnlyHint = tool.annotations?.readOnlyHint ?? false;
            return {
              ...tool,
              ...(securitySchemes === undefined ? {} : { securitySchemes }),
              ...(
                tool.outputSchema || textOnlyTools.has(tool.name)
                  ? {}
                  : {
                      outputSchema: {
                        type: "object",
                        additionalProperties: true,
                      },
                    }
              ),
              annotations: {
                ...tool.annotations,
                readOnlyHint,
                destructiveHint:
                  tool.annotations?.destructiveHint ?? !readOnlyHint,
                openWorldHint: tool.annotations?.openWorldHint ?? false,
              },
            };
          }),
        };
      }) as never,
    );
  };

  protocol.setRequestHandler =
    compatibleSetRequestHandler as typeof protocol.setRequestHandler;
}

export async function createMcpRuntime(input: {
  config: AppConfig;
  events: ActivityStore;
  persist: () => Promise<void>;
}): Promise<McpRuntime> {
  const { config, events, persist } = input;
  const paths = await PathGuard.create(config);
  const files = new FileService(paths, events);
  const terminal = new TerminalManager(config, paths, events);
  const git = new GitService(paths, events);
  const computer = new ComputerService(config, events);
  const skills = new SkillInventory(config, events);
  const harness = new AgentHarness(config, paths, terminal, events);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const guidePath = path.resolve(moduleDir, "../skills/chatgpt-code/SKILL.md");
  const guide = await readFile(guidePath, "utf8");
  const upstreams = new UpstreamManager(config, events, persist);

  const createServer = (): McpServer => {
    const server = new McpServer(
    {
      name: "chatgpt-code",
      title: "ChatGPT Code",
      version: "0.1.0",
      websiteUrl: "https://localhost.invalid/chatgpt-code",
    },
    {
      instructions:
        "Private local coding and computer-use harness. For complex work, first call read_chatgpt_code_guide. Inspect before editing, stay inside workspace roots, review git_diff, and run relevant evaluators before completion. Ask before destructive, external, or scope-expanding actions.",
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        logging: {},
      },
    },
  );

  installChatGptToolDescriptorCompatibility(server);
  upstreams.attachServer(server);

  server.registerTool(
    "workspace_roots",
    {
      title: "List workspace roots",
      description: "List the only directories this MCP server permits file and command tools to access.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async (_args, extra) => {
      requireScope(extra, "files:read");
      return jsonText(await files.roots());
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 file, optionally limited to an inclusive line range.",
      inputSchema: {
        path: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async (args, extra) => {
      requireScope(extra, "files:read");
      return jsonText(await files.read(args.path, args.startLine, args.endLine));
    },
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List files and directories inside an allowed workspace root.",
      inputSchema: {
        path: z.string(),
        depth: z.number().int().min(1).max(8).optional(),
        includeHidden: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async (args, extra) => {
      requireScope(extra, "files:read");
      return jsonText(
        await files.list(args.path, {
          ...(args.depth === undefined ? {} : { depth: args.depth }),
          ...(args.includeHidden === undefined
            ? {}
            : { includeHidden: args.includeHidden }),
        }),
      );
    },
  );

  server.registerTool(
    "search_files",
    {
      title: "Search workspace files",
      description: "Regex-search text files in an allowed workspace with optional glob filtering.",
      inputSchema: {
        directory: z.string(),
        pattern: z.string(),
        glob: z.string().optional(),
        maxResults: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async (args, extra) => {
      requireScope(extra, "files:read");
      return jsonText(await files.search(args));
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description: "Atomically create or replace a UTF-8 file and return a unified diff.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        createDirectories: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: authMeta("files:write"),
    },
    async (args, extra) => {
      requireScope(extra, "files:write");
      return jsonText(await files.write(args.path, args.content, args.createDirectories));
    },
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description: "Replace an exact text fragment in a UTF-8 file and return a unified diff.",
      inputSchema: {
        path: z.string(),
        oldText: z.string().min(1),
        newText: z.string(),
        replaceAll: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: authMeta("files:write"),
    },
    async (args, extra) => {
      requireScope(extra, "files:write");
      return jsonText(await files.edit(args));
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run terminal command",
      description: "Run a shell command inside an allowed workspace and wait for completion.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
        env: z.record(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("commands:run"),
    },
    async (args, extra) => {
      requireScope(extra, "commands:run");
      return jsonText(await terminal.run(args));
    },
  );

  server.registerTool(
    "start_command",
    {
      title: "Start terminal command",
      description: "Start a long-running command and return a session ID immediately.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("commands:run"),
    },
    async (args, extra) => {
      requireScope(extra, "commands:run");
      const session = await terminal.start(args);
      return jsonText({
        sessionId: session.id,
        pid: session.process.pid,
        startedAt: session.startedAt,
      });
    },
  );

  server.registerTool(
    "terminal_status",
    {
      title: "Read terminal session",
      description: "Read current output and status for a long-running terminal session.",
      inputSchema: { sessionId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("commands:run"),
    },
    async ({ sessionId }, extra) => {
      requireScope(extra, "commands:run");
      return jsonText(terminal.get(sessionId));
    },
  );

  server.registerTool(
    "terminal_input",
    {
      title: "Write terminal input",
      description: "Write input to the stdin of a running terminal session.",
      inputSchema: { sessionId: z.string().uuid(), input: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: authMeta("commands:run"),
    },
    async ({ sessionId, input: value }, extra) => {
      requireScope(extra, "commands:run");
      return jsonText(terminal.write(sessionId, value));
    },
  );

  server.registerTool(
    "terminal_stop",
    {
      title: "Stop terminal session",
      description: "Send SIGTERM to a running terminal session.",
      inputSchema: { sessionId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: authMeta("commands:run"),
    },
    async ({ sessionId }, extra) => {
      requireScope(extra, "commands:run");
      return jsonText(terminal.stop(sessionId));
    },
  );

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description: "Show short Git status for an allowed workspace.",
      inputSchema: { cwd: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async ({ cwd }, extra) => {
      requireScope(extra, "files:read");
      return jsonText(await git.status(cwd));
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description: "Return the current unified Git diff for visual review.",
      inputSchema: {
        cwd: z.string().optional(),
        staged: z.boolean().optional(),
        path: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async (args, extra) => {
      requireScope(extra, "files:read");
      return jsonText(await git.diff(args));
    },
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply Git patch",
      description: "Validate and apply a unified patch inside an allowed workspace.",
      inputSchema: {
        cwd: z.string().optional(),
        patch: z.string().min(1),
        checkOnly: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: authMeta("files:write"),
    },
    async (args, extra) => {
      requireScope(extra, "files:write");
      return jsonText(await git.applyPatch(args));
    },
  );

  server.registerTool(
    "list_skills",
    {
      title: "List local skills",
      description: "List and search skills discovered under configured Codex, Claude, and agent skill roots.",
      inputSchema: { query: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("skills:read"),
    },
    async ({ query }, extra) => {
      requireScope(extra, "skills:read");
      return jsonText({ skills: skills.list(query) });
    },
  );

  server.registerTool(
    "refresh_skills",
    {
      title: "Refresh skill inventory",
      description: "Rescan configured local skill roots and update the live inventory.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("skills:read"),
    },
    async (_args, extra) => {
      requireScope(extra, "skills:read");
      return jsonText({ skills: await skills.refresh() });
    },
  );

  server.registerTool(
    "read_skill",
    {
      title: "Read a local skill",
      description: "Read SKILL.md or another file belonging to a discovered skill.",
      inputSchema: { skill: z.string(), file: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("skills:read"),
    },
    async ({ skill, file }, extra) => {
      requireScope(extra, "skills:read");
      return jsonText(await skills.read(skill, file));
    },
  );

  server.registerTool(
    "evaluate_skill",
    {
      title: "Evaluate a local skill",
      description: "Run structural quality checks on a discovered skill and return a score.",
      inputSchema: { skill: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("skills:read"),
    },
    async ({ skill }, extra) => {
      requireScope(extra, "skills:read");
      return jsonText(await skills.evaluate(skill));
    },
  );

  server.registerTool(
    "make_skill",
    {
      title: "Create a local skill",
      description: "Create a new skill with validated frontmatter in a configured skill root.",
      inputSchema: {
        name: z.string().min(2),
        description: z.string().min(20),
        instructions: z.string().min(40),
        root: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: authMeta("skills:write"),
    },
    async (args, extra) => {
      requireScope(extra, "skills:write");
      return jsonText(await skills.create(args));
    },
  );

  server.registerTool(
    "connect_mcp",
    {
      title: "Connect another MCP server",
      description: "Connect an upstream MCP over stdio, Streamable HTTP, or legacy SSE and immediately add its tools.",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().min(1),
        transport: z.enum(["stdio", "http", "sse"]),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        url: z.string().url().optional(),
        headers: z.record(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: authMeta("mcp:connect"),
    },
    async (args, extra) => {
      requireScope(extra, "mcp:connect");
      const upstream: UpstreamConfig = { ...args, enabled: true };
      const connection = await upstreams.connect(upstream);
      return jsonText({
        connection,
        importedTools: upstreams.describe(connection.id),
        immediateAccess: {
          tool: "call_connected_mcp_tool",
          instructions:
            "The imported direct tools are now advertised by tools/list. If the current ChatGPT conversation has a cached tool catalog, call them immediately through call_connected_mcp_tool; refresh the plugin metadata and start a new conversation to use the direct mcp_<id>__<tool> names.",
        },
      });
    },
  );

  server.registerTool(
    "list_connected_mcps",
    {
      title: "List connected MCP servers",
      description: "List configured upstream MCP servers and the tools currently proxied from each.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("mcp:connect"),
    },
    async (_args, extra) => {
      requireScope(extra, "mcp:connect");
      return jsonText({ connections: upstreams.list() });
    },
  );

  server.registerTool(
    "inspect_connected_mcp_tools",
    {
      title: "Inspect connected MCP tools",
      description:
        "Return the current names, descriptions, input schemas, annotations, and direct proxy names for every tool imported from connected MCP servers. Use this after connect_mcp and before call_connected_mcp_tool.",
      inputSchema: {
        id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("mcp:connect"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "mcp:connect");
      return jsonText({ tools: upstreams.describe(id) });
    },
  );

  server.registerTool(
    "call_connected_mcp_tool",
    {
      title: "Call any connected MCP tool",
      description:
        "Immediately invoke a tool imported from an upstream MCP, including tools connected during the current chat before ChatGPT refreshes its cached direct-tool catalog. First inspect_connected_mcp_tools, then pass the MCP id, original upstream tool name, and schema-valid arguments.",
      inputSchema: {
        id: z.string().min(1),
        tool: z.string().min(1),
        arguments: z.record(z.unknown()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("mcp:connect"),
    },
    async ({ id, tool, arguments: toolArguments }, extra) => {
      requireScope(extra, "mcp:connect");
      return upstreams.call(id, tool, toolArguments ?? {});
    },
  );

  server.registerTool(
    "disconnect_mcp",
    {
      title: "Disconnect MCP server",
      description: "Disconnect an upstream MCP and immediately remove its proxied tools.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: authMeta("mcp:connect"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "mcp:connect");
      return jsonText(await upstreams.disconnect(id));
    },
  );

  server.registerTool(
    "start_agent",
    {
      title: "Start coding subagent",
      description: "Queue an independent Codex coding agent and optional evaluator commands. Returns immediately.",
      inputSchema: {
        prompt: z.string().min(10),
        workspace: z.string().optional(),
        model: z.string().optional(),
        evaluationCommands: z.array(z.string()).max(20).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("agents:run"),
    },
    async (args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await harness.start(args));
    },
  );

  server.registerTool(
    "agent_status",
    {
      title: "Read coding subagent status",
      description: "Read the durable status, output, and evaluator result for one subagent.",
      inputSchema: { taskId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ taskId }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(harness.get(taskId));
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List coding subagents",
      description: "List queued, running, and completed durable coding tasks.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async (_args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ tasks: harness.list() });
    },
  );

  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel coding subagent",
      description: "Cancel a queued or running coding task.",
      inputSchema: { taskId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ taskId }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await harness.cancel(taskId));
    },
  );

  server.registerTool(
    "evaluate_workspace",
    {
      title: "Evaluate workspace",
      description: "Run an ordered set of test, lint, typecheck, or build commands and return a pass/fail report.",
      inputSchema: {
        workspace: z.string().optional(),
        commands: z.array(z.string().min(1)).min(1).max(20),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("commands:run"),
    },
    async (args, extra) => {
      requireScope(extra, "commands:run");
      return jsonText(await harness.evaluate(args));
    },
  );

  server.registerTool(
    "computer_screenshot",
    {
      title: "Capture computer screen",
      description: "Capture the current macOS screen and identify the frontmost application.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("computer:control"),
    },
    async (_args, extra) => {
      requireScope(extra, "computer:control");
      const result = await computer.screenshot();
      return {
        content: [
          { type: "text", text: `Frontmost app: ${result.frontmostApp}` },
          { type: "image", data: result.data, mimeType: result.mimeType },
        ],
      };
    },
  );

  server.registerTool(
    "computer_click",
    {
      title: "Click computer screen",
      description: "Click absolute macOS screen coordinates. Take a fresh screenshot first.",
      inputSchema: {
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        button: z.enum(["left", "right"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: authMeta("computer:control"),
    },
    async ({ x, y, button }, extra) => {
      requireScope(extra, "computer:control");
      await computer.click(x, y, button);
      return jsonText({ clicked: true, x, y, button: button ?? "left" });
    },
  );

  server.registerTool(
    "computer_type",
    {
      title: "Type on computer",
      description: "Type text into the currently focused macOS control.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: authMeta("computer:control"),
    },
    async ({ text }, extra) => {
      requireScope(extra, "computer:control");
      await computer.type(text);
      return jsonText({ typed: text.length });
    },
  );

  server.registerTool(
    "computer_key",
    {
      title: "Press computer key",
      description: "Press a key with optional command, control, option, or shift modifiers.",
      inputSchema: {
        key: z.string(),
        modifiers: z.array(z.enum(["command", "control", "option", "shift"])).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: authMeta("computer:control"),
    },
    async ({ key, modifiers }, extra) => {
      requireScope(extra, "computer:control");
      await computer.key(key, modifiers);
      return jsonText({ pressed: [key, ...(modifiers ?? [])] });
    },
  );

  server.registerTool(
    "computer_scroll",
    {
      title: "Scroll computer",
      description: "Scroll the frontmost macOS application; positive values move down.",
      inputSchema: { amount: z.number().int().min(-50).max(50) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: authMeta("computer:control"),
    },
    async ({ amount }, extra) => {
      requireScope(extra, "computer:control");
      await computer.scroll(amount);
      return jsonText({ scrolled: amount });
    },
  );

  server.registerTool(
    "recent_activity",
    {
      title: "Read recent harness activity",
      description: "Read recent terminal, file, diff, skill, MCP, agent, and computer-use events.",
      inputSchema: { after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async ({ after, limit }, extra) => {
      requireScope(extra, "files:read");
      return jsonText({ events: events.list(after, limit) });
    },
  );

  const widgetUri = TOOL_UI_URI;
  server.registerResource(
    "chatgpt-code-tool-result",
    widgetUri,
    {
      title: "ChatGPT Code tool result",
      description:
        "Universal visual result surface for files, code, diffs, patches, terminals, Git, skills, MCPs, agents, computer use, and activity.",
      mimeType: "text/html;profile=mcp-app",
    },
    async () => {
      const widgetPath = path.resolve(moduleDir, "../public/widget.html");
      return {
        contents: [
          {
            uri: widgetUri,
            mimeType: "text/html;profile=mcp-app",
            text: await readFile(widgetPath, "utf8"),
            _meta: {
              ui: {
                prefersBorder: false,
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                },
              },
              "openai/widgetDescription":
                "Tool-specific local coding UI with code reading, terminal output, Git diff and patch review, file tables, skills, MCP tools, agents, screenshots, and structured fallback views.",
              "openai/widgetPrefersBorder": false,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: [],
              },
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    "show_activity_dashboard",
    {
      title: "Show ChatGPT Code dashboard",
      description: "Render the visual activity dashboard after coding or computer-use work.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read", {
        ui: { resourceUri: widgetUri },
        "openai/outputTemplate": widgetUri,
        "openai/toolInvocation/invoking": "Opening code cockpit…",
        "openai/toolInvocation/invoked": "Code cockpit ready.",
      }),
    },
    async (_args, extra) => {
      requireScope(extra, "files:read");
      const snapshot = {
        events: events.snapshot(),
        skills: skills.list().slice(0, 100),
        agents: harness.list().slice(0, 50),
        connections: upstreams.list(),
        roots: paths.roots,
      };
      return {
        structuredContent: snapshot,
        content: [
          {
            type: "text",
            text: `Showing ${snapshot.events.length} recent events, ${snapshot.skills.length} skills, ${snapshot.agents.length} agent tasks, and ${snapshot.connections.length} MCP connections.`,
          },
        ],
      };
    },
  );

  const guideUri = "chatgpt-code://guide/SKILL.md";
  server.registerResource(
    "chatgpt-code-guide",
    guideUri,
    {
      title: "ChatGPT Code operating guide",
      description:
        "Comprehensive workflow, safety, tool-selection, verification, and recovery instructions for agents using ChatGPT Code.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: guideUri, mimeType: "text/markdown", text: guide }],
    }),
  );

  server.registerTool(
    "read_chatgpt_code_guide",
    {
      title: "Read ChatGPT Code operating guide",
      description:
        "Read the comprehensive operating guide before complex, long-running, unfamiliar, risky, multi-tool, or computer-use work.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("skills:read"),
    },
    async (_args, extra) => {
      requireScope(extra, "skills:read");
      return {
        content: [{ type: "text", text: guide }],
      };
    },
  );

  return server;
  };

  const server = createServer();
  await skills.refresh();
  await harness.restore();
  return {
    server,
    createServer,
    disposeServer: (target) => upstreams.detachServer(target),
    paths,
    files,
    terminal,
    git,
    computer,
    skills,
    harness,
    upstreams,
  };
}
