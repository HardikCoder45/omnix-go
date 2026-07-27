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
await server.connect(new StdioServerTransport());
