# OmniX Go — Activity, dashboard, and inline UI

Every tool result renders an inline OmniX panel (skybridge). Panels are presentation and
trace surfaces — never substitutes for `git_diff`, evaluator output, or direct state
verification.

## `recent_activity`

| Field | Constraints |
|---|---|
| `after` | non-negative int, optional |
| `limit` | int 1–500, optional |

Reconstruct recent plan, terminal, file, diff, skill, MCP, agent, and computer-use events.
Use it when context was lost, a session resumed, or you need to reconstruct what happened.

## `show_activity_dashboard`

`{}` — render a cross-tool visual summary: recent events, plans, skills, agents, MCP
connections, workspace roots. Use it when a visual summary helps the user inspect the work.

## The inline panel

- Every tool advertises `ui://omnix-go/tool-result-v5.html` (`text/html+skybridge`)
  through `_meta.ui.resourceUri` / `openai/outputTemplate`.
- **Visual tab:** purpose-built representation per tool type; **Raw tab:** exact
  input/output JSON. Always use Raw when exact keys, values, or output text matter.
- The panel reads the tool input, output, and response metadata, renders, then notifies
  intrinsic height (responsive inline embedding).

### Per-tool view map

| Tool | Visual view |
|---|---|
| create_plan / get_plan / list_plans / update_plan / complete_plan | Plan board: goal, progress ring, checklist, criteria, assumptions, verification notes, outcome |
| read_file | Code viewer with line numbers |
| list_directory | File table (entry, type, bytes) |
| search_files | Match table (line, file, text) |
| write_file / edit_file / git_diff / apply_patch | Unified diff: hunk headers, +/− counts, old/new line numbers |
| run_command / start_command / terminal_status / terminal_input / terminal_stop | Terminal: command, state, exit code, session id |
| git_status | Working-tree state |
| list_skills / refresh_skills | Skill cards with validity scores |
| connect_mcp / list_connected_mcps / inspect_connected_mcp_tools | Connection/tool cards |
| start_agent / agent_status / list_agents | Agent task cards |
| computer_screenshot | The captured image |
| recent_activity / show_activity_dashboard | Activity timeline |
| Unknown shapes | Collapsible structured JSON inspector |

## Reading panels correctly

- A successful-looking terminal panel never overrides a non-zero exit code — check the
  Raw tab / exit code field.
- A rendered diff panel is the review surface: always inspect additions/deletions before
  claiming an edit is correct.
- Panels may lag the actual tool result only if metadata is stale — refresh context by
  calling `recent_activity` or re-running the read-only tool.

## Dashboard (browser)

Private dashboard at `http://127.0.0.1:8111/?token=<dashboardToken>` (printed by the
CLI; token cookie `omnix_go_dashboard`). Shows `/api/state` (service, events,
terminals, skills, agents, connections) and live `/api/events` SSE. The dashboard is
localhost-only; never expose it through a tunnel.
