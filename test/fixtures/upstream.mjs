import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture-upstream", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo fixture text.",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
    structuredContent: { text },
  }),
);
server.registerTool(
  "content_only",
  {
    description: "Return MCP content without structuredContent.",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);
server.registerTool(
  "elicit",
  {
    description: "Request explicit form input from the downstream MCP client.",
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ message }) => {
    const result = await server.server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["approved"],
      },
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
);
await server.connect(new StdioServerTransport());
