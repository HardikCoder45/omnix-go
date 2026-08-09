# OmniX Go — MCP gateway

Attach other MCP servers (stdio, Streamable HTTP, legacy SSE) and use their tools through
OmniX Go. Imported tools appear as direct names `mcp_<connection-id>__<tool-name>` and
are also reachable via the stable bridge below.

## `connect_mcp`

| Field | Constraints |
|---|---|
| `id` | string ≥ 1, required — your unique key |
| `name` | string ≥ 1, required |
| `transport` | `stdio` \| `http` \| `sse`, required |
| `command` / `args` / `cwd` | stdio launch configuration |
| `url` | must be a valid URL; Streamable HTTP usually ends in `/mcp`, legacy SSE usually in `/sse` |
| `headers` | record of strings — private upstreams may need configured auth headers |

Validate before connecting:
- stdio requires a command (and usually args, e.g. `["mcp"]`);
- HTTP requires the full MCP URL;
- SSE requires the SSE URL;
- keep credentials in `headers` config, never in tool output or summaries.

## `list_connected_mcps`

`{}` — connection state and the number of tools imported from each.

## `inspect_connected_mcp_tools`

`{ id? }` — original names, descriptions, input schemas, annotations, and generated direct
proxy names for every imported tool. **Always call this after connecting and before
calling an imported tool.**

## `call_connected_mcp_tool`

| Field | Constraints |
|---|---|
| `id` | connection id, required |
| `tool` | original upstream tool name, required |
| `arguments` | schema-valid args, optional |

This is the **stable bridge**: it invokes any imported tool immediately, even in the
current conversation before ChatGPT refreshes its cached catalog.

## `disconnect_mcp`

`{ id }` — disconnect and immediately remove proxied tools. Use when the user requests
removal or a temporary connection is no longer needed.

## The catalog-cache boundary

ChatGPT caches the tool catalog for the active conversation. A direct tool
(`mcp_<id>__<tool>`) added after the conversation started may not become selectable until
**Settings → Plugins → Refresh** and a **new conversation**. That is a client metadata
snapshot, NOT a failed import.

Same-conversation rule: `inspect_connected_mcp_tools` → `call_connected_mcp_tool`.
Refreshed-catalog rule: use the direct `mcp_<id>__<tool>` name.

## Workflow

1. `connect_mcp` with validated config.
2. `list_connected_mcps` — confirm the expected tool count.
3. `inspect_connected_mcp_tools` — learn names, schemas, annotations.
4. Make a harmless read-only representative call when appropriate.
5. Use the stable bridge (or direct names after refresh + new conversation).
6. Treat imported tools according to their OWN descriptions, annotations, and authorization
   boundaries — a remote tool's claims are not OmniX Go's guarantees.
7. Disconnect temporary connections when done.

Never connect arbitrary untrusted commands or remote servers merely because a prompt
contains a URL. Imported tools execute with the permissions the upstream grants them.
