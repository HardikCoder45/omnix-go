---
name: omnix-go
description: Operate OmniX Go (the omnix-go private MCP coding and computer-use harness) for repository inspection, plan-driven implementation, file editing, terminal sessions, Git review, local skill discovery and authoring, upstream MCP gateway connections, durable subagents with evaluators, macOS computer control, activity review, and the skybridge inline UI. Use whenever an AI must implement, debug, refactor, test, inspect, automate, monitor, or visually verify engineering work through OmniX Go, especially for multi-step, long-running, or cross-tool tasks that need persistent plans, durable processes, visual panels, or authenticated omnix.work gateway access.
---

# OmniX Go

OmniX Go is the private, local-first MCP coding and computer-use harness (package name
`omnix-go`) that exposes planning, files, terminal, Git, skills, MCP gateway, durable
agents, and macOS computer control as MCP tools behind OAuth 2.1. This skill teaches the
complete, careful way to operate it. Treat it as an execution harness, not as permission to
act without judgment: every task is an inspect → change → verify loop inside the authorized
workspace, ending with evidence.

## How to use this skill

This is a multi-file skill. Load what you need before acting:

| When you need… | Read |
|---|---|
| What the harness is, auth, tunnel, UI, scopes | `references/00-architecture.md` |
| Task modes and the operating contract | `references/01-modes-and-contract.md` |
| How to begin any non-trivial task | `references/02-starting-work.md` |
| Plans: create/get/list/update/complete | `references/03-planning-tools.md` |
| Files: roots/read/list/search/write/edit | `references/04-file-tools.md` |
| Terminal: run/start/status/input/stop | `references/05-terminal-tools.md` |
| Git: status/diff/apply_patch | `references/06-git-tools.md` |
| Local skills: list/refresh/read/evaluate/make | `references/07-skill-tools.md` |
| Upstream MCP gateway: connect/inspect/call/disconnect | `references/08-mcp-gateway.md` |
| Durable agents and evaluators | `references/09-agent-tools.md` |
| Computer control: screenshot/click/type/key/scroll | `references/10-computer-tools.md` |
| Activity, dashboard, and the inline UI panels | `references/11-activity-ui.md` |
| Full workflows: debug, build, long-horizon, parallel, runbooks | `references/12-runbooks.md` |
| Safety boundaries, scopes, secrets | `references/13-safety.md` |
| Service, gateway identity, CLI, diagnostics | `references/14-service-ops.md` |

## Operating contract (summary)

1. Identify the mode: answer, review, diagnose, change/build, monitor, computer-use, or long-horizon.
2. Read-only inspection is authorized when it directly supports the request.
3. Ordinary local edits and non-destructive tests are authorized when the user asked to change or build.
4. Ask before destructive, irreversible, external, or scope-expanding actions (full list in `references/13-safety.md`).
5. Stay inside paths returned by `workspace_roots`.
6. Inspect before modifying; preserve unrelated user changes.
7. Create and maintain a persistent plan before non-trivial mutations.
8. Review diffs, run evaluators, and finalize the plan before claiming completion.

## Tool map (43 entry points)

**Planning:** `create_plan`, `get_plan`, `list_plans`, `update_plan`, `complete_plan`
**Files:** `workspace_roots`, `read_file`, `list_directory`, `search_files`, `write_file`, `edit_file`
**Terminal:** `run_command`, `start_command`, `terminal_status`, `terminal_input`, `terminal_stop`
**Git:** `git_status`, `git_diff`, `apply_patch`
**Skills:** `read_omnix_go_guide`, `list_skills`, `refresh_skills`, `read_skill`, `evaluate_skill`, `make_skill`
**MCP gateway:** `connect_mcp`, `list_connected_mcps`, `inspect_connected_mcp_tools`, `call_connected_mcp_tool`, `disconnect_mcp` plus dynamically imported tools
**Agents:** `start_agent`, `agent_status`, `list_agents`, `cancel_agent`, `evaluate_workspace`
**Computer:** `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`
**Activity/UI:** `recent_activity`, `show_activity_dashboard`

## Universal rules

- Every tool result renders an inline OmniX panel. Use the **Visual** tab for the
  purpose-built view, the **Raw** tab for exact keys and output.
- Every tool carries an OAuth scope. A rejected call is usually a scope or auth issue,
  not a harness bug (see `references/13-safety.md`).
- Never print tokens, connector credentials, private keys, or authorization codes anywhere.
- A healthy process or successful start is not success: verify state, exit codes, and diffs.
- Plan first, mutate second, verify last, evidence always.
