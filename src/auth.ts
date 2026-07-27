import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import express from "express";
import { importJWK, jwtVerify, SignJWT } from "jose";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AppConfig } from "./types.js";
import type { ActivityStore } from "./events.js";
import { randomToken, sha256 } from "./utils.js";

export const ALL_SCOPES = [
  "files:read",
  "files:write",
  "commands:run",
  "computer:control",
  "skills:read",
  "skills:write",
  "mcp:connect",
  "agents:run",
] as const;

interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

interface RefreshGrant {
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function validChatGptRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      (url.protocol === "https:" &&
        url.hostname === "chatgpt.com" &&
        (url.pathname.startsWith("/connector/oauth/") ||
          url.pathname === "/connector_platform_oauth_redirect")) ||
      ((url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        (url.protocol === "http:" || url.protocol === "https:"))
    );
  } catch {
    return false;
  }
}

export class LocalOAuth implements OAuthTokenVerifier {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly refreshTokens = new Map<string, RefreshGrant>();
  private readonly revokedJtis = new Set<string>();
  private readonly privateKey: ReturnType<typeof importJWK>;
  private readonly publicKey: ReturnType<typeof importJWK>;
  private readonly statePath: string;
  private readonly configPath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly events: ActivityStore,
  ) {
    this.privateKey = importJWK(config.jwtPrivateJwk, "EdDSA");
    this.publicKey = importJWK(config.jwtPublicJwk, "EdDSA");
    this.statePath = path.join(config.dataDir, "oauth-state.json");
    this.configPath = path.join(config.dataDir, "config.json");
  }

  async initialize(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as {
        clients?: OAuthClient[];
        refreshTokens?: Array<[string, RefreshGrant]>;
        revokedJtis?: string[];
      };
      for (const client of state.clients ?? []) {
        this.clients.set(client.client_id, client);
      }
      for (const [token, grant] of state.refreshTokens ?? []) {
        if (grant.expiresAt > Date.now()) this.refreshTokens.set(token, grant);
      }
      for (const jti of state.revokedJtis ?? []) this.revokedJtis.add(jti);
      this.events.publish(
        "security",
        "OAuth state restored",
        "success",
        `${this.clients.size} clients, ${this.refreshTokens.size} refresh grants`,
      );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        this.events.publish("security", "OAuth state restore failed", "warning", String(error));
      }
    }
  }

  private async persistState(): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    const state = {
      clients: [...this.clients.values()],
      refreshTokens: [...this.refreshTokens.entries()].filter(
        ([, grant]) => grant.expiresAt > Date.now(),
      ),
      revokedJtis: [...this.revokedJtis].slice(-5_000),
    };
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.statePath);
    await chmod(this.statePath, 0o600);
  }

  canonicalBase(req?: Request): string {
    if (this.config.publicUrl) return this.config.publicUrl.replace(/\/+$/, "");
    if (req) {
      const forwarded = req.header("x-forwarded-host");
      const protocol = req.header("x-forwarded-proto") ?? req.protocol;
      if (forwarded) return `${protocol}://${forwarded}`;
    }
    return `http://${this.config.host}:${this.config.port}`;
  }

  resourceUrl(req?: Request): string {
    return `${this.canonicalBase(req)}/mcp`;
  }

  metadataUrl(req?: Request): string {
    return `${this.canonicalBase(req)}/.well-known/oauth-protected-resource/mcp`;
  }

  private clientAllowed(clientId: string, redirectUri: string): boolean {
    const client = this.clients.get(clientId);
    if (client) return client.redirect_uris.includes(redirectUri);
    return (
      clientId.startsWith("https://chatgpt.com/") &&
      validChatGptRedirect(redirectUri)
    );
  }

  private normalizeScopes(value: unknown): string[] {
    const requested =
      typeof value === "string" && value.trim()
        ? value.trim().split(/\s+/)
        : [...ALL_SCOPES];
    return requested.filter((scope) => (ALL_SCOPES as readonly string[]).includes(scope));
  }

  private async currentPairingSecretHash(): Promise<string> {
    try {
      const stored = JSON.parse(await readFile(this.configPath, "utf8")) as {
        pairingSecretHash?: unknown;
      };
      if (
        typeof stored.pairingSecretHash === "string" &&
        stored.pairingSecretHash.length > 0
      ) {
        this.config.pairingSecretHash = stored.pairingSecretHash;
      }
    } catch (error) {
      this.events.publish(
        "security",
        "Pairing credential reload failed",
        "warning",
        String(error),
      );
    }
    return this.config.pairingSecretHash;
  }

  router(): Router {
    const router = express.Router();
    router.use(express.urlencoded({ extended: false }));

    const protectedMetadata = (req: Request, res: Response) => {
      res.json({
        resource: this.resourceUrl(req),
        authorization_servers: [this.canonicalBase(req)],
        scopes_supported: ALL_SCOPES,
        bearer_methods_supported: ["header"],
        resource_documentation: `${this.canonicalBase(req)}/docs`,
      });
    };
    router.get("/.well-known/oauth-protected-resource", protectedMetadata);
    router.get("/.well-known/oauth-protected-resource/mcp", protectedMetadata);
    router.get("/.well-known/oauth-protected-resource/sse", protectedMetadata);

    router.get("/.well-known/oauth-authorization-server", (req, res) => {
      const base = this.canonicalBase(req);
      res.json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        jwks_uri: `${base}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ALL_SCOPES,
        client_id_metadata_document_supported: true,
      });
    });

    router.get("/.well-known/jwks.json", (_req, res) => {
      res.json({
        keys: [
          {
            ...this.config.jwtPublicJwk,
            use: "sig",
            alg: "EdDSA",
            kid: "chatgpt-code-local",
          },
        ],
      });
    });

    router.post("/oauth/register", express.json(), async (req, res) => {
      const redirectUris = Array.isArray(req.body?.redirect_uris)
        ? req.body.redirect_uris.filter((value: unknown): value is string => typeof value === "string")
        : [];
      if (redirectUris.length === 0 || !redirectUris.every(validChatGptRedirect)) {
        res.status(400).json({ error: "invalid_redirect_uri" });
        return;
      }
      const clientId = randomUUID();
      const client: OAuthClient = {
        client_id: clientId,
        redirect_uris: redirectUris,
        ...(typeof req.body?.client_name === "string"
          ? { client_name: req.body.client_name }
          : {}),
      };
      this.clients.set(clientId, client);
      await this.persistState();
      this.events.publish("security", "OAuth client registered", "success", clientId);
      res.status(201).json({
        ...client,
        token_endpoint_auth_method: "none",
      });
    });

    router.get("/oauth/authorize", (req, res) => {
      const clientId = String(req.query.client_id ?? "");
      const redirectUri = String(req.query.redirect_uri ?? "");
      const challenge = String(req.query.code_challenge ?? "");
      const challengeMethod = String(req.query.code_challenge_method ?? "");
      const resource = String(req.query.resource ?? this.resourceUrl(req));
      if (
        req.query.response_type !== "code" ||
        !clientId ||
        !redirectUri ||
        !challenge ||
        challengeMethod !== "S256" ||
        resource !== this.resourceUrl(req) ||
        !this.clientAllowed(clientId, redirectUri)
      ) {
        res.status(400).send("Invalid OAuth authorization request.");
        return;
      }
      const fields = [
        "client_id",
        "redirect_uri",
        "code_challenge",
        "code_challenge_method",
        "resource",
        "scope",
        "state",
      ]
        .map((name) => {
          const value = req.query[name];
          return `<input type="hidden" name="${name}" value="${htmlEscape(String(value ?? ""))}">`;
        })
        .join("");
      res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pair ChatGPT Code</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d0c;color:#e9eadf;font:16px ui-monospace,SFMono-Regular,Menlo,monospace}
main{width:min(520px,calc(100vw - 48px));border:1px solid #3e443c;background:#151914;padding:32px;box-shadow:12px 12px 0 #070807}
h1{margin:0 0 12px;font-size:28px;color:#d8ff5f}p{line-height:1.55;color:#afb6a8}
label{display:block;margin:24px 0 8px;color:#f2a65a}input[type=text]{box-sizing:border-box;width:100%;padding:14px;background:#090b09;border:1px solid #596253;color:white;font:inherit;text-transform:uppercase}
button{margin-top:16px;width:100%;padding:14px;background:#d8ff5f;color:#111;border:0;font:700 15px inherit;cursor:pointer}
small{display:block;margin-top:20px;color:#7b8474}
</style></head><body><main><h1>CHATGPT CODE / PAIR</h1>
<p>Enter the one-time pairing code printed by <code>chatgpt-code</code> in your terminal. This grants this ChatGPT connection access to the selected local tools.</p>
<form method="post" action="/oauth/authorize">${fields}<label for="pairing_code">TERMINAL PAIRING CODE</label>
<input id="pairing_code" name="pairing_code" type="text" autocomplete="one-time-code" autofocus required>
<button type="submit">AUTHORIZE THIS CONNECTION</button></form>
<small>Tokens are signed locally, expire after 15 minutes, and are restricted to this MCP resource.</small>
</main></body></html>`);
    });

    router.post("/oauth/authorize", async (req, res) => {
      const pairingCode = String(req.body.pairing_code ?? "").trim().toUpperCase();
      const provided = Buffer.from(sha256(pairingCode));
      const expected = Buffer.from(await this.currentPairingSecretHash());
      const isValid =
        provided.length === expected.length && timingSafeEqual(provided, expected);
      const clientId = String(req.body.client_id ?? "");
      const redirectUri = String(req.body.redirect_uri ?? "");
      const requestedResource = String(req.body.resource || this.resourceUrl(req));
      if (
        !isValid ||
        requestedResource !== this.resourceUrl(req) ||
        !this.clientAllowed(clientId, redirectUri)
      ) {
        this.events.publish("security", "Pairing attempt rejected", "warning");
        res.status(403).send("Pairing code rejected.");
        return;
      }

      const code = randomToken();
      this.codes.set(code, {
        clientId,
        redirectUri,
        challenge: String(req.body.code_challenge ?? ""),
        resource: requestedResource,
        scopes: this.normalizeScopes(req.body.scope),
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      if (req.body.state) location.searchParams.set("state", String(req.body.state));
      this.events.publish("security", "ChatGPT connection authorized", "success", clientId);
      res.redirect(location.toString());
    });

    router.post("/oauth/token", async (req, res) => {
      try {
        const grantType = String(req.body.grant_type ?? "");
        if (grantType === "authorization_code") {
          const codeValue = String(req.body.code ?? "");
          const pending = this.codes.get(codeValue);
          this.codes.delete(codeValue);
          if (
            !pending ||
            pending.expiresAt < Date.now() ||
            pending.clientId !== String(req.body.client_id ?? "") ||
            pending.redirectUri !== String(req.body.redirect_uri ?? "") ||
            sha256(String(req.body.code_verifier ?? "")) !== pending.challenge
          ) {
            res.status(400).json({ error: "invalid_grant" });
            return;
          }
          const refreshToken = randomToken(48);
          this.refreshTokens.set(refreshToken, {
            clientId: pending.clientId,
            resource: pending.resource,
            scopes: pending.scopes,
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          });
          await this.persistState();
          res.json({
            access_token: await this.signAccessToken(pending),
            token_type: "Bearer",
            expires_in: 900,
            refresh_token: refreshToken,
            scope: pending.scopes.join(" "),
          });
          return;
        }
        if (grantType === "refresh_token") {
          const refreshToken = String(req.body.refresh_token ?? "");
          const grant = this.refreshTokens.get(refreshToken);
          if (
            !grant ||
            grant.expiresAt < Date.now() ||
            grant.clientId !== String(req.body.client_id ?? "")
          ) {
            res.status(400).json({ error: "invalid_grant" });
            return;
          }
          const requestedScopes = this.normalizeScopes(req.body.scope);
          const scopes = req.body.scope
            ? requestedScopes.filter((scope) => grant.scopes.includes(scope))
            : grant.scopes;
          res.json({
            access_token: await this.signAccessToken({ ...grant, scopes }),
            token_type: "Bearer",
            expires_in: 900,
            scope: scopes.join(" "),
          });
          return;
        }
        res.status(400).json({ error: "unsupported_grant_type" });
      } catch (error) {
        this.events.publish("security", "Token exchange failed", "error", String(error));
        res.status(400).json({ error: "invalid_request" });
      }
    });

    router.post("/oauth/revoke", async (req, res) => {
      const token = String(req.body.token ?? "");
      if (this.refreshTokens.delete(token)) {
        await this.persistState();
        res.status(200).end();
        return;
      }
      await this.markJwtRevoked(token);
      res.status(200).end();
    });

    return router;
  }

  private async signAccessToken(grant: {
    clientId: string;
    resource: string;
    scopes: string[];
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: grant.scopes.join(" "), client_id: grant.clientId })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: "chatgpt-code-local",
        typ: "JWT",
      })
      .setIssuer(this.canonicalBase())
      .setSubject("local-computer-user")
      .setAudience(grant.resource)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .setJti(randomUUID())
      .sign(await this.privateKey);
  }

  private async markJwtRevoked(token: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(token, await this.publicKey, {
        algorithms: ["EdDSA"],
      });
      if (payload.jti) this.revokedJtis.add(payload.jti);
      await this.persistState();
    } catch {
      // OAuth revocation is intentionally idempotent.
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const resource = this.resourceUrl();
    const { payload } = await jwtVerify(token, await this.publicKey, {
      algorithms: ["EdDSA"],
      issuer: this.canonicalBase(),
      audience: resource,
    });
    if (!payload.jti || this.revokedJtis.has(payload.jti)) {
      throw new Error("Token has been revoked");
    }
    const scopes =
      typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
    return {
      token,
      clientId: String(payload.client_id ?? "unknown"),
      scopes,
      expiresAt: payload.exp,
      resource: new URL(resource),
      extra: { subject: payload.sub ?? "local-computer-user" },
    };
  }
}
