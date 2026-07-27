<div align="center">

# ChatGPT Code

**A secure, local-first MCP coding and computer-use harness for ChatGPT and Codex.**

[![npm version](https://img.shields.io/npm/v/chatgpt-code?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/chatgpt-code)
[![CI](https://img.shields.io/github/actions/workflow/status/HardikCoder45/chatgpt-code/release.yml?style=for-the-badge&logo=github&label=build)](https://github.com/HardikCoder45/chatgpt-code/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

*Guarded files · durable terminals · Git review · local skills · MCP gateway · subagents · evaluators · macOS computer control*

</div>

ChatGPT Code runs as a private MCP service on your own machine. Start one command, pair through OAuth, and give an AI client carefully scoped access to coding tools, long-running workflows, and visual computer control—without surrendering the workspace boundary.

```bash
chatgpt-code
```

The command starts:

- a Streamable HTTP MCP endpoint at `http://127.0.0.1:3939/mcp`;
- an authenticated legacy SSE compatibility endpoint at `http://127.0.0.1:3939/sse`;
- an OAuth 2.1 authorization server with PKCE and one-time terminal pairing;
- a private visual dashboard;
- a Cloudflare Quick Tunnel by default, printing a public HTTPS `/mcp` URL.

## Install

From this repository:

```bash
npm install
npm run build
npm link
chatgpt-code
```

Release-ready installation paths are included:

```bash
# npm, after publication
npm install --global chatgpt-code

# pip shim, after publication (Node.js 20+ is still required)
pip install chatgpt-code

# Homebrew tap, after publication
brew install HardikCoder45/tap/chatgpt-code

# curl installer
curl -fsSL https://raw.githubusercontent.com/HardikCoder45/chatgpt-code/main/install.sh | bash
```

This workspace contains the npm package, Python shim, Homebrew formula, curl installer, and GitHub release workflow. Publishing them requires your own npm/PyPI/GitHub/Homebrew credentials and repository URL; no external package was published automatically.

## First run and ChatGPT connection

1. Start the service:

   ```bash
   chatgpt-code
   ```

2. Copy the printed public URL ending in `/mcp`.
3. In ChatGPT developer/plugin settings, add that MCP endpoint.
4. When the OAuth page opens, enter the pairing code printed in the terminal.
5. Rotate the pairing code whenever needed:

   ```bash
   chatgpt-code auth rotate
   ```

The default Quick Tunnel URL changes on restart and is intended for personal development. Use a managed Cloudflare tunnel for a stable URL. Temporary tunnels should not be used for public plugin submission.

Prefer `/mcp` for ChatGPT and modern MCP clients. If a legacy client explicitly requires SSE, give it the same public origin ending in `/sse`; the SSE handshake advertises the authenticated `/messages` endpoint automatically.

## Security model

ChatGPT Code is deliberately single-user and local-first:

- OAuth 2.1 authorization-code flow with S256 PKCE;
- dynamic client registration plus ChatGPT Client ID Metadata support;
- one-time pairing knowledge available only in the local terminal;
- Ed25519-signed 15-minute access tokens;
- resource/audience, issuer, expiry, revocation, and per-tool scope checks;
- OAuth Protected Resource Metadata and `WWW-Authenticate` discovery;
- private dashboard token in an HttpOnly, SameSite cookie;
- workspace-root path allowlists with symlink escape checks;
- atomic file writes and patch path validation;
- state and signing keys stored under `~/.chatgpt-code` with user-only permissions;
- tokens and pairing codes are never written to activity logs.

For a multi-user or publicly submitted service, replace the built-in single-user pairing authorization server with an established identity provider. OpenAI’s current guidance recommends OAuth 2.1 for authenticated MCP servers and advises using a mature identity provider for production deployments.

## Tool surface

| Area | Tools |
|---|---|
| Files | `workspace_roots`, `read_file`, `list_directory`, `search_files`, `write_file`, `edit_file` |
| Terminal | `run_command`, `start_command`, `terminal_status`, `terminal_input`, `terminal_stop` |
| Git | `git_status`, `git_diff`, `apply_patch` |
| Skills | `read_chatgpt_code_guide`, `list_skills`, `refresh_skills`, `read_skill`, `evaluate_skill`, `make_skill` |
| MCP gateway | `connect_mcp`, `list_connected_mcps`, `inspect_connected_mcp_tools`, `call_connected_mcp_tool`, `disconnect_mcp`, plus dynamically proxied tools |
| Long-horizon harness | `start_agent`, `agent_status`, `list_agents`, `cancel_agent`, `evaluate_workspace` |
| Computer use | `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll` |
| Visuals | `recent_activity`, `show_activity_dashboard` |

Every tool carries safety annotations and an OAuth scope. File and command tools can only act inside configured workspace roots.

The comprehensive single-file operating skill is packaged at `skills/chatgpt-code/SKILL.md`. It is also exposed through `read_chatgpt_code_guide` and the `chatgpt-code://guide/SKILL.md` MCP resource so an AI client can load the same workflow directly.

## Local skills

At startup the service inventories `SKILL.md` files under:

- `~/.codex/skills`
- `~/.claude/skills`
- `~/.agents/skills`
- `~/.config/skills`

The inventory exposes name, description, source, files, validity warnings, content, and a structural score. `make_skill` creates a new skill in a configured root; it never writes to an arbitrary directory.

## Connect another MCP

ChatGPT can call `connect_mcp`, or you can seed entries in `~/.chatgpt-code/config.json`.

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

## Durable subagents and evaluators

`start_agent` runs the locally authenticated Codex CLI in `workspace-write` sandbox mode. Tasks are queued with a configurable parallelism limit and persisted under `~/.chatgpt-code/tasks`.

An agent can be started with evaluator commands:

```json
{
  "prompt": "Implement the requested parser and its tests.",
  "workspace": "/path/to/project",
  "evaluationCommands": ["npm test", "npm run typecheck"]
}
```

The task is only marked complete when Codex exits successfully and every evaluator passes. Service restarts preserve completed task history and mark interrupted jobs clearly.

## Cloudflare

### Quick Tunnel

No key is required:

```bash
chatgpt-code --tunnel quick
```

### Existing managed tunnel token

```bash
export CLOUDFLARE_TUNNEL_TOKEN="..."
export CHATGPT_CODE_PUBLIC_URL="https://code.example.com"
chatgpt-code --tunnel managed
```

### Fully managed through the Cloudflare API

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export CHATGPT_CODE_HOSTNAME="code.example.com"
export CLOUDFLARE_ZONE_ID="..." # optional; enables automatic DNS
chatgpt-code --tunnel managed
```

The service creates or reuses a tunnel, writes its ingress configuration, optionally creates the proxied CNAME, retrieves the tunnel token, starts `cloudflared`, and updates the OAuth resource URL.

When managed mode is installed as a macOS service, ChatGPT Code stores only the fixed hostname and tunnel runtime token in `~/.chatgpt-code/cloudflare-managed.json` with user-only `0600` permissions. If the Cloudflare API is used for first-time provisioning, the broader API token is removed from that runtime file after the tunnel token is obtained. The LaunchAgent can therefore reconnect to the same hostname after every login without depending on shell environment variables.

## Background service

On macOS:

```bash
chatgpt-code service install --tunnel managed
chatgpt-code service status
chatgpt-code service uninstall
```

This installs a per-user LaunchAgent at `~/Library/LaunchAgents/com.openai.chatgpt-code.plist`. Logs are written under `~/.chatgpt-code`.

## Command reference

```text
chatgpt-code [serve] [options]
chatgpt-code doctor
chatgpt-code auth rotate
chatgpt-code config show
chatgpt-code service install|status|uninstall
```

Important options:

```text
--workspace <path>       allowed root; repeatable
--tunnel off|quick|managed
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

Run the MCP Inspector against `http://127.0.0.1:3939/mcp`. Because the endpoint is authenticated, use the Inspector’s OAuth flow.

## Architecture

```text
ChatGPT / Codex
      │  OAuth 2.1 + PKCE
      ▼
Cloudflare HTTPS tunnel
      │
      ▼
ChatGPT Code MCP ───── Visual dashboard / event stream
      │
      ├── Guarded files, shell, Git, macOS computer control
      ├── Skill inventory from Codex / Claude / agent roots
      ├── Dynamic MCP clients (stdio / HTTP / SSE)
      └── Durable Codex subagents + evaluator gates
```

## License

MIT
