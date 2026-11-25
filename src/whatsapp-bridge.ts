import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export type WhatsAppPhase = "idle" | "starting" | "qr" | "ready" | "disconnected" | "error";

export interface WhatsAppChat {
  id: string;
  name: string;
  isGroup: boolean;
}

export interface WhatsAppMessage {
  id: string;
  from: string;
  fromMe: boolean;
  body: string;
  timestamp: number;
}

export interface WhatsAppDraft {
  id: string;
  recipient: string;
  content: string;
  expiresAt: number;
  approved: boolean;
}

export interface WhatsAppClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  getChats(): Promise<Array<{ id: { _serialized: string }; name: string; isGroup: boolean }>>;
  getChatById(id: string): Promise<{
    fetchMessages(options: { limit: number }): Promise<Array<{
      id?: { _serialized?: string };
      from?: string;
      fromMe?: boolean;
      body?: string;
      timestamp?: number;
    }>>;
  }>;
  sendMessage(id: string, content: string): Promise<{ id?: { _serialized?: string } }>;
}

export type WhatsAppClientFactory = (authDirectory: string) => Promise<WhatsAppClient>;

export async function createWhatsAppWebClient(authDirectory: string): Promise<WhatsAppClient> {
  // The dependency is intentionally optional until the host explicitly enables WhatsApp.
  // Runtime resolution avoids changing OmniX Go's package.json or lockfile here.
  const require = createRequire(import.meta.url);
  const packageName = "whatsapp-web.js";
  let library: {
    Client: new (options: object) => WhatsAppClient;
    LocalAuth: new (options: { dataPath: string; clientId: string }) => object;
  };
  try {
    library = require(packageName) as typeof library;
  } catch {
    throw new Error("WhatsApp bridge dependency missing: install whatsapp-web.js in the OmniX Go package.");
  }

  // npm installations that block Puppeteer's postinstall can still use an
  // existing system Chrome browser without installing a second Chromium.
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = process.platform === "darwin" && existsSync(macChrome)
    ? macChrome : undefined;
  return new library.Client({
    authStrategy: new library.LocalAuth({ dataPath: authDirectory, clientId: "omnix-go" }),
    // Keep the browser sandbox enabled. Never add --no-sandbox.
    puppeteer: { headless: true, ...(executablePath ? { executablePath } : {}) },
  });
}

interface PendingSend extends WhatsAppDraft {
  recipientId: string;
}

const QR_LIFETIME_MS = 45_000;
const DRAFT_LIFETIME_MS = 120_000;

export function normalizeRecipient(recipient: string): { phone: string; chatId: string } {
  const phone = recipient.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error("Recipient must be one explicit E.164 number, e.g. +919876543210.");
  }
  return { phone, chatId: phone.slice(1) + "@c.us" };
}

function validateChatId(chatId: string): void {
  const individual = /^[1-9]\d{5,19}@(c\.us|lid)$/.test(chatId);
  // WhatsApp group IDs can contain the creation-time suffix after a hyphen.
  const group = /^\d{6,20}(?:-\d{6,20})?@g\.us$/.test(chatId);
  if (!individual && !group) {
    throw new Error("Use a specific chat ID returned by whatsapp_list_chats.");
  }
}

/**
 * Nothing connects, reads, writes to WhatsApp, or launches Chromium during
 * construction. All WhatsApp Web access begins with a local owner UI action.
 */
export class WhatsAppBridge {
  private phase: WhatsAppPhase = "idle";
  private client?: WhatsAppClient;
  private launching?: Promise<void>;
  private qr?: { value: string; createdAt: number };
  private readonly drafts = new Map<string, PendingSend>();
  private readonly clock: () => number;
  private readonly factory: WhatsAppClientFactory;

  constructor(
    private readonly authDirectory: string,
    options: { factory?: WhatsAppClientFactory; clock?: () => number } = {},
  ) {
    this.factory = options.factory ?? createWhatsAppWebClient;
    this.clock = options.clock ?? Date.now;
  }

  status(): { phase: WhatsAppPhase; qrAvailable: boolean; pendingApprovals: number } {
    this.prune();
    return {
      phase: this.phase,
      qrAvailable: this.getQrText() !== undefined,
      pendingApprovals: this.drafts.size,
    };
  }

  /** Never expose this value in MCP tools, logs, or remote HTTP responses. */
  getQrText(): string | undefined {
    return this.qr && this.clock() - this.qr.createdAt < QR_LIFETIME_MS
      ? this.qr.value
      : undefined;
  }

  private async ensureLocalDirectory(): Promise<void> {
    const directory = path.resolve(this.authDirectory);
    const parent = path.dirname(directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
      throw new Error("WhatsApp auth path must be a private, real directory.");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  async start(): Promise<ReturnType<WhatsAppBridge["status"]>> {
    if (this.launching) {
      await this.launching;
      return this.status();
    }
    if (this.client) return this.status();
    this.phase = "starting";
    this.launching = this.launch().finally(() => { this.launching = undefined; });
    await this.launching;
    return this.status();
  }

  private async launch(): Promise<void> {
    try {
      await this.ensureLocalDirectory();
      const client = await this.factory(this.authDirectory);
      this.client = client;
      client.on("qr", (...args) => {
        if (this.client !== client || typeof args[0] !== "string") return;
        this.phase = "qr";
        this.qr = { value: args[0], createdAt: this.clock() };
      });
      client.on("authenticated", () => {
        if (this.client !== client) return;
        this.qr = undefined;
        this.phase = "starting";
      });
      client.on("ready", () => {
        if (this.client !== client) return;
        this.qr = undefined;
        this.phase = "ready";
      });
      client.on("auth_failure", () => {
        if (this.client !== client) return;
        this.qr = undefined;
        this.phase = "error";
      });
      client.on("disconnected", () => {
        if (this.client !== client) return;
        this.qr = undefined;
        this.phase = "disconnected";
      });
      // Do not subscribe to "message", "message_create" or sync/history events.
      void Promise.resolve().then(() => client.initialize()).catch(() => {
        if (this.client !== client) return;
        this.qr = undefined;
        this.phase = "error";
      });
    } catch {
      this.phase = "error";
      this.client = undefined;
      this.qr = undefined;
      throw new Error("WhatsApp bridge could not start. Check optional dependencies and the local browser runtime.");
    }
  }

  async stop(): Promise<void> {
    if (this.launching) await this.launching.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    this.qr = undefined;
    this.drafts.clear();
    this.phase = "idle";
    if (client) await client.destroy();
    // LocalAuth credentials are intentionally preserved; revocation is done
    // in WhatsApp > Linked devices on the owner's phone.
  }

  private readyClient(): WhatsAppClient {
    if (this.phase !== "ready" || !this.client) {
      throw new Error("WhatsApp is not linked and ready. Open the local setup page and scan the QR code.");
    }
    return this.client;
  }

  async listChats(limit = 20): Promise<WhatsAppChat[]> {
    const client = this.readyClient();
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new Error("Chat limit must be between 1 and 30.");
    }
    // No message bodies, history or previews are included in a chat listing.
    return (await client.getChats()).slice(0, limit).map((chat) => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
    }));
  }

  async readMessages(chatId: string, limit = 10): Promise<WhatsAppMessage[]> {
    const client = this.readyClient();
    validateChatId(chatId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new Error("Message limit must be between 1 and 30.");
    }
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    return messages.map((message) => ({
      id: message.id?._serialized ?? "",
      from: message.from ?? "",
      fromMe: message.fromMe === true,
      body: message.body ?? "",
      timestamp: message.timestamp ?? 0,
    }));
  }

  prepareSend(recipient: string, content: string): { id: string; expiresAt: number; recipient: string } {
    this.readyClient();
    const target = normalizeRecipient(recipient);
    if (typeof content !== "string" || !content.trim() || content.length > 4000) {
      throw new Error("Message must contain 1–4000 non-blank characters.");
    }
    this.prune();
    if (this.drafts.size >= 10) throw new Error("Too many pending approvals.");
    const id = randomUUID();
    const expiresAt = this.clock() + DRAFT_LIFETIME_MS;
    this.drafts.set(id, { id, recipient: target.phone, recipientId: target.chatId, content, expiresAt, approved: false });
    return { id, expiresAt, recipient: target.phone };
  }

  /** For the loopback, dashboard-authenticated UI only; never register as MCP. */
  pendingDrafts(): WhatsAppDraft[] {
    this.prune();
    return [...this.drafts.values()].map(({ id, recipient, content, expiresAt, approved }) => ({
      id, recipient, content, expiresAt, approved,
    }));
  }

  /** Exact draft content is displayed to the owner before this action. */
  approveSend(id: string): void {
    this.readyClient();
    this.prune();
    const draft = this.drafts.get(id);
    if (!draft) throw new Error("Approval request expired or not found.");
    if (draft.approved) throw new Error("This request was already approved.");
    draft.approved = true;
  }

  /** One-shot; never sends without owner approval for this exact immutable draft. */
  async sendApproved(id: string): Promise<{ sent: true; recipient: string; messageId: string }> {
    const client = this.readyClient();
    this.prune();
    const draft = this.drafts.get(id);
    if (!draft || !draft.approved) {
      throw new Error("Explicit owner approval for this exact message is required.");
    }
    this.drafts.delete(id); // consume before any await; prevents duplicate sends
    const result = await client.sendMessage(draft.recipientId, draft.content);
    return { sent: true, recipient: draft.recipient, messageId: result.id?._serialized ?? "" };
  }

  private prune(): void {
    const now = this.clock();
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt <= now) this.drafts.delete(id);
    }
  }
}
