import { createServer, type Server as HttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpRuntime } from "./mcp.js";
import type { AppConfig } from "./types.js";
import type { ActivityStore } from "./events.js";
import type { LocalOAuth } from "./auth.js";

function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return [];
      return [
        [
          decodeURIComponent(part.slice(0, separator).trim()),
          decodeURIComponent(part.slice(separator + 1).trim()),
        ],
      ];
    }),
  );
}

export async function startHttpServer(input: {
  config: AppConfig;
  runtime: McpRuntime;
  oauth: LocalOAuth;
  events: ActivityStore;
}): Promise<HttpServer> {
  const { config, runtime, oauth, events } = input;
  const app = express();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDirectory = path.resolve(moduleDir, "../public");
  app.disable("x-powered-by");
  app.set("trust proxy", ["loopback"]);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const rateLimit = (limit: number, windowMs: number) => (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const current = attempts.get(key);
    const record = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    record.count += 1;
    attempts.set(key, record);
    if (record.count > limit) {
      res.setHeader("Retry-After", String(Math.ceil((record.resetAt - now) / 1000)));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
  app.use(["/oauth", "/go/oauth", "/auth/callback"], rateLimit(30, 60_000));
  app.get(["/brand/pairing-mark.jpg", "/go/brand/pairing-mark.jpg"], async (_req, res) => {
    try {
      res.type("image/jpeg").send(await readFile(path.join(publicDirectory, "omnix-pairing-mark.jpg")));
    } catch {
      res.status(404).end();
    }
  });
  app.use(oauth.router());
  app.use("/go", oauth.router());

  app.get(["/health", "/go/health"], (_req, res) => {
    res.json({ status: "ok", name: "omnix-go", version: "0.3.6" });
  });
  app.get(["/docs", "/go/docs"], (_req, res) => {
    res.type("text").send(
      "OmniX Go is a private local MCP coding and computer-use harness. Prefer Streamable HTTP at /mcp. Legacy MCP clients may use /sse; the server advertises the matching /messages endpoint. Both transports require OAuth 2.1 authorization.",
    );
  });

  const authenticateMcp = async (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      events.publish(
        "security",
        "MCP request missing bearer token",
        "warning",
        String((req.body as { method?: unknown } | undefined)?.method ?? req.method),
      );
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${oauth.metadataUrl(req)}", scope="files:read"`,
        )
        .json({ error: "unauthorized" });
      return;
    }
    try {
      (req as Request & { auth?: Awaited<ReturnType<typeof oauth.verifyAccessToken>> }).auth =
        await oauth.verifyAccessToken(token);
      next();
    } catch (error) {
      events.publish("security", "Rejected MCP bearer token", "warning", String(error));
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${oauth.metadataUrl(req)}", error="invalid_token"`,
        )
        .json({ error: "invalid_token" });
    }
  };

  app.all(["/mcp", "/go/mcp"], rateLimit(240, 60_000), authenticateMcp, express.json({ limit: "4mb" }), async (req, res) => {
    if (req.method === "GET") {
      res.status(405).set("Allow", "POST, DELETE").end();
      return;
    }
    const server = runtime.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transport.onerror = (error) => {
      events.publish("system", "MCP transport error", "error", String(error));
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      events.publish(
        "mcp",
        `MCP ${String((req.body as { method?: unknown } | undefined)?.method ?? req.method)}`,
        res.statusCode < 400 ? "success" : "warning",
        `HTTP ${res.statusCode}`,
      );
    } catch (error) {
      events.publish("system", "MCP request failed", "error", String(error));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP error" },
          id: null,
        });
      }
    } finally {
      runtime.disposeServer(server);
      await server.close().catch(() => {});
    }
  });

  const sseSessions = new Map<
    string,
    {
      transport: SSEServerTransport;
      server: ReturnType<McpRuntime["createServer"]>;
      clientId: string;
    }
  >();

  app.get(["/sse", "/go/sse"], rateLimit(60, 60_000), authenticateMcp, async (req, res) => {
    const auth = (req as Request & { auth?: { clientId: string } }).auth;
    if (!auth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const server = runtime.createServer();
    const transport = new SSEServerTransport(req.path.startsWith("/go/") ? "/go/messages" : "/messages", res);
    const sessionId = transport.sessionId;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sseSessions.delete(sessionId);
      runtime.disposeServer(server);
      void server.close().catch(() => {});
    };
    transport.onclose = cleanup;
    transport.onerror = (error) => {
      events.publish("system", "Legacy SSE transport error", "error", String(error));
    };
    sseSessions.set(sessionId, { transport, server, clientId: auth.clientId });
    try {
      await server.connect(transport);
      events.publish("system", "Legacy SSE session connected", "success", sessionId);
    } catch (error) {
      cleanup();
      events.publish("system", "Legacy SSE connection failed", "error", String(error));
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.post(
    ["/messages", "/go/messages"],
    authenticateMcp,
    express.json({ limit: "4mb" }),
    async (req, res) => {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
      const session = sseSessions.get(sessionId);
      const auth = (req as Request & { auth?: { clientId: string } }).auth;
      if (!session || !auth || session.clientId !== auth.clientId) {
        res.status(404).json({ error: "unknown_sse_session" });
        return;
      }
      try {
        await session.transport.handlePostMessage(req, res, req.body);
      } catch (error) {
        events.publish("system", "Legacy SSE message failed", "error", String(error));
        if (!res.headersSent) res.status(500).json({ error: "sse_message_failed" });
      }
    },
  );

  const dashboardAuth = (req: Request, res: Response, next: NextFunction) => {
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    const cookieToken = parseCookies(req.header("cookie")).omnix_go_dashboard;
    if (queryToken === config.dashboardToken) {
      res.cookie("omnix_go_dashboard", config.dashboardToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: req.secure,
        maxAge: 24 * 60 * 60 * 1000,
        path: "/",
      });
      const clean = new URL(req.originalUrl, `http://${req.headers.host ?? "localhost"}`);
      clean.searchParams.delete("token");
      res.redirect(clean.pathname + clean.search);
      return;
    }
    if (cookieToken !== config.dashboardToken) {
      res.status(403).type("html").send(
        "<!doctype html><title>OmniX Go locked</title><body style='background:#0b0d0c;color:#ddd;font:16px monospace;padding:40px'><h1>Dashboard locked</h1><p>Open the private dashboard URL printed by <code>omnix-go</code>.</p></body>",
      );
      return;
    }
    next();
  };

  app.get("/api/state", dashboardAuth, (_req, res) => {
    res.json({
      service: {
        name: "OmniX Go",
        version: "0.3.6",
        publicUrl: config.publicUrl,
        roots: runtime.paths.roots,
      },
      events: events.snapshot(),
      terminals: runtime.terminal.list(),
      skills: runtime.skills.list(),
      agents: runtime.harness.list(),
      connections: runtime.upstreams.list(),
    });
  });

  app.get("/api/events", dashboardAuth, (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    for (const event of events.list(Number(req.query.after ?? 0))) {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const listener = (event: unknown) => {
      const activity = event as { id: number };
      res.write(`id: ${activity.id}\ndata: ${JSON.stringify(activity)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    events.emitter.on("event", listener);
    req.once("close", () => {
      clearInterval(heartbeat);
      events.emitter.off("event", listener);
    });
  });

  app.use("/", dashboardAuth, express.static(publicDirectory, { index: "index.html" }));

  const httpServer = createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  events.publish(
    "system",
    "Local service ready",
    "success",
    `http://${config.host}:${config.port}`,
  );
  return httpServer;
}
