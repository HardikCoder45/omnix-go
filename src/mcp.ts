import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
import type { AgentBrowser } from "./chatgpt-browser.js";
import { UpstreamManager } from "./upstreams.js";
import { WhatsAppBridge } from "./whatsapp-bridge.js";
import { registerWhatsAppTools } from "./whatsapp-mcp.js";
import { PlanManager } from "./plans.js";
import { AutomationManager } from "./automations.js";
import {
  renderToolUi,
  TOOL_UI_MIME_TYPE,
  toolUiUri,
  toolUiView,
} from "./ui.js";
import { jsonText } from "./utils.js";

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
  plans: PlanManager;
  upstreams: UpstreamManager;
  whatsapp: WhatsAppBridge;
  automations: AutomationManager;
}

const workflowNodeSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["agent", "split", "join", "loop", "delay", "condition", "subworkflow"]),
  name: z.string().min(1).max(200),
  x: z.number().finite(),
  y: z.number().finite(),
  agentTemplateId: z.string().optional(),
  prompt: z.string().max(20_000).optional(),
  workspace: z.string().optional(),
  evaluationCommands: z.array(z.string()).max(20).optional(),
  waitForCompletion: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  iterations: z.number().int().min(1).max(50).optional(),
  condition: z.enum(["always", "input_truthy", "input_equals"]).optional(),
  conditionKey: z.string().optional(),
  conditionValue: z.string().optional(),
  workflowId: z.string().optional(),
});

const workflowEdgeSchema = z.object({
  id: z.string().min(1).max(120),
  source: z.string().min(1),
  target: z.string().min(1),
  sourcePort: z.enum(["always", "success", "failure", "true", "false", "loop", "done"]).optional(),
});

function authMeta(scope: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    securitySchemes: [{ type: "oauth2", scopes: [scope] }],
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
function installChatGptToolDescriptorCompatibility(
  server: McpServer,
  toolUiTemplate: string,
): void {
  const protocol = server.server;
  const originalSetRequestHandler = protocol.setRequestHandler.bind(protocol);
  const originalRegisterTool = server.registerTool.bind(server);
  const textOnlyTools = new Set(["computer_screenshot", "read_omnix_go_guide"]);
  const sharedUiUri = toolUiUri("shared");

  // MCP SDK >=1.32 installs tools/list during McpServer construction.
  // Capture its already-registered handler before applying our metadata adapter.
  const existingListHandler = (protocol as unknown as {
    _requestHandlers?: Map<string, (request: unknown, extra: unknown) => unknown>;
  })._requestHandlers?.get("tools/list");
  protocol.setRequestHandler = compatibleSetRequestHandler as typeof protocol.setRequestHandler;
  if (existingListHandler) {
    protocol.setRequestHandler(ListToolsRequestSchema, existingListHandler as never);
  }

  server.registerResource(
    "omnix-go-tool-result",
    sharedUiUri,
    {
      title: "OmniX Go",
      description: "Clean inline progress and file changes from OmniX Go.",
      mimeType: TOOL_UI_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: sharedUiUri,
          mimeType: TOOL_UI_MIME_TYPE,
          text: renderToolUi(toolUiTemplate, "omnix-go"),
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription": "OmniX Go progress and file changes.",
            "openai/widgetPrefersBorder": false,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: [],
            },
          },
        },
      ],
    }),
  );

  const registerTool = (
    name: string,
    config: unknown,
    callback: unknown,
  ): unknown => {
    const uri = sharedUiUri;
    const originalCallback = callback as (...args: unknown[]) => unknown | Promise<unknown>;
    const configRecord =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {};
    const receivesSyntheticOutputSchema =
      !configRecord.outputSchema && !textOnlyTools.has(name);
    const wrappedCallback = async (...args: unknown[]): Promise<unknown> => {
      const result = await originalCallback(...args);
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;

      const toolResult = result as Record<string, unknown>;
      const existingMeta =
        toolResult._meta && typeof toolResult._meta === "object" && !Array.isArray(toolResult._meta)
          ? (toolResult._meta as Record<string, unknown>)
          : {};
      const structuredContent =
        toolResult.structuredContent ??
        (receivesSyntheticOutputSchema && !toolResult.isError ? {} : undefined);
      const resultEnvelope = {
        content: toolResult.content,
        structuredContent,
        isError: toolResult.isError,
      };

      return {
        ...toolResult,
        ...(structuredContent === undefined ? {} : { structuredContent }),
        _meta: {
          ...existingMeta,
          ui: { resourceUri: uri },
          "openai/outputTemplate": uri,
          omnixGo: { toolName: name, view: toolUiView(name) },
          mcp_tool_result: resultEnvelope,
        },
      };
    };
    return originalRegisterTool(name, config as never, wrappedCallback as never);
  };

  server.registerTool = registerTool as typeof server.registerTool;

  type RequestHandler = (
    request: unknown,
    extra: unknown,
  ) => unknown | Promise<unknown>;

  function compatibleSetRequestHandler(
    schema: unknown,
    handler: RequestHandler,
  ): void {
    if (schema === ReadResourceRequestSchema) {
      originalSetRequestHandler(
        schema as never,
        (async (request: unknown, extra: unknown) => {
          const params = (request as { params?: { uri?: string } }).params;
          const uri = params?.uri ?? "";
          const legacyMatch = /^ui:\/\/omnix-go\/tool-v[34]\/([A-Za-z0-9_-]+)\.html$/.exec(uri);
          if (legacyMatch) {
            const toolName = legacyMatch[1]!;
            return {
              contents: [
                {
                  uri,
                  mimeType: TOOL_UI_MIME_TYPE,
                  text: renderToolUi(toolUiTemplate, toolName),
                  _meta: {
                    ui: {
                      prefersBorder: false,
                      csp: { connectDomains: [], resourceDomains: [] },
                    },
                    "openai/widgetDescription": "OmniX Go progress and file changes.",
                    "openai/widgetPrefersBorder": false,
                    "openai/widgetCSP": {
                      connect_domains: [],
                      resource_domains: [],
                    },
                  },
                },
              ],
            };
          }
          return (handler as (request: unknown, extra: unknown) => unknown)(request, extra);
        }) as never,
      );
      return;
    }
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
            const uiUri = sharedUiUri;
            return {
              ...tool,
              _meta: {
                ...tool._meta,
                ui: { resourceUri: uiUri },
                "openai/outputTemplate": uiUri,
              },
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
  }
}

export async function createMcpRuntime(input: {
  config: AppConfig;
  events: ActivityStore;
  persist: () => Promise<void>;
  agentBrowser?: AgentBrowser;
}): Promise<McpRuntime> {
  const { config, events, persist } = input;
  const paths = await PathGuard.create(config);
  const files = new FileService(paths, events);
  const terminal = new TerminalManager(config, paths, events);
  const git = new GitService(paths, events);
  const computer = new ComputerService(config, events);
  const skills = new SkillInventory(config, events);
  const harness = new AgentHarness(
    config,
    paths,
    terminal,
    events,
    input.agentBrowser,
  );
  const plans = new PlanManager(config, events);
  await plans.initialize();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const guidePath = path.resolve(moduleDir, "../skills/omnix-go/SKILL.md");
  const guide = await readFile(guidePath, "utf8");
  const toolUiTemplate = await readFile(
    path.resolve(moduleDir, "../public/tool-ui.html"),
    "utf8",
  );
  const upstreams = new UpstreamManager(config, events, persist);
  const whatsapp = new WhatsAppBridge(path.join(config.dataDir, "whatsapp-web"));
  const automations = new AutomationManager(config, events, harness);

  const createServer = (): McpServer => {
    const server = new McpServer(
    {
      name: "omnix-go",
      title: "OmniX Go",
      version: "0.4.1",
      websiteUrl: "https://localhost.invalid/omnix-go",
    },
    {
      instructions:
        "Private local coding and computer-use harness. For complex work, first call read_omnix_go_guide, then create_plan with a comprehensive ordered checklist before mutating the workspace. Keep exactly one step in progress, call update_plan after each meaningful milestone, and do not claim completion until every checkbox is completed and complete_plan succeeds. Inspect before editing, stay inside workspace roots, review git_diff, and run relevant evaluators before completion. Ask before destructive, external, or scope-expanding actions.",
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        logging: {},
      },
    },
  );

  installChatGptToolDescriptorCompatibility(server, toolUiTemplate);
  upstreams.attachServer(server);
  registerWhatsAppTools(server, whatsapp);

  server.registerTool(
    "list_custom_agents",
    {
      title: "List custom agents",
      description: "List reusable browser-agent profiles configured in OmniX Go.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async (_args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ agents: automations.listCustomAgents() });
    },
  );

  server.registerTool(
    "save_custom_agent",
    {
      title: "Create or update custom agent",
      description: "Persist a reusable ChatGPT browser-agent profile for manual, scheduled, or workflow runs.",
      inputSchema: {
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(120),
        description: z.string().max(1_000).optional(),
        prompt: z.string().min(1).max(20_000),
        workspace: z.string().optional(),
        model: z.string().optional(),
        evaluationCommands: z.array(z.string()).max(20).optional(),
        tags: z.array(z.string()).max(20).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async (args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ agent: await automations.saveCustomAgent(args) });
    },
  );

  server.registerTool(
    "delete_custom_agent",
    {
      title: "Delete custom agent",
      description: "Delete an unused custom agent profile.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await automations.deleteCustomAgent(id));
    },
  );

  server.registerTool(
    "run_custom_agent",
    {
      title: "Run custom agent",
      description: "Open ChatGPT, start the selected custom agent, send its prompt, and return its conversation tracking details.",
      inputSchema: { id: z.string().uuid(), prompt: z.string().max(20_000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: authMeta("agents:run"),
    },
    async ({ id, prompt }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ agent: await automations.startCustomAgent(id, prompt) });
    },
  );

  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description: "List saved OmniX Go graph workflows.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async (_args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ workflows: automations.listWorkflows() });
    },
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get workflow graph",
      description: "Read one workflow including all graph nodes and edges.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ workflow: automations.getWorkflow(id) });
    },
  );

  server.registerTool(
    "save_workflow",
    {
      title: "Create or update workflow",
      description: "Persist a graph workflow with agent, parallel split, join, condition, bounded loop, delay, and sub-workflow nodes.",
      inputSchema: {
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(160),
        description: z.string().max(2_000).optional(),
        nodes: z.array(workflowNodeSchema).min(1).max(120),
        edges: z.array(workflowEdgeSchema).max(500),
        enabled: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async (args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ workflow: await automations.saveWorkflow(args) });
    },
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete workflow",
      description: "Delete a workflow that has no active schedule or sub-workflow reference.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await automations.deleteWorkflow(id));
    },
  );

  server.registerTool(
    "run_workflow",
    {
      title: "Run workflow",
      description: "Start a graph workflow now. Agent nodes open ChatGPT conversations and progress is tracked by run and conversation ID.",
      inputSchema: { id: z.string().uuid(), input: z.record(z.string(), z.unknown()).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: authMeta("agents:run"),
    },
    async ({ id, input: runInput }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ run: automations.startWorkflow(id, runInput ?? {}) });
    },
  );

  server.registerTool(
    "list_workflow_runs",
    {
      title: "List workflow runs",
      description: "List workflow run status, live node progress, agent IDs, and ChatGPT conversation IDs.",
      inputSchema: { workflowId: z.string().uuid().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ workflowId }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ runs: automations.listRuns(workflowId) });
    },
  );

  server.registerTool(
    "cancel_workflow_run",
    {
      title: "Stop workflow run",
      description: "Stop a workflow and every running browser agent it started.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: authMeta("agents:run"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ run: await automations.cancelRun(id) });
    },
  );

  server.registerTool(
    "list_crons",
    {
      title: "List cron schedules",
      description: "List recurring workflow schedules, next run times, and overlap policies.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async (_args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ schedules: automations.listSchedules() });
    },
  );

  server.registerTool(
    "save_cron",
    {
      title: "Create or update cron schedule",
      description: "Schedule a workflow with a cron expression or @hourly/@daily shorthand and an IANA timezone.",
      inputSchema: {
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(160),
        workflowId: z.string().uuid(),
        cron: z.string().min(1).max(200),
        timezone: z.string().min(1).max(120).optional(),
        enabled: z.boolean().optional(),
        overlapPolicy: z.enum(["skip", "parallel"]).optional(),
        input: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: authMeta("agents:run"),
    },
    async (args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ schedule: await automations.saveSchedule(args) });
    },
  );

  server.registerTool(
    "toggle_cron",
    {
      title: "Pause or resume cron",
      description: "Enable or pause one recurring workflow schedule.",
      inputSchema: { id: z.string().uuid(), enabled: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ id, enabled }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ schedule: await automations.toggleSchedule(id, enabled) });
    },
  );

  server.registerTool(
    "run_cron_now",
    {
      title: "Run scheduled workflow now",
      description: "Immediately trigger one cron schedule without changing its next recurring run.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: authMeta("agents:run"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText({ run: await automations.runScheduleNow(id) });
    },
  );

  server.registerTool(
    "delete_cron",
    {
      title: "Delete cron schedule",
      description: "Permanently delete one recurring workflow schedule.",
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: authMeta("agents:run"),
    },
    async ({ id }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await automations.deleteSchedule(id));
    },
  );

  server.registerTool(
    "create_plan",
    {
      title: "Create comprehensive work plan",
      description:
        "Create and persist an ordered execution plan before complex coding or computer-use work. Include success criteria, assumptions, step details, and verification checks.",
      inputSchema: {
        goal: z.string().min(10).max(2_000),
        context: z.string().max(10_000).optional(),
        successCriteria: z.array(z.string().min(3).max(1_000)).min(1).max(20),
        assumptions: z.array(z.string().min(3).max(1_000)).max(20).optional(),
        steps: z
          .array(
            z.object({
              title: z.string().min(3).max(300),
              description: z.string().max(3_000).optional(),
              verification: z.string().max(2_000).optional(),
            }),
          )
          .min(1)
          .max(50),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: authMeta("files:write", {
        "openai/toolInvocation/invoking": "Building the execution checklist…",
        "openai/toolInvocation/invoked": "Work plan ready.",
      }),
    },
    async (args, extra) => {
      requireScope(extra, "files:write");
      return jsonText({ plan: await plans.create(args) });
    },
  );

  server.registerTool(
    "get_plan",
    {
      title: "Show current work plan",
      description:
        "Read one plan with its checklist, progress percentage, current step, success criteria, assumptions, and completion state. Without an ID, returns the active or latest plan.",
      inputSchema: { planId: z.string().uuid().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read", {
        "openai/toolInvocation/invoking": "Loading the checklist…",
        "openai/toolInvocation/invoked": "Plan progress ready.",
      }),
    },
    async ({ planId }, extra) => {
      requireScope(extra, "files:read");
      return jsonText({ plan: plans.get(planId) });
    },
  );

  server.registerTool(
    "list_plans",
    {
      title: "List work plans",
      description: "List active or completed persistent plans and their checklist progress.",
      inputSchema: { status: z.enum(["active", "completed"]).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async ({ status }, extra) => {
      requireScope(extra, "files:read");
      return jsonText({ plans: plans.list(status) });
    },
  );

  server.registerTool(
    "update_plan",
    {
      title: "Update plan checklist",
      description:
        "Mark plan steps pending, in progress, blocked, or completed and append evidence notes. Completing the final open checkbox automatically completes the plan.",
      inputSchema: {
        planId: z.string().uuid().optional(),
        updates: z
          .array(
            z.object({
              stepId: z.string().uuid(),
              status: z.enum(["pending", "in_progress", "completed", "blocked"]),
              note: z.string().max(2_000).optional(),
            }),
          )
          .min(1)
          .max(50),
        completionSummary: z.string().max(5_000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: authMeta("files:write", {
        "openai/toolInvocation/invoking": "Updating plan progress…",
        "openai/toolInvocation/invoked": "Checklist updated.",
      }),
    },
    async ({ planId, updates, completionSummary }, extra) => {
      requireScope(extra, "files:write");
      return jsonText(await plans.update(planId, updates, completionSummary));
    },
  );

  server.registerTool(
    "complete_plan",
    {
      title: "Finalize completed plan",
      description:
        "Finalize a plan with outcome and verification evidence. Refuses completion while any checklist step remains pending, in progress, or blocked.",
      inputSchema: {
        planId: z.string().uuid().optional(),
        outcome: z.string().min(3).max(5_000),
        evidence: z.array(z.string().min(1).max(2_000)).max(50).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: authMeta("files:write", {
        "openai/toolInvocation/invoking": "Checking every plan item…",
        "openai/toolInvocation/invoked": "Plan finalized.",
      }),
    },
    async ({ planId, outcome, evidence }, extra) => {
      requireScope(extra, "files:write");
      return jsonText({ plan: await plans.complete(planId, outcome, evidence) });
    },
  );

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
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const result = await terminal.run({
        ...args,
        onChunk:
          progressToken === undefined
            ? undefined
            : async (chunk) => {
                progress += Math.max(1, Buffer.byteLength(chunk.text));
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress,
                    message: JSON.stringify({
                      type: "omnix/terminal-chunk",
                      sessionId: chunk.sessionId,
                      command: chunk.command,
                      cwd: chunk.cwd,
                      stream: chunk.stream,
                      text: chunk.text,
                      startedAt: chunk.startedAt,
                    }),
                  },
                });
              },
      });
      return jsonText(result);
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
        ...terminal.get(session.id),
        pid: session.process.pid,
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
      const write = terminal.write(sessionId, value);
      return jsonText({ ...terminal.get(sessionId), ...write });
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
      const stop = terminal.stop(sessionId);
      return jsonText({ ...terminal.get(sessionId), ...stop });
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
      return upstreams.call(id, tool, toolArguments ?? {}, server);
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
      title: "Start ChatGPT agent conversation",
      description:
        "Open a new ChatGPT conversation in the macOS default browser, prefix the instruction with @OmniX Go, submit it, and persist a durable local agent/session ID plus the ChatGPT conversation ID/URL. Every agent prompt strictly forbids spawning or delegating to subagents. Workspace and evaluator commands are included as task context. The legacy model field is retained for compatibility but does not switch the ChatGPT web model.",
      inputSchema: {
        prompt: z.string().min(10),
        workspace: z.string().optional(),
        model: z.string().optional(),
        evaluationCommands: z.array(z.string().min(1)).max(20).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("agents:run", {
        "openai/toolInvocation/invoking": "Opening ChatGPT agent…",
        "openai/toolInvocation/invoked": "ChatGPT agent started.",
      }),
    },
    async (args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await harness.start(args));
    },
  );

  server.registerTool(
    "start_agents",
    {
      title: "Start multiple ChatGPT agent conversations",
      description:
        "Create multiple independent ChatGPT conversations from one call. Every agent receives its own @OmniX Go-prefixed prompt, a strict no-subagent instruction, and a durable local session ID; the response includes a shared batchId for tracking with list_agents or coordinate_agents.",
      inputSchema: {
        agents: z
          .array(
            z.object({
              prompt: z.string().min(10),
              workspace: z.string().optional(),
              model: z.string().optional(),
              evaluationCommands: z.array(z.string().min(1)).max(20).optional(),
            }),
          )
          .min(2)
          .max(12),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("agents:run", {
        "openai/toolInvocation/invoking": "Opening ChatGPT agents…",
        "openai/toolInvocation/invoked": "ChatGPT agent batch started.",
      }),
    },
    async ({ agents }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await harness.startMany({ agents }));
    },
  );

  server.registerTool(
    "agent_status",
    {
      title: "Refresh ChatGPT agent status",
      description:
        "Navigate to the persisted ChatGPT conversation in the configured macOS default browser, scan the virtualized current branch, and return the durable agent name/session ID, browser/tab identity, every turn node ChatGPT exposes, full rendered main-page text, latest assistant response, response state, conversation ID/URL, and diagnostics for any turn IDs the page omits. Identify the agent with a local task ID, ChatGPT conversation ID, or full conversation URL.",
      inputSchema: {
        agent: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: authMeta("agents:run", {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Refreshing ChatGPT agent…",
        "openai/toolInvocation/invoked": "ChatGPT agent refreshed.",
      }),
    },
    async ({ agent, taskId }, extra) => {
      requireScope(extra, "agents:run");
      const reference = agent ?? taskId;
      if (!reference) throw new Error("Provide agent or taskId.");
      return jsonText(await harness.refresh(reference));
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List ChatGPT agents",
      description:
        "List durable local-to-ChatGPT agent mappings. Pass a batchId to track one batch; set refresh=true to fetch current page data before returning.",
      inputSchema: { refresh: z.boolean().optional(), batchId: z.string().uuid().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: authMeta("agents:run"),
    },
    async ({ refresh, batchId }, extra) => {
      requireScope(extra, "agents:run");
      if (refresh) return jsonText(await harness.coordinate({ ...(batchId ? { batchId } : {}) }));
      return jsonText({ ...(batchId ? { batchId } : {}), tasks: harness.list(batchId) });
    },
  );

  server.registerTool(
    "follow_up_agent",
    {
      title: "Follow up with ChatGPT agent",
      description:
        "Open the existing mapped agent session in the macOS default browser, prefix the follow-up with @OmniX Go, submit it in that same ChatGPT conversation, and refresh the persisted transcript and conversation state. The agent value may be the durable local session ID, ChatGPT conversation ID, or conversation URL.",
      inputSchema: {
        agent: z.string().min(1),
        prompt: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("agents:run", {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Sending agent follow-up…",
        "openai/toolInvocation/invoked": "Agent follow-up sent.",
      }),
    },
    async ({ agent, prompt }, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await harness.followUp(agent, prompt));
    },
  );

  server.registerTool(
    "coordinate_agents",
    {
      title: "Monitor or coordinate ChatGPT agents",
      description:
        "Refresh the rendered main-page text and all current-branch turn nodes ChatGPT exposes for selected agents, or send the same @OmniX Go-prefixed coordination instruction to each selected conversation before refreshing. Pass batchId to target one start_agents batch; otherwise omit agents to target every persisted agent. Omit instruction for monitoring only.",
      inputSchema: {
        agents: z.array(z.string().min(1)).max(50).optional(),
        batchId: z.string().uuid().optional(),
        instruction: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: authMeta("agents:run", {
        "openai/toolInvocation/invoking": "Coordinating ChatGPT agents…",
        "openai/toolInvocation/invoked": "Agent coordination complete.",
      }),
    },
    async (args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await harness.coordinate(args));
    },
  );

  server.registerTool(
    "cancel_agent",
    {
      title: "Stop ChatGPT agent response",
      description:
        "Resolve an agent by durable local session ID, ChatGPT conversation ID, or URL and click ChatGPT's active stop-answering control in that mapped default-browser tab when present. Unrelated browser tabs are not closed.",
      inputSchema: {
        agent: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: authMeta("agents:run", {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Stopping ChatGPT agent…",
        "openai/toolInvocation/invoked": "Agent stop request complete.",
      }),
    },
    async ({ agent, taskId }, extra) => {
      requireScope(extra, "agents:run");
      const reference = agent ?? taskId;
      if (!reference) throw new Error("Provide agent or taskId.");
      return jsonText(await harness.cancel(reference));
    },
  );

  server.registerTool(
    "cancel_agents",
    {
      title: "Stop multiple ChatGPT agent responses",
      description:
        "Stop active ChatGPT responses for an explicit list of mapped agents or every agent in one start_agents batch. Returns every resolved task and a per-agent failure list; unrelated browser tabs are not closed.",
      inputSchema: {
        agents: z.array(z.string().min(1)).min(1).max(50).optional(),
        batchId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: authMeta("agents:run", {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Stopping ChatGPT agents…",
        "openai/toolInvocation/invoked": "Agent stop requests complete.",
      }),
    },
    async (args, extra) => {
      requireScope(extra, "agents:run");
      return jsonText(await harness.cancelMany(args));
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
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const result = await harness.evaluate({
        ...args,
        onProgress:
          progressToken === undefined
            ? undefined
            : async (event) => {
                progress += 1;
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress,
                    message: JSON.stringify({
                      type: "omnix/evaluation-progress",
                      stage: event.stage,
                      command: event.command,
                      index: event.index,
                      total: event.total,
                      stream: event.chunk?.stream,
                      text: event.chunk?.text,
                      sessionId: event.chunk?.sessionId,
                      cwd: event.chunk?.cwd,
                      passed: event.passed,
                      exitCode: event.exitCode,
                    }),
                  },
                });
              },
      });
      return jsonText(result);
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
      description: "Read recent plan, terminal, file, diff, skill, MCP, agent, and computer-use events.",
      inputSchema: { after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read"),
    },
    async ({ after, limit }, extra) => {
      requireScope(extra, "files:read");
      return jsonText({ events: events.list(after, limit) });
    },
  );

  server.registerTool(
    "show_activity_dashboard",
    {
      title: "Show OmniX Go dashboard",
      description: "Render the visual activity dashboard after coding or computer-use work.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: authMeta("files:read", {
        "openai/toolInvocation/invoking": "Opening code cockpit…",
        "openai/toolInvocation/invoked": "Code cockpit ready.",
      }),
    },
    async (_args, extra) => {
      requireScope(extra, "files:read");
      const snapshot = {
        events: events.snapshot(),
        plans: plans.list().slice(0, 25),
        skills: skills.list().slice(0, 100),
        agents: harness.list().slice(0, 50),
        automations: automations.snapshot(),
        connections: upstreams.list(),
        roots: paths.roots,
      };
      return {
        structuredContent: snapshot,
        content: [
          {
            type: "text",
            text: `Showing ${snapshot.plans.length} plans, ${snapshot.events.length} recent events, ${snapshot.skills.length} skills, ${snapshot.agents.length} agent tasks, ${snapshot.automations.workflows.length} workflows, ${snapshot.automations.schedules.length} schedules, and ${snapshot.connections.length} MCP connections.`,
          },
        ],
      };
    },
  );

  const guideUri = "omnix-go://guide/SKILL.md";
  server.registerResource(
    "omnix-go-guide",
    guideUri,
    {
      title: "OmniX Go operating guide",
      description:
        "Comprehensive workflow, safety, tool-selection, verification, and recovery instructions for agents using OmniX Go.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: guideUri, mimeType: "text/markdown", text: guide }],
    }),
  );

  server.registerTool(
    "read_omnix_go_guide",
    {
      title: "Read OmniX Go operating guide",
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
  await automations.initialize();
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
    plans,
    upstreams,
    whatsapp,
    automations,
  };
}
