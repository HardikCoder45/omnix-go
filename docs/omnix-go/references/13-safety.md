# OmniX Go — Safety boundaries

Require explicit user confirmation before:

- deleting material files or data;
- overwriting broad directories;
- resetting or discarding Git changes;
- force pushing;
- publishing releases;
- sending messages or submitting forms;
- purchases;
- changing security or account permissions;
- running untrusted downloaded executables;
- exposing a local service beyond the configured authenticated tunnel;
- expanding workspace roots to unrelated private directories;
- typing secrets, credentials, or sensitive data into computer-use fields;
- connecting arbitrary upstream MCP servers or running remote tool commands.

## Principles

- Prefer reversible actions. Resolve exact targets before destructive operations.
- Never use broad recursive deletion against a home directory, workspace root, or
  unresolved variable.
- Stay inside `workspace_roots`; the PathGuard rejects escapes, but intent still matters.
- Scope discipline: each tool is bound to an OAuth scope. Never work around a scope
  rejection with a different tool or by widening the connection.
- A dirty worktree belongs to the user. Preserve unrelated changes.

## Secrets

- Never print or echo: OAuth tokens, refresh tokens, connector tokens, authorization codes, private JWKs,
  dashboard tokens, API keys, or authorization codes.
- Pass secrets to commands via `env` (and never echo the value).
- Keep upstream MCP credentials in `headers` config; never in tool output or summaries.
- The dashboard URL contains the dashboard token — treat the printed local URL as a secret.
- Report exposure immediately if a secret appeared in output or logs.

## Long-running work

- Never declare success because a process started.
- Intervene only on real blockers, prompts, runaway behavior, or wrong direction.
- Cancel (rather than let run) when continuing is clearly harmful.

## Computer use

- Fresh screenshot before each coordinates-based action; verify after.
- Stop and confirm before sending, deleting, purchasing, publishing, approving, or
  changing permissions.
- Prefer non-UI paths whenever one exists.

## Escalation

If a request asks for behavior outside these boundaries, decline the action and explain
what would make it safe: an explicit user confirmation, a narrower scope, or a
non-destructive alternative.
