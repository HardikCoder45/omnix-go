import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { mountWhatsAppRoutes } from "./whatsapp-ui.js";

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
    res.json({ status: "ok", name: "omnix-go", version: "0.4.0" });
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

  const dashboardSessions = new Map<string, { expiresAt: number; redirectTo?: "approvals" | "whatsapp" }>();
  const dashboardDirectory = path.join(publicDirectory, "dashboard");
  const secureEqual = (left?: string, right?: string): boolean => {
    if (!left || !right) return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const isLoopback = (req: Request): boolean => {
    const address = req.socket.remoteAddress ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  };
  const dashboardAuth = (req: Request, res: Response, next: NextFunction) => {
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    const cookieToken = parseCookies(req.header("cookie")).omnix_go_dashboard;
    const localHeader = isLoopback(req) ? req.header("x-omnix-dashboard-token") : undefined;
    if (secureEqual(queryToken, config.dashboardToken)) {
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
    if (!secureEqual(cookieToken, config.dashboardToken) && !secureEqual(localHeader, config.dashboardToken)) {
      res.status(403).type("html").send(
        "<!doctype html><meta name='viewport' content='width=device-width'><title>OmniX Go locked</title><body style='background:#090d12;color:#eaf4ff;font:16px ui-monospace,monospace;padding:48px'><p style='color:#24dfc2;letter-spacing:.12em'>OMNIX GO</p><h1>Dashboard locked</h1><p style='color:#8ea2b8'>Run <code style='color:#19b9ff'>omnix-go dashboard</code> on this computer to open a private session.</p></body>",
      );
      return;
    }
    next();
  };

  const dashboardMutation = (req: Request, res: Response, next: NextFunction) => {
    if (req.header("x-omnix-action") !== "1") {
      res.status(403).json({ error: "missing_action_header" });
      return;
    }
    const origin = req.header("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.get("host")) {
          res.status(403).json({ error: "cross_origin_request_rejected" });
          return;
        }
      } catch {
        res.status(403).json({ error: "invalid_origin" });
        return;
      }
    }
    next();
  };

  const asyncRoute = (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      events.publish("system", "Dashboard action failed", "error", String(error));
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  app.use(["/api", "/go/api"], express.json({ limit: "2mb" }));
  mountWhatsAppRoutes(app, runtime.whatsapp, { port: config.port, dashboardAuth, dashboardMutation });

  app.post(
    ["/api/dashboard/session", "/go/api/dashboard/session"],
    rateLimit(20, 60_000),
    (req, res) => {
      const token = req.header("x-omnix-dashboard-token");
      if (!isLoopback(req) || !secureEqual(token, config.dashboardToken)) {
        res.status(403).json({ error: "local_dashboard_auth_required" });
        return;
      }
      const code = randomBytes(32).toString("base64url");
      const redirectTo = req.body?.page === "approvals" || req.body?.page === "whatsapp" ? req.body.page as "approvals" | "whatsapp" : undefined;
      const local = req.body?.local === true;
      dashboardSessions.set(code, { expiresAt: Date.now() + 60_000, ...(redirectTo ? { redirectTo } : {}) });
      const base = local ? `http://127.0.0.1:${config.port}` : (config.publicUrl ?? `http://127.0.0.1:${config.port}`);
      res.json({ url: `${base}/dashboard/session?code=${encodeURIComponent(code)}` });
    },
  );

  app.get(["/dashboard/session", "/go/dashboard/session"], rateLimit(30, 60_000), (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const session = dashboardSessions.get(code);
    dashboardSessions.delete(code);
    if (!code || !session || session.expiresAt < Date.now()) {
      res.status(403).type("text").send("This OmniX Go dashboard link expired. Run `omnix-go dashboard` again.");
      return;
    }
    res.cookie("omnix_go_dashboard", config.dashboardToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    res.redirect(session.redirectTo ? `/dashboard/${session.redirectTo}` : (req.path.startsWith("/go/") ? "/go/dashboard" : "/dashboard"));
  });

  app.get(["/dashboard", "/dashboard/", "/go/dashboard", "/go/dashboard/"], dashboardAuth, (_req, res) => {
    res.sendFile(path.join(dashboardDirectory, "index.html"));
  });
  app.use(["/dashboard/assets", "/go/dashboard/assets"], dashboardAuth, express.static(dashboardDirectory, { index: false }));

  // Owner approvals must never be reachable via the public tunnel, even when
  // a remote request has a dashboard cookie. A tunnel terminates on loopback.
  const ownerLocalOnly: (req: Request, res: Response, next: NextFunction) => void =
    (req, res, next) => {
      const address = req.socket.remoteAddress ?? "";
      const host = String(req.headers.host ?? "").toLowerCase();
      const localHost = [`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`].includes(host);
      const forwarded = Object.keys(req.headers).some((key) => key.toLowerCase().startsWith("x-forwarded-"))
        || req.headers.forwarded !== undefined;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) || !localHost || forwarded) {
        res.status(403).json({ error: "local_owner_only" });
        return;
      }
      next();
    };
  app.get(["/dashboard/approvals", "/go/dashboard/approvals"], ownerLocalOnly, dashboardAuth, (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.sendFile(path.join(dashboardDirectory, "approvals.html"));
  });
  app.get(["/api/approvals", "/go/api/approvals"], ownerLocalOnly, dashboardAuth, (_req, res) => {
    res.json({ approvals: runtime.upstreams.listPendingApprovals(), codexAllAppsAccess: runtime.upstreams.getAllAppsAccess() });
  });
  app.post(["/api/approvals/app-access", "/go/api/approvals/app-access"],
    ownerLocalOnly, dashboardAuth, dashboardMutation, rateLimit(12, 60_000),
    asyncRoute(async (req, res) => {
      if (req.header("origin") !== `http://${req.headers.host}`) {
        res.status(403).json({ error: "local_origin_required" });
        return;
      }
      // The explicit confirmation value is intentionally required, so simply
      // loading the dashboard or receiving an MCP call cannot enable access.
      if (req.body?.enabled !== true && req.body?.enabled !== false) {
        res.status(400).json({ error: "enabled_must_be_boolean" });
        return;
      }
      if (req.body.enabled === true && req.body.confirm !== "ALLOW_ALL_APPS") {
        res.status(400).json({ error: "explicit_confirmation_required" });
        return;
      }
      await runtime.upstreams.setAllAppsAccess(req.body.enabled);
      res.json({ codexAllAppsAccess: runtime.upstreams.getAllAppsAccess() });
    }),
  );
  app.post(["/api/approvals/:id", "/go/api/approvals/:id"],
    ownerLocalOnly, dashboardAuth, dashboardMutation, rateLimit(40, 60_000),
    asyncRoute(async (req, res) => {
      const origin = req.header("origin");
      if (origin !== `http://${req.headers.host}`) {
        res.status(403).json({ error: "local_origin_required" });
        return;
      }
      if (req.body?.action !== "accept" && req.body?.action !== "decline") {
        res.status(400).json({ error: "action_must_be_accept_or_decline" });
        return;
      }
      runtime.upstreams.answerPendingApproval(
        String(req.params.id), req.body.action, req.body?.rememberSession === true,
      );
      res.json({ resolved: true });
    }),
  );

  app.get(["/api/state", "/go/api/state"], dashboardAuth, (_req, res) => {
    res.json({
      service: {
        name: "OmniX Go",
        version: "0.4.0",
        publicUrl: config.publicUrl,
        roots: runtime.paths.roots,
      },
      events: events.snapshot(),
      terminals: runtime.terminal.list(),
      skills: runtime.skills.list(),
      agents: runtime.harness.list(),
      connections: runtime.upstreams.list(),
      ...runtime.automations.snapshot(),
    });
  });

  app.get(["/api/events", "/go/api/events"], dashboardAuth, (req, res) => {
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

  app.post(["/api/custom-agents", "/go/api/custom-agents"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ agent: await runtime.automations.saveCustomAgent(req.body) });
  }));
  app.delete(["/api/custom-agents/:id", "/go/api/custom-agents/:id"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json(await runtime.automations.deleteCustomAgent(String(req.params.id)));
  }));
  app.post(["/api/custom-agents/:id/run", "/go/api/custom-agents/:id/run"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ agent: await runtime.automations.startCustomAgent(String(req.params.id), req.body?.prompt) });
  }));

  app.post(["/api/workflows", "/go/api/workflows"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ workflow: await runtime.automations.saveWorkflow(req.body) });
  }));
  app.delete(["/api/workflows/:id", "/go/api/workflows/:id"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json(await runtime.automations.deleteWorkflow(String(req.params.id)));
  }));
  app.post(["/api/workflows/:id/run", "/go/api/workflows/:id/run"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ run: runtime.automations.startWorkflow(String(req.params.id), req.body?.input ?? {}) });
  }));
  app.post(["/api/runs/:id/cancel", "/go/api/runs/:id/cancel"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ run: await runtime.automations.cancelRun(String(req.params.id)) });
  }));

  app.post(["/api/crons", "/go/api/crons"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ schedule: await runtime.automations.saveSchedule(req.body) });
  }));
  app.post(["/api/crons/:id/toggle", "/go/api/crons/:id/toggle"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ schedule: await runtime.automations.toggleSchedule(String(req.params.id), Boolean(req.body?.enabled)) });
  }));
  app.post(["/api/crons/:id/run", "/go/api/crons/:id/run"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ run: await runtime.automations.runScheduleNow(String(req.params.id)) });
  }));
  app.delete(["/api/crons/:id", "/go/api/crons/:id"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json(await runtime.automations.deleteSchedule(String(req.params.id)));
  }));

  app.post(["/api/agents/:id/refresh", "/go/api/agents/:id/refresh"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ agent: await runtime.harness.refresh(String(req.params.id)) });
  }));
  app.post(["/api/agents/:id/follow-up", "/go/api/agents/:id/follow-up"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ agent: await runtime.harness.followUp(String(req.params.id), String(req.body?.prompt ?? "")) });
  }));
  app.post(["/api/agents/:id/cancel", "/go/api/agents/:id/cancel"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json(await runtime.harness.cancel(String(req.params.id)));
  }));

  app.post(["/api/skills/refresh", "/go/api/skills/refresh"], dashboardAuth, dashboardMutation, asyncRoute(async (_req, res) => {
    res.json({ skills: await runtime.skills.refresh() });
  }));
  app.post(["/api/connections", "/go/api/connections"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json({ connection: await runtime.upstreams.connect(req.body) });
  }));
  app.delete(["/api/connections/:id", "/go/api/connections/:id"], dashboardAuth, dashboardMutation, asyncRoute(async (req, res) => {
    res.json(await runtime.upstreams.disconnect(String(req.params.id)));
  }));

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
