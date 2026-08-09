# OmniX Go — Service, gateway, identity, CLI, diagnostics

## CLI

```text
omnix-go [serve] [options]
omnix-go --name <permanent-name>
omnix-go doctor
omnix-go gateway provision --name <permanent-name>
omnix-go config show
omnix-go service install [--tunnel auto|gateway|off]
omnix-go service status
omnix-go service uninstall
```

The local defaults are `127.0.0.1:8111`. `auto` uses the authenticated gateway when
`gateway.json` exists and otherwise stays local; it never creates a random public URL.
`gateway` requires a successful provision. `off` is localhost-only. On macOS,
`OMNIX_GO_BROWSER="Google Chrome"` can force the authentication window into a visible
browser when the system default uses hidden spaces.

## Provisioning

Run `omnix-go`. When no local gateway exists, the CLI automatically authenticates and
looks up the account's existing permanent assignment. A new account is prompted once
for its gateway name. `omnix-go gateway provision --name <name>` remains the explicit
equivalent; `omnix-go --name <name>` is the shorter form. The CLI:

1. starts a random loopback callback on `127.0.0.1`;
2. opens `https://auth.omnix.work/desktop` with state and PKCE S256;
3. exchanges the two-minute broker code with the original verifier;
4. sends the in-memory Firebase ID token to
   `https://server.omnix.work/api/gateways/provision`;
5. calls the authenticated `GET /api/gateways/current` and reuses any assigned name;
6. validates the returned hostname, `/go` URL, and owner id;
7. writes `gateway-token` separately with mode 0600;
8. installs/restarts the per-user service with `--tunnel gateway`.

The server enforces the account’s permanent gateway name. A `409` naming the existing
gateway is a security success: rerun with that existing name. Never request or accept
Cloudflare API/account/zone keys. Never put the connector token in command arguments,
environment variables, URLs, browser storage, logs, diffs, or Git.

A user can choose a name only before the first server assignment. If an authenticated
account is already assigned, a different `--name` is rejected locally with the permanent
hostname. Local state deletion must never be presented as a rename mechanism.
New names are accepted only after the authenticated server confirms that neither the
global ownership registry nor any exact Cloudflare DNS record uses the hostname. The CLI
checks before confirmation, provisioning checks again, and the database unique constraint
protects concurrent claims.

## Service locations

| Platform | Location |
|---|---|
| macOS | `~/Library/LaunchAgents/com.omnix.go.plist` |
| Windows | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\OmniX Go.cmd` |
| Linux | `~/.config/systemd/user/omnix-go.service` |

All run as the signed-in user and require no administrator password. macOS Automation,
Accessibility, and Screen Recording approvals remain explicit OS privacy decisions.

## Diagnostics

Use `omnix-go doctor`, `omnix-go service status`, and the private service logs. Diagnose
in this order: service process → local `/go/health` → unauthorized `/go/mcp` → discovery
metadata → owner identity flow → MCP token exchange → `tools/list` → UI resource read →
representative tool call → public gateway.

Common failures:

| Symptom | Action |
|---|---|
| Account permanently assigned to another name | Re-run provision with the server-returned name |
| Browser opens in an invisible Arc space | Set `OMNIX_GO_BROWSER="Google Chrome"` and retry |
| No `gateway.json` | Complete verified owner sign-in and provisioning |
| Connector exits | Re-provision to obtain a fresh scoped token; do not use account keys |
| Public root fails but `/go` works | Expected when the unrelated 8080 origin is down |
| `/go` fails but root works | Confirm local 8111 service and connector are running |
| OAuth owner rejected | Sign in with the Firebase account recorded in `gateway.json` |
| Tools missing after connect | Refresh plugin metadata and begin a new conversation |
| Newly attached upstream tool is not selectable | Use `call_connected_mcp_tool`; catalog refresh is a client boundary |

Liveness alone never proves authorization or MCP correctness. A deployment is complete
only after a real owner OAuth flow and authenticated MCP initialization succeed.
