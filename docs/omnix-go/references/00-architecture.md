# OmniX Go — Architecture

OmniX Go is a private, single-user, local-first MCP harness. Its local HTTP service
binds to `127.0.0.1:8111`; the permanent OmniX gateway retains `/go/*` and routes only
that prefix to this service. Normal traffic on the hostname remains routed to the
separate OmniX origin on port 8080.

## Component layout

```text
ChatGPT → https://<gateway>.omnix.work/go/mcp
  → server-managed Cloudflare ingress (/go/* only)
  → cloudflared --token-file ~/.omnix-go/gateway-token
  → 127.0.0.1:8111
      ├── /go/mcp                    Streamable HTTP MCP
      ├── /go/sse, /go/messages      Legacy SSE
      ├── /go/.well-known/*          OAuth metadata
      ├── /go/oauth/*                MCP OAuth 2.1 endpoints
      ├── /auth/callback             strict local identity callback
      └── /                          token-locked local dashboard
```

The macOS LaunchAgent is `~/Library/LaunchAgents/com.omnix.go.plist`. Windows uses a
per-user Startup entry and Linux uses a systemd user unit. None requires `sudo`.

## Private state (`~/.omnix-go`, directory mode 0700)

| File | Purpose |
|---|---|
| `config.json` | Workspace/skill roots, dashboard secret, local Ed25519 keys, gateway owner id, upstreams; mode 0600 |
| `gateway.json` | Non-secret permanent hostname, owner, and tunnel metadata; mode 0600 |
| `gateway-token` | Tunnel-specific connector token only; mode 0600 |
| `oauth-state.json` | Registered clients, hashed refresh grants, revoked JWT ids; mode 0600 |
| `plans.json`, `tasks/` | Persistent plans and agent history |
| `service.log`, `service.error.log` | User-service logs; credentials are redacted |

`cloudflare-managed.json` is obsolete and removed after successful gateway provisioning.
Cloudflare account, zone, and API credentials never belong on the end-user computer.

## Authentication layers

1. `auth.omnix.work` authenticates Firebase Google/email users and requires a verified
   email. Desktop handoff uses random state, PKCE S256, a strict loopback callback, and a
   short-lived PKCE-protected broker code. The Firebase ID token stays in memory only.
2. `server.omnix.work/api/gateways/provision` validates that ID token, permanently binds
   the gateway name to the Firebase user, configures `/go/* → 8111`, and returns a scoped
   connector token.
3. ChatGPT uses a separate OAuth 2.1 authorization-code flow. The same hosted identity
   broker verifies that the signed-in Firebase user id equals the stored gateway owner.
4. MCP access tokens are Ed25519 JWTs lasting five minutes and bound to issuer, resource
   audience, client, and scopes. Refresh grants last at most 30 days, rotate after every
   use, and are persisted only as SHA-256 hashes.

## Canonical endpoints

| Endpoint | Use |
|---|---|
| `https://<gateway>.omnix.work/go/mcp` | Primary MCP endpoint |
| `https://<gateway>.omnix.work/go/sse` | Legacy SSE handshake |
| `https://<gateway>.omnix.work/go/messages` | Legacy SSE messages |
| `https://<gateway>.omnix.work/go/.well-known/oauth-protected-resource/mcp` | Resource metadata |
| `https://<gateway>.omnix.work/go/.well-known/oauth-authorization-server` | Authorization metadata |
| `https://<gateway>.omnix.work/go/health` | Liveness only |

There is no Quick Tunnel or random URL fallback. A missing gateway leaves only the local
service available.

## Verification

1. `/go/health` returns OmniX Go and the expected version.
2. Unauthenticated `/go/mcp` returns `401` and protected-resource metadata.
3. Metadata advertises the same `/go` issuer and `/go/mcp` resource.
4. Owner sign-in succeeds; a different Firebase user is rejected.
5. MCP initialization, `tools/list`, resource listing, UI resource read, and a harmless
   representative tool call succeed.
6. Expired/wrong-audience tokens, old refresh tokens, and invalid redirects are rejected.

Every tool advertises the versioned `ui://omnix-go/tool-result-v5.html` MCP App resource
with `text/html+skybridge`. ChatGPT can cache catalogs, so metadata changes may require a
plugin refresh and a new conversation.
