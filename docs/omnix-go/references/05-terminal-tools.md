# OmniX Go — Terminal tools

Commands run inside allowed workspaces. The inline UI shows the command, lifecycle state,
exit code, session ID, and stdout/stderr — but a pretty panel never overrides a non-zero
exit code.

## `run_command`

Bounded command that should finish within the timeout.

| Field | Constraints |
|---|---|
| `command` | string, ≥ 1 char, required |
| `cwd` | string, optional — set it explicitly when ambiguous |
| `timeoutMs` | int 1,000–3,600,000 (max 1 hour), optional |
| `env` | record of strings, optional |

- Prefer non-interactive commands. Add `--no-color`, `CI=1`, or `-q` flags where the
  command supports them for stable output.
- On timeout the session may still be running — do not rerun blindly; inspect via
  `terminal_status` if a session ID was returned, or use `start_command` for anything that
  may outlive the timeout.

## `start_command`

Start a long-running command; returns a session ID immediately.

| Field | Constraints |
|---|---|
| `command` | string, required |
| `cwd` | string, optional |
| `env` | record of strings, optional |

Return shape includes `sessionId` (UUID), `pid`, `startedAt`.

Use for: servers, watchers, downloads, installs, builds, long test suites, anything
streaming. After starting, record the session ID and poll.

## `terminal_status`

`{ sessionId: UUID }` — read current output and status for a session. Fields include
`running`, `exitCode`, `status`, `output`, `command`.

Poll responsibly:

1. Record the session ID after starting.
2. Poll at intervals proportional to expected duration (a build may take minutes; a server
   should stay `running`).
3. Read incremental output rather than restarting the work.
4. Intervene only on a real blocker, prompt, runaway behavior, or wrong direction.
5. Stop at completed, failed, cancelled, or genuinely blocked state.

## `terminal_input`

`{ sessionId: UUID, input: string }` — write to the session's stdin. Only for processes
that intentionally expect stdin (interactive prompts, REPLs, `read` commands). Prefer
non-interactive flags over scripting stdin when possible.

## `terminal_stop`

`{ sessionId: UUID }` — SIGTERM the session. Use when the process is no longer needed or
the user asks to stop it. Stop cleanly: let it flush output before declaring the session ended.

## Command hygiene

- Never embed secrets in command strings when an env var or configured credential exists
  (`env: { TOKEN: "..." }` — and never echo the value).
- `cwd` explicitly: `{ command: "npm test", cwd: "/path/to/package" }` instead of assuming.
- Avoid pipes that hide failure: prefer `git diff --exit-code` over `git diff | head`.
- For destructive commands (rm -rf, git reset --hard, migrations) see the safety
  boundaries in `references/13-safety.md` — confirm first.
