import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir } from "node:fs/promises";
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

async function browserExecutable(): Promise<string | undefined> {
  const configured = process.env.OMNIX_GO_WHATSAPP_CHROME || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured) return configured;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "linux"
      ? ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
      : [];
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

export async function createWhatsAppWebClient(authDirectory: string): Promise<WhatsAppClient> {
  // Load the browser runtime only when the owner starts pairing.
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

  const executablePath = await browserExecutable();
  return new library.Client({
    authStrategy: new library.LocalAuth({ dataPath: authDirectory, clientId: "omnix-go" }),
    webVersionCache: { type: "local", path: path.join(authDirectory, "web-cache") },
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
  private initializing?: Promise<void>;
  private closing?: Promise<void>;
  private qr?: { value: string; createdAt: number };
  private setupError?: string;
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

  localStatus(): ReturnType<WhatsAppBridge["status"]> & { qrUpdatedAt?: number; setupError?: string } {
    const status = this.status();
    return {
      ...status,
      ...(status.qrAvailable ? { qrUpdatedAt: this.qr?.createdAt } : {}),
      ...(this.setupError ? { setupError: this.setupError } : {}),
    };
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
    if (this.closing) await this.closing;
    if (this.launching) {
      await this.launching;
      return this.status();
    }
    if (this.client) return this.status();
    this.setupError = undefined;
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
        this.finishClient(client, "error", "WhatsApp rejected the saved session. Retry linking and check Linked devices on your phone.");
      });
      client.on("disconnected", () => {
        this.finishClient(client, "disconnected");
      });
      // Do not subscribe to "message", "message_create" or sync/history events.
      const initializing = Promise.resolve().then(() => this.client === client ? client.initialize() : undefined);
      this.initializing = initializing;
      void initializing.finally(() => {
        if (this.initializing === initializing) this.initializing = undefined;
      }).catch((error: unknown) => {
        const detail = String(error);
        const hint = /sandbox|running as root/i.test(detail)
          ? "Chromium could not start with its sandbox. Run OmniX Go as an unprivileged user and use a sandbox-capable Chrome or Chromium installation."
          : /could not find chrome|browser was not found|executablePath|spawn .*ENOENT/i.test(detail)
            ? "Chrome or Chromium was not found. Install it on the host or set OMNIX_GO_WHATSAPP_CHROME to its executable path."
            : "WhatsApp Web did not start. Check that Chrome can launch and that this host can reach web.whatsapp.com, then retry.";
        this.finishClient(client, "error", hint);
      });
    } catch {
      this.phase = "error";
      this.client = undefined;
      this.qr = undefined;
      this.setupError = "WhatsApp setup could not start. Check the local browser runtime and permissions on the OmniX Go state directory.";
      throw new Error(this.setupError);
    }
  }

  private finishClient(client: WhatsAppClient, phase: "error" | "disconnected", error?: string): void {
    if (this.client !== client) return;
    this.phase = phase;
    this.setupError = error;
    this.closeClient(client);
  }

  private closeClient(client: WhatsAppClient): Promise<void> {
    this.client = undefined;
    this.qr = undefined;
    this.drafts.clear();
    const initializing = this.initializing;
    const destroy = () => Promise.resolve().then(() => client.destroy());
    this.closing = (async () => {
      await destroy().catch(() => undefined);
      if (initializing) {
        // Chromium may finish launching after the first destroy call.
        await initializing.catch(() => undefined);
        await destroy().catch(() => undefined);
      }
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  async stop(): Promise<void> {
    if (this.launching) await this.launching.catch(() => undefined);
    const client = this.client;
    this.phase = "idle";
    this.setupError = undefined;
    if (client) await this.closeClient(client);
    else if (this.closing) await this.closing;
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
