import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  WhatsAppBridge,
  normalizeRecipient,
  type WhatsAppClient,
} from "../src/whatsapp-bridge.js";
import { isPrivateWhatsAppRequest, mountWhatsAppRoutes } from "../src/whatsapp-ui.js";
import { registerWhatsAppTools } from "../src/whatsapp-mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

class FakeClient implements WhatsAppClient {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  initialized = 0;
  destroyed = 0;
  reads = 0;
  listings = 0;
  sent: Array<{ id: string; content: string }> = [];

  on(event: string, listener: (...args: unknown[]) => void): void {
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(listener);
    this.listeners.set(event, callbacks);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  async initialize(): Promise<void> { this.initialized++; }
  async destroy(): Promise<void> { this.destroyed++; }

  async getChats() {
    this.listings++;
    return [{ id: { _serialized: "919876543210@c.us" }, name: "Test Person", isGroup: false }];
  }

  async getChatById(id: string) {
    expect(["919876543210@c.us", "1203630123456-1706000000@g.us"]).toContain(id);
    return {
      fetchMessages: async ({ limit }: { limit: number }) => {
        this.reads++;
        expect(limit).toBeLessThanOrEqual(30);
        return [{ id: { _serialized: "mock-message" }, from: id, fromMe: false, body: "mock text only", timestamp: 100 }];
      },
    };
  }

  async sendMessage(id: string, content: string) {
    this.sent.push({ id, content });
    return { id: { _serialized: "fake-sent-id" } };
  }
}

const temporary: string[] = [];
const servers: Server[] = [];

async function setup(clock?: () => number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnix-wa-mock-"));
  temporary.push(directory);
  const fake = new FakeClient();
  const bridge = new WhatsAppBridge(path.join(directory, "session"), {
    factory: async () => fake,
    ...(clock ? { clock } : {}),
  });
  return { bridge, fake };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("WhatsAppBridge opt-in and privacy", () => {
  it("registers five guarded MCP tools without pairing or approval actions", async () => {
    const { bridge } = await setup();
    const names: string[] = [];
    const mockServer = {
      registerTool(name: string) { names.push(name); },
    } as unknown as McpServer;
    registerWhatsAppTools(mockServer, bridge);
    expect(names).toEqual([
      "whatsapp_status",
      "whatsapp_list_chats",
      "whatsapp_read_messages",
      "whatsapp_prepare_send",
      "whatsapp_send_approved",
    ]);
    expect(bridge.status().phase).toBe("idle");
  });
  it("does not connect or read messages by construction; QR is absent from status", async () => {
    const { bridge, fake } = await setup();
    expect(bridge.status()).toEqual({ phase: "idle", qrAvailable: false, pendingApprovals: 0 });
    expect(fake.initialized).toBe(0);
    expect(fake.reads).toBe(0);
    expect(fake.listings).toBe(0);
    await expect(bridge.listChats()).rejects.toThrow("not linked");
    await bridge.start();
    await Promise.resolve();
    expect(fake.initialized).toBe(1);
    fake.emit("qr", "secret-mock-qr-not-for-remote-mcp");
    expect(bridge.status()).toMatchObject({ phase: "qr", qrAvailable: true });
    expect(JSON.stringify(bridge.status())).not.toContain("secret-mock");
    fake.emit("ready");
    expect(bridge.status()).toMatchObject({ phase: "ready", qrAvailable: false });
    expect(bridge.getQrText()).toBeUndefined();
    expect(fake.reads).toBe(0);
    await bridge.stop();
    expect(fake.destroyed).toBe(1);
  });

  it("cleans up a failed browser launch and allows a fresh QR attempt", async () => {
    const { bridge, fake } = await setup();
    const initialize = fake.initialize.bind(fake);
    fake.initialize = async () => { throw new Error("Could not find Chrome: private-path"); };
    await bridge.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bridge.localStatus()).toMatchObject({ phase: "error", setupError: expect.stringContaining("Chrome or Chromium was not found") });
    expect(JSON.stringify(bridge.localStatus())).not.toContain("private-path");
    expect(bridge.status()).not.toHaveProperty("setupError");
    expect(fake.destroyed).toBe(1);
    fake.initialize = initialize;
    await bridge.start();
    fake.emit("qr", "mock-qr-after-retry");
    expect(bridge.localStatus()).toMatchObject({ phase: "qr", qrAvailable: true });
    expect(bridge.localStatus()).not.toHaveProperty("setupError");
    await bridge.stop();
  });

  it("lists metadata and reads only one explicit chat on demand", async () => {
    const { bridge, fake } = await setup();
    await bridge.start();
    fake.emit("ready");
    expect(fake.listings).toBe(0);
    expect(fake.reads).toBe(0);
    await expect(bridge.readMessages("not-a-chat")).rejects.toThrow("specific chat");
    expect(await bridge.listChats(1)).toEqual([
      { id: "919876543210@c.us", name: "Test Person", isGroup: false },
    ]);
    expect(fake.reads).toBe(0);
    const results = await bridge.readMessages("919876543210@c.us", 5);
    expect(results[0]?.body).toBe("mock text only");
    expect(fake.reads).toBe(1);
    await bridge.readMessages("1203630123456-1706000000@g.us", 1);
    expect(fake.reads).toBe(2);
    await expect(bridge.readMessages("919876543210@c.us", 31)).rejects.toThrow("between 1 and 30");
    await bridge.stop();
  });

  it("requires exact recipient, content and separate local approval before any send", async () => {
    const { bridge, fake } = await setup();
    await bridge.start();
    fake.emit("ready");
    expect(() => normalizeRecipient("919876543210")).toThrow("E.164");
    expect(() => bridge.prepareSend("+919876543210", " ")).toThrow("non-blank");
    const draft = bridge.prepareSend("+919876543210", "Hello (mock only)");
    expect(fake.sent).toEqual([]);
    expect(bridge.pendingDrafts()[0]).toMatchObject({
      recipient: "+919876543210", content: "Hello (mock only)", approved: false,
    });
    await expect(bridge.sendApproved(draft.id)).rejects.toThrow("owner approval");
    expect(fake.sent).toEqual([]);
    bridge.approveSend(draft.id);
    expect(bridge.pendingDrafts()[0]?.approved).toBe(true);
    expect(await bridge.sendApproved(draft.id)).toMatchObject({ sent: true, recipient: "+919876543210" });
    expect(fake.sent).toEqual([{ id: "919876543210@c.us", content: "Hello (mock only)" }]);
    await expect(bridge.sendApproved(draft.id)).rejects.toThrow("owner approval");
    expect(fake.sent).toHaveLength(1);
    await bridge.stop();
  });

  it("expires approvals and clears pending drafts on stop", async () => {
    let now = 1_000;
    const { bridge, fake } = await setup(() => now);
    await bridge.start();
    fake.emit("qr", "mock-qr");
    now += 46_000;
    expect(bridge.getQrText()).toBeUndefined();
    fake.emit("ready");
    const draft = bridge.prepareSend("+919876543210", "expires");
    bridge.approveSend(draft.id);
    now += 121_000;
    await expect(bridge.sendApproved(draft.id)).rejects.toThrow("owner approval");
    expect(fake.sent).toEqual([]);
    const newer = bridge.prepareSend("+919876543210", "stop");
    await bridge.stop();
    expect(bridge.pendingDrafts()).toEqual([]);
    await expect(bridge.sendApproved(newer.id)).rejects.toThrow("not linked");
  });
});

describe("WhatsApp local-only page", () => {
  it("rejects public tunnel Host and forwarded requests even over loopback", () => {
    const req = (address: string, host: string, forwarded?: string) => ({
      socket: { remoteAddress: address },
      headers: { host, ...(forwarded ? { "x-forwarded-host": forwarded } : {}) },
    });
    expect(isPrivateWhatsAppRequest(req("127.0.0.1", "127.0.0.1:8111") as never, 8111)).toBe(true);
    expect(isPrivateWhatsAppRequest(req("127.0.0.1", "gateway.omnix.work") as never, 8111)).toBe(false);
    expect(isPrivateWhatsAppRequest(req("127.0.0.1", "127.0.0.1:8111", "gateway.omnix.work") as never, 8111)).toBe(false);
    expect(isPrivateWhatsAppRequest(req("10.0.0.5", "127.0.0.1:8111") as never, 8111)).toBe(false);
  });

  it("serves status only locally, rejects QR without a linking session, and enforces POST origin", async () => {
    const { bridge, fake } = await setup();
    const app = express();
    app.use(express.json());
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const pass: express.RequestHandler = (_req, _res, next) => next();
    mountWhatsAppRoutes(app, bridge, { port, dashboardAuth: pass, dashboardMutation: pass });
    const base = "http://127.0.0.1:" + port;
    const status = await fetch(base + "/api/whatsapp/status");
    expect(status.status).toBe(200);
    expect((await status.json()).phase).toBe("idle");
    expect((await fetch(base + "/api/whatsapp/qr")).status).toBe(404);
    const tunnelStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(base + "/api/whatsapp/status", { headers: { host: "gateway.omnix.work" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(tunnelStatus).toBe(403);
    const withoutOrigin = await fetch(base + "/api/whatsapp/start", { method: "POST", headers: { "x-omnix-action": "1" } });
    expect(withoutOrigin.status).toBe(403);
    expect(fake.initialized).toBe(0);
    const localStart = await fetch(base + "/api/whatsapp/start", {
      method: "POST", headers: { origin: base, "x-omnix-action": "1" },
    });
    expect(localStart.status).toBe(200);
    await Promise.resolve();
    expect(fake.initialized).toBe(1);
    fake.emit("qr", "mock-qr-for-rendering");
    const svg = await fetch(base + "/api/whatsapp/qr");
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain("<svg");
    fake.emit("ready");
    expect((await fetch(base + "/api/whatsapp/qr")).status).toBe(404);
    await bridge.stop();
  });
});
