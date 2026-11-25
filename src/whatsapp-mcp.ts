import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonText } from "./utils.js";
import type { WhatsAppBridge } from "./whatsapp-bridge.js";

// Existing OmniX OAuth scope, until the host introduces separate whatsapp:* scopes.
const SCOPE = "mcp:connect";

function checkScope(extra: { authInfo?: { scopes: string[] } }): void {
  // Match the host's existing stdio behavior (no authInfo) and OAuth transport.
  if (extra.authInfo && !extra.authInfo.scopes.includes(SCOPE)) {
    throw new Error("OAuth token lacks mcp:connect scope.");
  }
}

function meta() {
  return { securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }] };
}

/**
 * Register these tools INSIDE createServer(), so every MCP transport/session
 * receives the tools. Do not register any account-linking or QR disclosure tool.
 * The host still owns its MCP authorization and UI resource compatibility layer.
 */
export function registerWhatsAppTools(server: McpServer, bridge: WhatsAppBridge): void {
  server.registerTool(
    "whatsapp_status",
    {
      title: "WhatsApp bridge status",
      description: "Return local bridge status only. No QR data or message content.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: meta(),
    },
    async (_args, extra) => {
      checkScope(extra);
      return jsonText(bridge.status());
    },
  );

  server.registerTool(
    "whatsapp_list_chats",
    {
      title: "List WhatsApp chats",
      description: "On explicit request after owner QR linking, list chat names and IDs only (no messages).",
      inputSchema: { limit: z.number().int().min(1).max(30).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: meta(),
    },
    async ({ limit }, extra) => {
      checkScope(extra);
      return jsonText({ chats: await bridge.listChats(limit) });
    },
  );

  server.registerTool(
    "whatsapp_read_messages",
    {
      title: "Read selected WhatsApp chat",
      description: "Read up to 30 text message bodies from ONE specified chat, only on explicit owner request after linking. No background scanning.",
      inputSchema: {
        chatId: z.string().min(8).max(80),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: meta(),
    },
    async ({ chatId, limit }, extra) => {
      checkScope(extra);
      return jsonText({ chatId, messages: await bridge.readMessages(chatId, limit) });
    },
  );

  server.registerTool(
    "whatsapp_prepare_send",
    {
      title: "Prepare a WhatsApp message for local approval",
      description: "Stage exact text to one E.164 phone number. Does NOT send. Owner must approve recipient and text in the local OmniX UI.",
      inputSchema: {
        recipient: z.string().min(9).max(16).describe("Full international phone number, e.g. +919876543210"),
        content: z.string().min(1).max(4000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: meta(),
    },
    async ({ recipient, content }, extra) => {
      checkScope(extra);
      const draft = bridge.prepareSend(recipient, content);
      return jsonText({
        ...draft,
        sent: false,
        nextStep: "The owner must inspect the exact recipient and text at the local-only OmniX Go WhatsApp page, click Approve, then explicitly request whatsapp_send_approved with this ID before expiry.",
      });
    },
  );

  server.registerTool(
    "whatsapp_send_approved",
    {
      title: "Send previously approved WhatsApp message",
      description: "Only when expressly requested: sends exactly one previously prepared message, ONLY after the owner independently approves its exact number and text in the local-only OmniX UI. One-shot approval expires in 2 minutes. Never retry automatically.",
      inputSchema: {
        id: z.string().uuid().describe("The exact previously prepared and locally approved message request ID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: meta(),
    },
    async ({ id }, extra) => {
      checkScope(extra);
      return jsonText(await bridge.sendApproved(id));
    },
  );
}
