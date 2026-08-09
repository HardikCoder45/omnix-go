import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { createDesktopAuthorization, exchangeDesktopCode } from "./gateway.js";

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

interface PendingIdentityAuthorization {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scopes: string[];
  clientState?: string;
  brokerVerifier: string;
  expiresAt: number;
  identityVerifiedAt?: number;
  pairingAttempts: number;
}

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// A refresh grant is renewed whenever ChatGPT uses it. This survives normal
// service restarts and avoids periodic reconnects while retaining revocation.
const REFRESH_GRANT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export function normalizePairingCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function createPairingCode(): string {
  const bytes = randomBytes(8);
  const compact = [...bytes].map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join("");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function pairingCodeHash(code: string): string {
  return sha256(normalizePairingCode(code));
}

function pairingCodeMatches(expectedHash: string | undefined, submitted: string): boolean {
  if (!expectedHash) return false;
  const actual = pairingCodeHash(submitted);
  const expectedBytes = Buffer.from(expectedHash);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function pairingPage(action: string, state: string, error = ""): string {
  const escapedError = error.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm this computer · OmniX Go</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@500;600;700;800&display=swap');
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#071641;color:#f5f7ff;font-family:Manrope,ui-sans-serif,sans-serif;overflow:hidden}
  body:before,body:after{content:"";position:fixed;width:43vmax;height:43vmax;border-radius:50%;filter:blur(8px);pointer-events:none}body:before{background:#193ca4;left:-17vmax;top:-20vmax;opacity:.66}body:after{background:#00daca;right:-21vmax;bottom:-25vmax;opacity:.43}
  main{width:min(93vw,480px);position:relative;padding:42px 36px 34px;border:1px solid rgba(255,255,255,.17);border-radius:31px;background:linear-gradient(145deg,rgba(18,44,111,.92),rgba(5,14,43,.9));box-shadow:0 30px 80px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.12);text-align:center}
  .mark{width:88px;height:88px;border-radius:27px;object-fit:cover;box-shadow:0 15px 34px rgba(0,211,198,.24);margin-bottom:19px} .eyebrow{font:500 11px/1 'DM Mono',monospace;color:#78ffec;letter-spacing:.16em;text-transform:uppercase}.eyebrow:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#78ffec;box-shadow:0 0 16px #78ffec;margin-right:8px}h1{font-size:29px;line-height:1.12;letter-spacing:-.055em;margin:17px 0 12px}p{margin:0 auto;color:#c2cce4;font-size:14px;line-height:1.65;max-width:340px}.code{margin:27px 0 11px;width:100%;border:1px solid rgba(122,255,236,.35);border-radius:15px;background:#061132;padding:18px 12px;color:#fff;text-align:center;font:500 27px/1 'DM Mono',monospace;letter-spacing:.18em;text-transform:uppercase;outline:none;transition:.2s}.code:focus{border-color:#78ffec;box-shadow:0 0 0 4px rgba(120,255,236,.13)}button{width:100%;border:0;border-radius:14px;margin-top:10px;padding:15px 18px;background:linear-gradient(100deg,#79ffe6,#39bdfc);color:#04234a;font:800 14px/1 Manrope,sans-serif;cursor:pointer;transition:transform .18s,filter .18s}button:hover{filter:brightness(1.08);transform:translateY(-2px)}.hint{font-size:12px;margin-top:17px;color:#8795bb}.error{color:#ff9eaa;font-size:12px;margin-top:12px;min-height:18px}@media(max-width:480px){main{padding:36px 24px 28px;border-radius:25px}h1{font-size:26px}}
</style></head><body><main><img class="mark" src="/go/brand/pairing-mark.jpg" alt="OmniX Go"><div class="eyebrow">Second verification</div><h1>Confirm this computer</h1><p>You’re signed in as the gateway owner. Enter the one-time code shown in the OmniX Go terminal to finish connecting ChatGPT.</p><form method="post" action="${action}"><input type="hidden" name="state" value="${encodeURIComponent(state)}"><input class="code" name="pairing_code" autocomplete="one-time-code" inputmode="text" maxlength="9" placeholder="XXXX-XXXX" aria-label="Pairing code" autofocus required><button type="submit">Confirm &amp; connect</button></form><div class="error" role="alert">${escapedError}</div><div class="hint">This code stays on your computer. It is not stored by auth.omnix.work.</div></main><script>document.querySelector('.code').addEventListener('input',e=>{const v=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);e.target.value=v.length>4?v.slice(0,4)+'-'+v.slice(4):v})</script></body></html>`;
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
  private readonly identityAuthorizations = new Map<string, PendingIdentityAuthorization>();
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
        // sha256() uses Base64URL output (43 characters for a SHA-256 digest),
        // not hexadecimal. Rejecting it here made every service restart forget
        // all refresh grants and forced ChatGPT to pair again after token expiry.
        if (/^[A-Za-z0-9_-]{43}$/.test(token) && grant.expiresAt > Date.now()) {
          this.refreshTokens.set(token, grant);
        }
      }
      for (const jti of state.revokedJtis ?? []) this.revokedJtis.add(jti);
      this.events.publish(
        "security",
        "OAuth state restored",
        "success",
        `${this.clients.size} clients, ${this.refreshTokens.size} refresh grants`,
      );
      await this.persistState();
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

  private async currentPairingSecretHash(): Promise<string | undefined> {
    try {
      const stored = JSON.parse(await readFile(this.configPath, "utf8")) as { pairingSecretHash?: unknown };
      if (typeof stored.pairingSecretHash === "string" && stored.pairingSecretHash.length > 0) {
        this.config.pairingSecretHash = stored.pairingSecretHash;
      }
    } catch (error) {
      this.events.publish("security", "Pairing credential reload failed", "warning", String(error));
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
            kid: "omnix-go-local",
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
      if (!this.config.gatewayOwnerUserId) {
        res.status(503).type("text").send("OmniX Go has no authenticated gateway owner. Run `omnix-go gateway provision --name <name>` on the computer first.");
        return;
      }
      const loopback = `http://127.0.0.1:${this.config.port}/auth/callback`;
      const broker = createDesktopAuthorization(loopback);
      this.identityAuthorizations.set(broker.state, {
        clientId,
        redirectUri,
        challenge,
        resource,
        scopes: this.normalizeScopes(req.query.scope),
        ...(req.query.state ? { clientState: String(req.query.state) } : {}),
        brokerVerifier: broker.verifier,
        expiresAt: Date.now() + 5 * 60 * 1000,
        pairingAttempts: 0,
      });
      this.events.publish("security", "OmniX owner verification started", "running", clientId);
      res.redirect(broker.url);
    });

    router.get("/auth/callback", async (req, res) => {
      const brokerState = String(req.query.state ?? "");
      const pending = this.identityAuthorizations.get(brokerState);
      if (!pending || pending.expiresAt < Date.now() || !req.query.code) {
        res.status(400).type("text").send("Invalid or expired OmniX authorization callback.");
        return;
      }
      try {
        const session = await exchangeDesktopCode(String(req.query.code), pending.brokerVerifier);
        if (session.user.id !== this.config.gatewayOwnerUserId) {
          this.identityAuthorizations.delete(brokerState);
          this.events.publish("security", "Non-owner authorization rejected", "warning");
          res.status(403).type("text").send("This Firebase account does not own this OmniX gateway.");
          return;
        }
        pending.identityVerifiedAt = Date.now();
        this.identityAuthorizations.set(brokerState, pending);
        // Keep the public /go gateway prefix. An absolute path would reset it to
        // the hostname root, which is served by the separate app on port 8080.
        const pairUrl = new URL("oauth/pair", `${this.canonicalBase(req).replace(/\/+$/, "")}/`);
        pairUrl.searchParams.set("state", brokerState);
        this.events.publish("security", "Gateway owner identity verified; pairing confirmation required", "success", pending.clientId);
        res.redirect(pairUrl.toString());
      } catch (error) {
        this.identityAuthorizations.delete(brokerState);
        this.events.publish("security", "OmniX identity verification failed", "warning", String(error));
        res.status(403).type("text").send("OmniX identity verification failed.");
      }
    });

    const completePairing = (req: Request, res: Response, failure?: string) => {
      const brokerState = String(req.method === "GET" ? req.query.state ?? "" : req.body?.state ?? "");
      const pending = this.identityAuthorizations.get(brokerState);
      const action = req.baseUrl.startsWith("/go") ? "/go/oauth/pair" : "/oauth/pair";
      if (!pending || pending.expiresAt < Date.now() || !pending.identityVerifiedAt) {
        res.status(400).type("text").send("This confirmation has expired. Start the connection again from ChatGPT.");
        return;
      }
      if (failure) {
        res.status(403).type("html").send(pairingPage(action, brokerState, failure));
        return;
      }
      res.type("html").send(pairingPage(action, brokerState));
    };

    router.get("/oauth/pair", (req, res) => completePairing(req, res));
    router.post("/oauth/pair", async (req, res) => {
      const brokerState = String(req.body?.state ?? "");
      const pending = this.identityAuthorizations.get(brokerState);
      if (!pending || pending.expiresAt < Date.now() || !pending.identityVerifiedAt) {
        res.status(400).type("text").send("This confirmation has expired. Start the connection again from ChatGPT.");
        return;
      }
      pending.pairingAttempts += 1;
      if (pending.pairingAttempts > 5) {
        this.identityAuthorizations.delete(brokerState);
        this.events.publish("security", "Pairing confirmation rate limited", "warning", pending.clientId);
        res.status(429).type("text").send("Too many invalid code attempts. Start the connection again from ChatGPT.");
        return;
      }
      if (!pairingCodeMatches(await this.currentPairingSecretHash(), String(req.body?.pairing_code ?? ""))) {
        this.identityAuthorizations.set(brokerState, pending);
        this.events.publish("security", "Invalid pairing code", "warning", pending.clientId);
        completePairing(req, res, "That code does not match. Check the OmniX Go terminal and try again.");
        return;
      }
      this.identityAuthorizations.delete(brokerState);
      const code = randomToken();
        this.codes.set(code, {
          clientId: pending.clientId,
          redirectUri: pending.redirectUri,
          challenge: pending.challenge,
          resource: pending.resource,
          scopes: pending.scopes,
          expiresAt: Date.now() + 2 * 60 * 1000,
        });
      const location = new URL(pending.redirectUri);
      location.searchParams.set("code", code);
      if (pending.clientState) location.searchParams.set("state", pending.clientState);
      this.events.publish("security", "Gateway owner and pairing code authorized ChatGPT", "success", pending.clientId);
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
          this.refreshTokens.set(sha256(refreshToken), {
            clientId: pending.clientId,
            resource: pending.resource,
            scopes: pending.scopes,
            expiresAt: Date.now() + REFRESH_GRANT_TTL_MS,
          });
          await this.persistState();
          res.json({
            access_token: await this.signAccessToken(pending),
            token_type: "Bearer",
            expires_in: 300,
            refresh_token: refreshToken,
            scope: pending.scopes.join(" "),
          });
          return;
        }
        if (grantType === "refresh_token") {
          const refreshToken = String(req.body.refresh_token ?? "");
          const refreshTokenHash = sha256(refreshToken);
          const grant = this.refreshTokens.get(refreshTokenHash);
          if (
            !grant ||
            grant.expiresAt < Date.now() ||
            grant.clientId !== String(req.body.client_id ?? "")
          ) {
            res.status(400).json({ error: "invalid_grant" });
            return;
          }
          this.refreshTokens.delete(refreshTokenHash);
          const rotatedRefreshToken = randomToken(48);
          const requestedScopes = this.normalizeScopes(req.body.scope);
          const scopes = req.body.scope
            ? requestedScopes.filter((scope) => grant.scopes.includes(scope))
            : grant.scopes;
          this.refreshTokens.set(sha256(rotatedRefreshToken), {
            ...grant,
            scopes,
            expiresAt: Date.now() + REFRESH_GRANT_TTL_MS,
          });
          await this.persistState();
          res.json({
            access_token: await this.signAccessToken({ ...grant, scopes }),
            token_type: "Bearer",
            expires_in: 300,
            refresh_token: rotatedRefreshToken,
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
      if (this.refreshTokens.delete(sha256(token))) {
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
        kid: "omnix-go-local",
        typ: "JWT",
      })
      .setIssuer(this.canonicalBase())
      .setSubject(this.config.gatewayOwnerUserId ?? "unprovisioned")
      .setAudience(grant.resource)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
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
