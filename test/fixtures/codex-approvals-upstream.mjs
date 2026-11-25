import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "codex-approval-fixture", version: "1.0.0" });
server.registerTool("app_prompt", {
  description: "Ask for exact Safari app permission.",
  inputSchema: {},
}, async () => {
  const result = await server.server.elicitInput({
    mode: "form",
    message: 'Allow Computer Use to use "Safari"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "get_app_state",
      tool_params: { app: "com.apple.Safari" },
      riskLevel: "high",
      subtitle: "Granting access to this app introduces risks.",
    },
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
server.registerTool("notion_prompt", {
  description: "Ask for Notion app permission.",
  inputSchema: {},
}, async () => {
  const result = await server.server.elicitInput({
    mode: "form",
    message: 'Allow Computer Use to use "Notion"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "get_app_state",
      tool_params: { app: "notion.id" },
      riskLevel: "high",
    },
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
server.registerTool("unrelated_prompt", {
  description: "Ask for unrelated high risk action.",
  inputSchema: {},
}, async () => {
  const result = await server.server.elicitInput({
    mode: "form",
    message: "Allow sending a message?",
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "send_message",
      riskLevel: "high",
    },
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
server.registerTool("fields_prompt", {
  description: "Ask for a form with required fields.",
  inputSchema: { purpose: z.string().optional() },
}, async () => {
  const result = await server.server.elicitInput({
    mode: "form",
    message: 'Allow Computer Use to use "Safari"?',
    requestedSchema: { type: "object", properties: { secret: { type: "string" } }, required: ["secret"] },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "get_app_state",
      tool_params: { app: "com.apple.Safari" },
    },
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
