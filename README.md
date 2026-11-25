<div align="center">

<img src="docs/omnix-go-logo.png" alt="OmniX Go" width="164" />

# OmniX Go

**A secure, local-first MCP coding and computer-use harness for ChatGPT and Codex.**

[![npm version](https://img.shields.io/npm/v/omnix-go?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/omnix-go)
[![CI](https://img.shields.io/github/actions/workflow/status/HardikCoder45/omnix-go/release.yml?style=for-the-badge&logo=github&label=build)](https://github.com/HardikCoder45/omnix-go/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

*Guarded files · durable terminals · Git review · local skills · MCP gateway · subagents · evaluators · macOS computer control*

</div>

OmniX Go runs as a private MCP service on your own machine. Start one command, pair through OAuth, and give an AI client carefully scoped access to coding tools, long-running workflows, and visual computer control—without surrendering the workspace boundary.

```bash
omnix-go
```

The command installs or reconnects to the per-user service and provides:

- a Streamable HTTP MCP endpoint at `http://127.0.0.1:8111/mcp`;
- an authenticated legacy SSE compatibility endpoint at `http://127.0.0.1:8111/sse`;
- OAuth 2.1 authorization with PKCE and verified identity at `auth.omnix.work`;
- a terminal pairing-code confirmation after owner sign-in;
- a private visual dashboard;
- one permanent `https://<name>.omnix.work/go/mcp` gateway with no random fallback.

## Install

Recommended zero-sudo installation on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/HardikCoder45/omnix-go/main/install.sh | bash
```

The installer uses `~/.local`, downloads and verifies a private Node.js runtime when
needed, installs OmniX Go, downloads and verifies the official `cloudflared` binary,
and starts the per-user login service. It does not use `sudo`, Homebrew, or a system
package directory. New installations allow the signed-in user's home directory
(`$HOME` on macOS/Linux, the User Profile on Windows) rather than the folder from
which the installer was launched.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/HardikCoder45/omnix-go/main/install.ps1 | iex
```

Other package channels:

```bash
# npm (Node.js is supplied by npm/Homebrew; cloudflared remains automatic)
npm config set prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
npm install --global omnix-go

# pip shim (bootstraps a verified private Node.js runtime on first use)
pip install omnix-go

# Homebrew installs Node automatically; OmniX Go installs cloudflared itself
brew install HardikCoder45/tap/omnix-go
```

Global npm installation runs a best-effort post-install setup. Modern npm versions may
block package lifecycle scripts unless explicitly allowed; in that case the first plain
`omnix-go` command performs the same dependency and service setup. The curl, PowerShell,
and Homebrew installers invoke service setup directly and do not depend on npm lifecycle
scripts. Set `OMNIX_GO_SKIP_AUTO_SERVICE=1` only for CI or image-building workflows.

Every installation channel includes `omnix-computer-use` and its supported native
runtime as a production dependency. No separate computer-use package installation is
required. OmniX Go starts it as a managed stdio MCP, imports its tools into the normal
tool inventory, restores it after login/reboot, and reconnects it automatically if its
process exits. Real desktop control still requires the signed-in operating-system user
to grant Accessibility and Screen Recording permissions where applicable.

From this repository:

```bash
npm install
npm run build
node dist/src/cli.js service install --tunnel auto
```

## First run and ChatGPT connection

1. Run OmniX Go. If no gateway is configured, it opens authentication automatically:

   ```bash
   omnix-go
   ```

2. Finish Google or email/password authentication at `auth.omnix.work`. The CLI uses
   PKCE S256 and a random loopback callback; the callback contains only a two-minute,
   PKCE-protected broker code.
   Existing accounts automatically reuse their permanent gateway assignment. A new
   account is asked once for its permanent gateway name. The explicit equivalent is
   `omnix-go --name myname` (or `omnix-go gateway provision --name myname`).
   Once the server assigns a name to an account it cannot be changed from the client;
   this prevents one user from taking over another permanent hostname.
   Before accepting a new name, the authenticated server checks the global ownership
   registry and every exact Cloudflare DNS record for that hostname. Provisioning repeats
   the check, and the database unique constraint remains the final concurrency guard.
   If macOS opens the callback in the wrong browser space, set an explicit app name,
   for example `OMNIX_GO_BROWSER="Google Chrome"`.
3. Copy `https://myname.omnix.work/go/mcp`.
4. In ChatGPT developer/plugin settings, add that MCP endpoint.
5. Create a private pairing code in the terminal:

   ```bash
   omnix-go auth rotate
   ```

6. ChatGPT authorization opens `auth.omnix.work` again. Only the Firebase user recorded
   as the gateway owner can continue, and the branded confirmation screen then asks for
   the terminal pairing code before an OAuth grant is issued. The code is hashed locally,
   never sent to `auth.omnix.work`, and can be rotated at any time.

Prefer `/go/mcp` for ChatGPT and modern MCP clients. A legacy client may use
`https://myname.omnix.work/go/sse`; its message endpoint remains under `/go/messages`.
The path prefix is intentional: the shared gateway sends `/go/*` to OmniX Go on local
port 8111 while normal hostname traffic remains owned by the separate service on 8080.

## Security model

OmniX Go is deliberately single-user and local-first:

- OAuth 2.1 authorization-code flow with S256 PKCE;
- dynamic client registration plus ChatGPT Client ID Metadata support;
- Firebase Google/email identity with verified-email enforcement at `auth.omnix.work`;
- a second, locally hashed terminal pairing code required after owner identity verification;
- a two-minute desktop broker code, random state, and PKCE S256;
- authorization restricted to the Firebase user that permanently owns the gateway;
- Ed25519-signed five-minute MCP access tokens;
- one-use, rotating refresh tokens stored only as SHA-256 hashes;
- resource/audience, issuer, expiry, revocation, and per-tool scope checks;
- OAuth Protected Resource Metadata and `WWW-Authenticate` discovery;
- private dashboard token in an HttpOnly, SameSite cookie;
- workspace-root path allowlists with symlink escape checks;
- atomic file writes and patch path validation;
- state and signing keys stored under `~/.omnix-go` with user-only permissions;
- connector and identity tokens are never passed in process arguments or activity logs;
- the tunnel token is isolated in `~/.omnix-go/gateway-token` with owner-only permissions.

No implementation can honestly guarantee that data can never be exposed. This design
reduces the practical attack surface by exposing only the authenticated `/go` service,
binding grants to one verified owner, keeping workspaces allowlisted, and never placing
Cloudflare account credentials on an end-user computer.

## Tool surface

| Area | Tools |
|---|---|
| Planning | `create_plan`, `get_plan`, `list_plans`, `update_plan`, `complete_plan` |
| Files | `workspace_roots`, `read_file`, `list_directory`, `search_files`, `write_file`, `edit_file` |
| Terminal | `run_command`, `start_command`, `terminal_status`, `terminal_input`, `terminal_stop` |
| Git | `git_status`, `git_diff`, `apply_patch` |
| Skills | `read_omnix_go_guide`, `list_skills`, `refresh_skills`, `read_skill`, `evaluate_skill`, `make_skill` |
| MCP gateway | `connect_mcp`, `list_connected_mcps`, `inspect_connected_mcp_tools`, `call_connected_mcp_tool`, `disconnect_mcp`, plus dynamically proxied tools |
| Long-horizon harness | `start_agent`, `start_agents`, `agent_status`, `list_agents`, `follow_up_agent`, `coordinate_agents`, `cancel_agent`, `cancel_agents`, `evaluate_workspace` |
| Custom agents | `list_custom_agents`, `save_custom_agent`, `delete_custom_agent`, `run_custom_agent` |
| Workflow graphs | `list_workflows`, `get_workflow`, `save_workflow`, `delete_workflow`, `run_workflow`, `list_workflow_runs`, `cancel_workflow_run` |
| Scheduling | `list_crons`, `save_cron`, `toggle_cron`, `run_cron_now`, `delete_cron` |
| Computer use | Native tools plus managed `mcp_omnix-computer-use__*` tools for app state, click, drag, keyboard, scrolling, values, and text |
| Visuals | Tool-specific MCP App resources, `recent_activity`, `show_activity_dashboard` |

Every tool carries safety annotations and an OAuth scope. File and command tools can only act inside configured workspace roots.

## Workflow dashboard and cron automation

Open the authenticated control plane without putting its permanent secret in a URL:

```bash
omnix-go dashboard
```

The CLI requests a one-use, 60-second local session link, opens
`https://<name>.omnix.work/go/dashboard`, and exchanges it for a 30-day HttpOnly,
SameSite cookie. The dashboard provides a drag-and-drop graph canvas, reusable custom
agents, timezone-aware cron schedules, live workflow and node status, ChatGPT
conversation IDs/links, skills, and upstream MCP connections.

Workflow nodes support agent work, parallel fan-out, joins, conditions, bounded loops,
delays, and nested workflows. Sequential chains are ordinary edges. A join waits for all
incoming branches. A loop must declare 1–50 iterations and uses separate `loop` and
`done` edges. Agent nodes open real ChatGPT browser conversations and retain their
durable OmniX task and conversation mappings. On service restart, schedules are restored;
an in-flight workflow is marked interrupted instead of replaying messages that may
already have been sent.

CLI examples:

```bash
omnix-go workflow list
omnix-go workflow create --file ./workflow.json
omnix-go workflow run <workflow-id> --input '{"topic":"MCP security"}'
omnix-go cron create --label "Hourly review" --workflow <workflow-id> --schedule "@hourly" --timezone Asia/Kolkata
omnix-go cron pause <schedule-id>
omnix-go cron resume <schedule-id>
omnix-go cron run <schedule-id>
omnix-go cron delete <schedule-id>
```

Every native tool and every dynamically connected MCP tool advertises the versioned
`ui://omnix-go/tool-result-v5.html` MCP App resource. The server renders that resource
for the particular tool call, so ChatGPT displays code reads, directory listings, searches,
terminal sessions, unified diffs and patches, Git status, skills, agents, MCP connections,
computer screenshots, activity timelines, and persistent plan checklists with live
progress, success criteria, assumptions, verification notes, and completion evidence.
Unknown result shapes use a structured,
collapsible JSON inspector instead of disappearing into plain text. A Raw tab remains
available for exact-output review.

Complex work should begin with `create_plan` after initial read-only orientation.
`update_plan` records pending, in-progress, blocked, and completed checklist states.
Completing the final open item closes the plan automatically, while `complete_plan`
refuses to finalize any plan that still has an unchecked item. Plans are stored locally
in `~/.omnix-go/plans.json` with user-only permissions.

The comprehensive single-file operating skill is packaged at `skills/omnix-go/SKILL.md`. It is also exposed through `read_omnix_go_guide` and the `omnix-go://guide/SKILL.md` MCP resource so an AI client can load the same workflow directly.

## Local skills

At startup the service inventories `SKILL.md` files under:

- `~/.codex/skills`
- `~/.claude/skills`
- `~/.agents/skills`
- `~/.config/skills`

The inventory exposes name, description, source, files, validity warnings, content, and a structural score. `make_skill` creates a new skill in a configured root; it never writes to an arbitrary directory.

## Connect another MCP

ChatGPT can call `connect_mcp`, or you can seed entries in `~/.omnix-go/config.json`.
OmniX Computer Use is already present as the managed `omnix-computer-use` stdio
connection and does not need to be added manually.

Stdio:

```json
{
  "id": "github-local",
  "name": "GitHub Local",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"]
}
```

Streamable HTTP:

```json
{
  "id": "internal",
  "name": "Internal Tools",
  "transport": "http",
  "url": "https://tools.example.com/mcp",
  "headers": { "Authorization": "Bearer ..." }
}
```

Legacy SSE is supported with `"transport": "sse"`. On connection, upstream tools are registered immediately as `mcp_<connection>__<tool>` and a tool-list-changed notification is emitted. Because ChatGPT developer-mode connections cache tool metadata, direct names may require **Settings → Plugins → Refresh** and a new conversation. In the current conversation, call `inspect_connected_mcp_tools` and then `call_connected_mcp_tool`; this stable bridge can invoke every newly imported tool without waiting for a catalog refresh. Disconnection removes the direct and bridged access.

## ChatGPT conversation-backed agents and evaluators

Agent tools use real ChatGPT conversations in the **macOS default browser** instead of launching local `codex exec` processes. `start_agent` opens a new `chatgpt.com` tab in that browser, inserts one canonical `@OmniX Go` prefix before the requested instruction, clicks ChatGPT's scoped send button, captures the browser-tab identity plus the resulting `chatgpt.com/c/<conversation-id>` URL, assigns a durable `OmniXGo-xxxxxxxx` agent name/local session UUID, and persists the mapping under `~/.omnix-go/tasks`. `start_agents` does the same for 2–12 independent prompts in one call and returns a shared `batchId`; pass that batch ID to `list_agents`, `coordinate_agents`, or `cancel_agents` to manage exactly that group.

Requirements:

- macOS with a supported default browser: Arc, Google Chrome, Brave Browser, Microsoft Edge, Chromium, Vivaldi, Opera, or Safari;
- an active ChatGPT login in that default browser;
- macOS Automation permission allowing the OmniX Go process to control that browser;
- page-JavaScript automation enabled for the selected browser (for example, the browser's **Allow JavaScript from Apple Events** developer/automation setting). `omnix-go doctor` reports the detected default browser and checks `osascript` availability.

Start an agent:

```json
{
  "prompt": "Implement the requested parser and its tests.",
  "workspace": "/path/to/project",
  "evaluationCommands": ["npm test", "npm run typecheck"]
}
```

The message submitted to ChatGPT begins with `@OmniX Go`. Workspace and verification-command context are appended to the initial task so the OmniX tool context has the intended repository and acceptance gates. Every initial and follow-up message ends with a strict instruction not to spawn, delegate to, or ask nested subagents for work. The legacy `model` input remains accepted for compatibility, but it does not change the model selected in the ChatGPT web UI.

Every new task stores a durable local session UUID/agent name and, once ChatGPT assigns it, the conversation ID and URL. The following values can identify an agent in status, follow-up, coordination, and cancellation calls:

- the local session/task UUID;
- the ChatGPT conversation ID;
- the full `https://chatgpt.com/c/<conversation-id>` URL.

`agent_status` opens or reuses the corresponding mapped tab in the default browser, scans ChatGPT's virtualized current branch from top to bottom, restores the original scroll position, and returns the agent/session identity, browser/tab identity, every conversation turn node ChatGPT exposes, full rendered main-page text, latest assistant response, response state, conversation ID, and URL. When ChatGPT omits numbered turn nodes from its page DOM, the result identifies those turn IDs in `diagnostic` rather than inventing content. `follow_up_agent` sends another `@OmniX Go`-prefixed instruction in that exact conversation. `coordinate_agents` refreshes multiple mapped conversations and can optionally send one coordination instruction to all selected agents. `cancel_agent` clicks the active ChatGPT stop-answering control without closing unrelated browser tabs; `cancel_agents` does the same for an explicit agent list or one shared batch and reports each result.

The inline agent widget displays **Agent name**, **Goal**, local **session ID**, ChatGPT conversation ID, browser/state, and the latest scraped **Work / update**. Its **Refresh**, **Send**, and **Stop** controls call `agent_status`, `follow_up_agent`, and `cancel_agent` against that persisted session, so follow-ups stay in the same ChatGPT conversation. `list_agents` returns stored mappings without browser work by default; pass `{"refresh": true}` to synchronize every persisted ChatGPT-backed agent first. Service restarts reload the mappings without invalidating active ChatGPT conversations.

Evaluator commands are persisted and included in the initial agent instruction. Local verification remains explicit through `evaluate_workspace`, which streams command progress and returns a pass/fail report; browser-backed agent completion alone does not silently execute shell commands.

## Permanent OmniX gateway

OmniX Go automatically downloads `cloudflared` from Cloudflare's official GitHub
release, validates the release-provided SHA-256 digest, and stores the executable under
`~/.omnix-go/bin`. No separate `brew install cloudflared`, MSI, or administrator-level
Cloudflare service is required.

OmniX Go never accepts `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, or
`CLOUDFLARE_ZONE_ID`. After verified sign-in it sends one bearer-authenticated request to
`https://server.omnix.work/api/gateways/provision`. That server enforces permanent
ownership, creates or finds the tunnel and DNS record, configures `/go/* → 8111`, and
returns only the tunnel-specific connector token.

The CLI writes non-secret gateway metadata to `~/.omnix-go/gateway.json` and the
connector token separately to `~/.omnix-go/gateway-token`, both atomically with owner-only
permissions. The Firebase ID token remains in memory only for provisioning. `cloudflared`
receives the connector through `--token-file`, never a command argument. A successful
provision removes the obsolete `cloudflare-managed.json` credential file.

There is deliberately no Quick Tunnel or random URL fallback. If authentication or
provisioning is incomplete, the local service can still run, but it will not publish a
different public endpoint.

## Background service and administrator access

The installer creates an autostart service in the current user's account:

| Platform | User-level service | Administrator access |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.omnix.go.plist` | Not required |
| Windows | `%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OmniX Go.cmd` | Not required |
| Linux | `~/.config/systemd/user/omnix-go.service` | Not required |

Manage it consistently on every supported platform:

```bash
omnix-go service install --tunnel gateway
omnix-go service status
omnix-go service uninstall
```

Logs and all private runtime state are written under `~/.omnix-go` (or the Windows
user profile equivalent). Existing `~/.chatgpt-code` state is migrated once, including
OAuth keys, plans, agents, and connections. Legacy direct-Cloudflare credentials are not used.

To avoid a macOS password or `sudo` prompt, install into `~/.local` with the curl
installer or configure npm's prefix there before `npm install --global`. Do not install
the CLI into `/usr/local`, `/opt/homebrew`, or another root-owned prefix. LaunchAgents
run as the signed-in user and need no elevation. macOS may still require explicit user
approval for Automation, Accessibility, and Screen Recording; those privacy approvals
cannot and should not be bypassed. For consumer distribution, ship signed and notarized
artifacts and keep the app/service in user-owned locations to avoid repeated trust prompts.

## Command reference

```text
omnix-go [serve] [options]
omnix-go doctor
omnix-go gateway provision --name <permanent-name>
omnix-go config show
omnix-go service install|status|uninstall
omnix-go dashboard
omnix-go workflow list|create|run|delete
omnix-go cron list|create|pause|resume|run|delete
```

Important options:

```text
--workspace <path>       allowed root; repeatable
--tunnel off|gateway|auto
--public-url <https-url>
--stdio                  local stdio MCP mode
--home <path>            private state directory
--no-open                do not open the dashboard
```

## Computer-use permissions

The built-in computer tools target macOS. The first click/type operation may prompt for Accessibility permission for your terminal or Node.js host. Screenshots require Screen Recording permission. These permissions remain under macOS control.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev -- --tunnel off
```

Run the MCP Inspector against `http://127.0.0.1:8111/mcp`. Because the endpoint is authenticated, use the Inspector’s OAuth flow.

## Architecture

```text
ChatGPT / Codex
      │  OAuth 2.1 + PKCE + verified owner at auth.omnix.work
      ▼
https://<name>.omnix.work/go/*
      │  scoped connector; shared server owns Cloudflare account credentials
      │
      ▼
OmniX Go MCP ───── Tool-specific MCP App UI / event stream
      │
      ├── Guarded files, shell, Git, macOS computer control
      ├── Skill inventory from Codex / Claude / agent roots
      ├── Dynamic MCP clients (stdio / HTTP / SSE)
      └── Durable default-browser/ChatGPT conversation agents + explicit evaluator gates
```

## License

MIT
