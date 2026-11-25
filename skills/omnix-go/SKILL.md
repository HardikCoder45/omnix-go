---
name: omnix-go
description: Operate the private OmniX Go MCP coding and computer-use harness for repository inspection, file editing, terminal work, Git review, local skill discovery and creation, upstream MCP connections, durable subagents, evaluator-driven long-running tasks, macOS computer control, and visual activity review. Use whenever an AI is asked to implement, debug, refactor, test, inspect, automate, or visually verify work through OmniX Go, especially for multi-step or long-running engineering tasks.
---

# OmniX Go

Use OmniX Go as a careful execution harness, not as permission to act without judgment. Convert the user’s goal into an inspect–change–verify loop, keep every action within the authorized workspace and task, and finish with evidence.

## Operating contract

Follow these rules throughout the task:

1. Identify whether the user asked to inspect, diagnose, change, build, monitor, or explain.
2. Treat read-only inspection as authorized when it directly supports the request.
3. Treat ordinary local edits and non-destructive tests as authorized when the user asked to change or build.
4. Ask before destructive actions, irreversible operations, external publication, sending messages, purchases, credential changes, or material scope expansion.
5. Stay within paths returned by `workspace_roots`.
6. Inspect relevant files before modifying them.
7. Preserve unrelated user changes and dirty-worktree content.
8. Prefer the smallest coherent change that fully solves the problem.
9. For non-trivial work, create and maintain a persistent checklist plan before making changes.
10. Review the resulting diff.
11. Run the most relevant evaluators before claiming success.
12. Mark every plan step complete and finalize the plan before reporting the task as finished.
13. Report what changed, what passed, and any remaining uncertainty.

Never interpret access to a powerful tool as authorization to use it. Tool availability and user intent are separate.

## Select the task mode

Choose one mode before acting:

- **Answer or explain:** Inspect only what is necessary and return a grounded answer. Do not edit.
- **Review:** Inspect code, diffs, logs, or configuration. Report prioritized findings with file evidence. Do not implement unless requested.
- **Diagnose:** Reproduce or trace the failure, isolate the cause, and explain it. Implement only if the user also asked to fix it.
- **Change or build:** Inspect, implement, review the diff, run checks, and hand off the working result.
- **Monitor:** Start or identify the long-running process, poll it at useful intervals, and report terminal state.
- **Computer-use task:** Capture fresh visual state before acting, perform the minimum UI action, and verify the resulting state.
- **Long-horizon task:** Break the work into bounded stages, use durable commands or agents, attach evaluators, and continue until a terminal outcome.

If the request mixes modes, use the least-authorizing interpretation for each part. For example, “review this and fix critical issues” authorizes fixes for critical issues, not unrelated refactoring.

## Begin every non-trivial task

For a coding or computer-use task:

1. Call `workspace_roots`.
2. Inspect the relevant directory with `list_directory`.
3. Check `git_status` when the workspace is a Git repository.
4. Read the smallest set of likely relevant files with `read_file`.
5. Use `search_files` to locate symbols, configuration, errors, or tests.
6. Form a concise working hypothesis.
7. Call `create_plan` with the goal, definition of done, assumptions, ordered checklist,
   and a verification method for each step.
8. Mark the first executable step `in_progress` with `update_plan`.
9. Choose direct tools, a terminal session, or a durable agent based on the work’s shape.

Do not begin by rewriting a whole file when a focused edit will work. Do not run broad commands before locating the repository and its documented checks.

## Tool selection

### Persistent planning

- Use `create_plan` after initial read-only orientation and before the first workspace
  mutation for every non-trivial, multi-step, risky, or long-running task.
- Write observable success criteria. “Everything works” is not a criterion; name the
  behavior, test, endpoint, artifact, or visual state that proves completion.
- Give every step a bounded action and, whenever possible, a verification instruction.
- Use `get_plan` before resuming work or when context may have changed.
- Use `list_plans` to inspect prior active and completed plans.
- Use `update_plan` immediately after meaningful progress. Keep no more than one step
  `in_progress`; use `blocked` only when a concrete dependency prevents progress.
- Attach concise evidence notes when completing a step, such as a test result, diff
  review, endpoint response, or screenshot observation.
- The final completed checkbox automatically marks the plan complete. Then call
  `complete_plan` with the final outcome and evidence. It will refuse completion while
  even one item remains pending, in progress, or blocked.

Never mark a checkbox complete merely because work was attempted. A checked item means
its stated verification condition was satisfied. If the plan changes materially, create
a new plan rather than concealing unplanned work under an unrelated checklist item.

### Workspace and files

- Use `workspace_roots` before file or command operations.
- Use `read_file` for precise source inspection. Request a line range for large files.
- Use `list_directory` to understand layout. Start shallow and increase depth only when needed.
- Use `search_files` for regex text discovery with optional glob filtering.
- Use `write_file` to create a file or intentionally replace its full content.
- Use `edit_file` for exact, narrow replacements.

`write_file` and `edit_file` return unified diffs. Inspect those diffs immediately when the edit is sensitive or unexpectedly large.

### Terminal

- Use `run_command` for bounded commands that should finish within the timeout.
- Use `start_command` for servers, watchers, builds, downloads, or long evaluations.
- Use `terminal_status` to poll a background command.
- Use `terminal_input` only when the process intentionally expects stdin.
- Use `terminal_stop` when the process is no longer needed or the user asks to stop it.

Prefer non-interactive commands. Set the command working directory explicitly when ambiguity exists. Do not embed secrets in command strings when a safer environment or configured credential mechanism exists.

### Git

- Use `git_status` before editing and before final handoff.
- Use `git_diff` after edits. Use `staged: true` only when reviewing staged changes.
- Use `apply_patch` for a validated unified patch, especially multi-file focused changes.

Never discard unrelated modifications. A dirty worktree belongs to the user unless the task clearly establishes otherwise.

### Local skills

- Use `list_skills` to discover relevant Codex, Claude, agent, or global skills.
- Use `refresh_skills` when inventory may have changed.
- Use `read_skill` before applying a selected skill.
- Use `evaluate_skill` to inspect structural quality and warnings.
- Use `make_skill` only when the user asks to create a reusable skill.

Read a selected `SKILL.md` completely before following it. If it references required local files, read those files before acting. Do not pretend a skill was used when it was only listed.

### MCP gateway

- Use `connect_mcp` to attach an upstream server over stdio, Streamable HTTP, or legacy SSE.
- Use `list_connected_mcps` to confirm connection state and imported tools.
- Use `inspect_connected_mcp_tools` to read the imported tools' original names, descriptions, schemas, annotations, and direct proxy names.
- Use `call_connected_mcp_tool` to invoke a newly connected tool immediately when the current client has not refreshed its direct tool catalog.
- Use `disconnect_mcp` when the user requests removal or when a temporary connection is no longer needed and disconnection is clearly within scope.

Connected tools appear as `mcp_<connection-id>__<tool-name>`. ChatGPT may cache the tool catalog for the active conversation, so a direct name added after the conversation started may not become selectable until plugin metadata is refreshed and a new conversation is started. This is a client metadata-snapshot boundary, not a failed upstream connection. For guaranteed same-conversation access, inspect the tool and invoke it through `call_connected_mcp_tool`. Treat connected MCP tools according to their own descriptions, annotations, and authorization boundaries.

### ChatGPT conversation-backed agents and evaluators

- Use `start_agent` for a bounded, independent task that should run in its own durable ChatGPT conversation. The harness opens Arc, prefixes the instruction with `@OmniX Go`, submits it, and persists both the local task ID and ChatGPT conversation ID/URL.
- Use `agent_status` with a local task ID, ChatGPT conversation ID, or conversation URL to refresh the full transcript, page state, latest assistant response, and response status from that Arc tab.
- Use `follow_up_agent` to send an `@OmniX Go`-prefixed continuation in the same conversation.
- Use `coordinate_agents` without an instruction to monitor selected agents, or with an instruction to send one coordinated follow-up to each selected conversation.
- Use `list_agents` to review persisted mappings; request refresh only when live page synchronization is needed.
- Use `cancel_agent` only when cancellation is requested or continuing is clearly harmful; it stops active ChatGPT generation without closing unrelated Arc tabs.
- Use `evaluate_workspace` for explicit ordered test, lint, typecheck, build, or validation commands. Browser-backed agent completion does not silently execute shell evaluators.

Do not delegate a one-line edit or a task that requires constant shared judgment. Do not start multiple agents on overlapping files unless the coordination strategy explicitly prevents conflicts. Treat a returned conversation ID as the durable identity for future monitoring and follow-up.

### Custom agents, workflow graphs, and cron schedules

- Use `save_custom_agent` to create a reusable browser-agent profile with a stable name,
  base prompt, optional workspace, optional model metadata, evaluation commands, and tags.
- Use `list_custom_agents` before referencing a profile from a graph. Use
  `run_custom_agent` for one immediate run. Delete a profile only when it is no longer
  referenced by a workflow.
- Use `save_workflow` for persistent graph orchestration. Supported node types are
  `agent`, `split`, `join`, `condition`, `loop`, `delay`, and `subworkflow`.
- Represent an ordinary sequence with edges. A `split` fans out every matching outgoing
  edge concurrently. A `join` proceeds only after every inbound edge has arrived.
- Conditions route through `true` or `false` edges. Failed nodes route through a
  `failure` edge when present and fail the run otherwise.
- A loop must specify 1–50 iterations. Route repeated work through a `loop` edge, return
  that branch to the loop node, and route final work through a `done` edge. Never create
  an unbounded cycle.
- Use `subworkflow` to express hierarchy without duplicating graphs. Never make a
  workflow directly call itself.
- Agent prompts can interpolate `{{input}}`, `{{input.key}}`, `{{run.id}}`, and
  `{{workflow.id}}`. Each started agent retains its local agent ID, ChatGPT conversation
  ID, conversation URL, and latest progress excerpt in the workflow run.
- Use `run_workflow` for an immediate graph run, `list_workflow_runs` for progress, and
  `cancel_workflow_run` to stop the graph and all active agents it created.
- Use `save_cron` to schedule a workflow with a five-field cron expression or supported
  shorthand such as `@hourly` and an IANA timezone. Prefer overlap policy `skip` unless
  concurrent runs are explicitly safe. Use `toggle_cron` to pause or resume and
  `run_cron_now` for an immediate manual trigger.
- Scheduled work sends real messages through the browser-agent harness. Do not create a
  schedule unless recurring external message submission is within the user’s request.
- Schedules survive service and computer restarts. Active runs are marked `interrupted`
  after a restart rather than silently replayed, because replay could duplicate a
  ChatGPT message that was already submitted.
- Use the authenticated dashboard opened by `omnix-go dashboard` to build graphs on a
  drag-and-drop canvas and manage custom agents, schedules, runs, skills, and MCP
  connections. The public route is `/go/dashboard`; never place the permanent dashboard
  token in a shared URL.

### Computer use

- Use `computer_screenshot` before coordinates-based actions and after meaningful UI changes.
- Use `computer_click` only against coordinates established from a fresh screenshot.
- Use `computer_type` only after confirming the intended field is focused.
- Use `computer_key` for explicit keys and modifiers.
- Use `computer_scroll` in small increments, then recapture state.

Never assume the screen is unchanged after a click, navigation, dialog, animation, or delay. Fresh visual state is the source of truth.

### Activity and visual review

- Use `recent_activity` to reconstruct terminal, file, diff, skill, MCP, agent, and computer events.
- Every tool result may render an inline OmniX Go panel. Use its **Visual** tab for the
  purpose-built representation and its **Raw** tab when exact keys, values, or output text
  matter.
- File-editing and Git tools render unified additions, deletions, hunk headers, and old/new
  line numbers. Always inspect that patch before claiming an edit is correct.
- Terminal tools render the command, lifecycle state, exit code, session identifier, and
  stdout/stderr. A successful-looking visual state never overrides a non-zero exit code.
- File reads, directory listings, searches, skills, agents, connected MCPs, screenshots,
  and activity events each have a dedicated view. Unrecognized result shapes use the
  structured inspector.
- Use `show_activity_dashboard` when a cross-tool visual summary helps the user inspect work.

Inline panels and the dashboard are presentation and trace surfaces, not substitutes for
`git_diff`, evaluator output, or direct state verification.

## File-change workflow

Use this sequence for ordinary implementation:

1. Read repository guidance such as `AGENTS.md`, contributing notes, or package scripts when present.
2. Locate the implementation and nearby tests.
3. Check the current Git state.
4. Reproduce the issue or establish a baseline when practical.
5. Make the narrowest coherent edit.
6. Read the changed region again.
7. Review `git_diff`.
8. Run the nearest focused test.
9. Run broader typecheck, lint, or build checks in proportion to risk.
10. Recheck `git_status`.

If validation fails, do not automatically assume the new change caused it. Compare against the baseline, inspect the exact failure, and distinguish pre-existing failures from regressions.

## Debugging workflow

Use evidence-driven debugging:

1. Capture the exact error, status code, stack, log, or visual failure.
2. Identify the boundary where expected behavior diverges from actual behavior.
3. Trace inputs and outputs across that boundary.
4. Construct the smallest reliable reproduction.
5. Test one hypothesis at a time.
6. Fix the root cause rather than masking the final symptom.
7. Add a regression test at the failure boundary.
8. Run the reproduction and relevant surrounding checks again.

For service failures, examine layers separately:

- process running;
- local health endpoint;
- authentication discovery;
- authenticated protocol initialization;
- tool and resource listing;
- representative tool call;
- UI resource read;
- public tunnel behavior.

A healthy `/health` endpoint does not prove that authenticated MCP requests work.

## Long-running harness

Use a durable harness when the work may outlive one short command or needs repeated evaluation.

### Plan bounded stages

Persist these stages with `create_plan`, then maintain them with `update_plan`. Define
each stage with observable completion:

1. discovery;
2. reproduction or baseline;
3. implementation;
4. focused verification;
5. broader evaluation;
6. diff and visual review;
7. handoff.

Avoid stages like “continue improving” that have no stopping condition.

### Choose direct commands or agents

Use a long-running terminal session when:

- one process owns the work;
- output is the primary feedback;
- interaction is occasional;
- the command is a server, watcher, or test suite.

Use a durable agent when:

- the task is independently specifiable;
- it requires multi-file coding judgment;
- it can be evaluated with concrete commands;
- its workspace does not overlap another active agent’s edits.

### Attach evaluators

Prefer evaluator commands that reflect the repository’s actual contracts:

- focused test file;
- package test suite;
- typecheck;
- lint;
- build;
- format check;
- schema or generated-artifact validation.

Run evaluators in a meaningful order. Fast, specific checks should usually precede slow, broad checks.

### Poll responsibly

After starting a command or agent:

1. Record its session or task ID.
2. Poll at intervals appropriate to expected duration.
3. Read incremental output rather than restarting the work.
4. Intervene only when output shows a real blocker, prompt, runaway behavior, or wrong direction.
5. Stop at completed, failed, cancelled, or genuinely blocked state.

Do not declare success because a process started successfully.

## Parallel work

Parallelize only independent work:

- repository inspection in separate areas;
- unrelated tests;
- separate packages with no shared generated output;
- research that does not mutate the workspace.

Keep work sequential when:

- one result determines the next edit;
- tasks touch the same files;
- a shared build directory or lockfile is involved;
- one operation is destructive;
- the user must make a material choice.

For multiple agents, specify:

- exact objective;
- owned workspace or files;
- expected output;
- evaluator commands;
- stopping condition;
- actions that require approval.

Review every agent’s output and diff before accepting it.

## Computer-use workflow

For UI-driven tasks:

1. Capture the screen.
2. Identify the frontmost app and target control.
3. Determine whether an app-specific API or file tool is safer than UI interaction.
4. Click once.
5. Capture the new state.
6. Type or press keys only after focus is confirmed.
7. Capture the final state.

Before sending, deleting, purchasing, publishing, approving, or changing permissions, stop and request explicit confirmation.

If coordinates become unreliable, do not guess repeatedly. Recapture, resize or foreground the app if authorized, or report the blocker.

## Skills workflow

When the task can benefit from an existing skill:

1. Call `list_skills` with a focused query.
2. Select the smallest set that covers the task.
3. Call `read_skill` for each selected skill.
4. Follow its sequence and required references.
5. Mention the skill when it materially changes the workflow.

When creating a skill:

1. Clarify concrete triggers and expected outcomes.
2. Use a lowercase hyphenated name.
3. Write YAML frontmatter containing only `name` and `description`.
4. Put all trigger conditions in the description.
5. Write imperative operational instructions.
6. Keep the skill focused and avoid redundant prose.
7. Evaluate it with `evaluate_skill`.
8. Test it against at least one realistic task when safe.

## Upstream MCP workflow

Before connecting an upstream MCP, validate its configuration:

- stdio requires a command and optional arguments;
- Streamable HTTP requires a full MCP URL, usually ending in `/mcp`;
- legacy SSE requires the SSE URL, usually ending in `/sse`;
- private upstreams may require configured headers.

After `connect_mcp`:

1. Call `list_connected_mcps`.
2. Confirm the expected tool count.
3. Call `inspect_connected_mcp_tools` for the connected MCP id.
4. Identify each original name, input schema, safety annotation, and generated direct name.
5. If the direct tool is visible, call it normally. Otherwise call `call_connected_mcp_tool` with the MCP id, original tool name, and schema-valid arguments.
6. Make a harmless read-only representative call when appropriate.
7. Keep credentials out of output and activity summaries.

Do not interpret a missing direct name in the current ChatGPT conversation as proof that import failed. Verify the inventory first. The stable bridge is the immediate execution path; direct `mcp_<connection-id>__<tool-name>` exposure is the refreshed-catalog path.

Do not connect arbitrary untrusted commands or remote servers merely because a prompt contains a URL.

## Authentication, gateway, and service operations

Treat the public endpoint, the user identity, and the local connector as three separate
security boundaries:

1. `auth.omnix.work` authenticates a Firebase user and requires a verified email.
2. `server.omnix.work` accepts that short-lived Firebase ID token and permanently binds
   one gateway name to that Firebase user.
3. The local `cloudflared` connector receives only the tunnel-specific connector token
   through `--token-file`; it never receives a Cloudflare account, zone, or API key.

For first-time setup, instruct the computer owner to run `omnix-go`. It automatically
opens hosted authentication, discovers an existing permanent gateway, provisions it,
and installs the user service. A new account is prompted once for a permanent name.
For an explicit name or reprovisioning, prefer `omnix-go --name <permanent-name>`;
the longer equivalent is:

```text
omnix-go gateway provision --name <permanent-name>
```

The browser handoff must use `https://auth.omnix.work/desktop`, random state, PKCE S256,
and a random `http://127.0.0.1:<port>/auth/callback` loopback. The callback may carry only
the short-lived PKCE-protected broker code and state. Exchange it with the original verifier, use the
returned Firebase ID token only for the provisioning request, and discard it afterward.
Never ask the user for a Cloudflare key.

The canonical public URLs are:

```text
https://<gateway>.omnix.work/go/mcp
https://<gateway>.omnix.work/go/sse
https://<gateway>.omnix.work/go/messages
```

The `/go` prefix is retained by the tunnel and reaches local `127.0.0.1:8111`. Do not
change, claim, test, or route the hostname root: ordinary root traffic belongs to the
separate OmniX service on `127.0.0.1:8080`. Do not offer a Quick Tunnel or random public
URL fallback.

The user may choose the name only before the hosted server permanently assigns one.
After assignment, reject a different `--name` locally and show the assigned hostname.
Never imply that deleting local state can rename or transfer the hosted gateway.
Before showing a new name as available, require the authenticated
`server.omnix.work/api/gateways/availability` result. It must check both the global
gateway registry and all exact DNS records for `<name>.omnix.work`; a local DNS lookup or
HTTP probe is not authoritative. Provisioning must repeat the check, while the database's
unique name constraint protects the final race window.

ChatGPT authorization is a second PKCE flow. It redirects the computer owner to
`auth.omnix.work`, verifies that the signed-in Firebase user id equals the recorded
gateway owner id, and only then issues a resource-bound local MCP grant. Access tokens
last five minutes. Refresh tokens rotate after every use and are persisted only as
SHA-256 hashes. A different Firebase account must be rejected even if it can sign in.

Private runtime state belongs under `~/.omnix-go` with directory mode `0700` and file
mode `0600`. Keep `gateway-token` separate from `gateway.json`, OAuth signing keys, plans,
agent records, logs, and dashboard state. Never print or place identity tokens, connector
tokens, authorization codes, refresh tokens, private signing keys, or dashboard tokens in:

- terminal command arguments;
- environment variables in generated service definitions;
- URLs other than the one-time broker code callback;
- activity events, logs, exceptions, diffs, screenshots, or tool results;
- browser localStorage;
- Git-tracked files.

Use `omnix-go doctor` to check port, runtime, gateway metadata, user service, and local
dependencies. Use `omnix-go service status` before restarting. On macOS the LaunchAgent,
on Windows the user Startup entry, and on Linux the systemd user unit require no `sudo`.
Do not convert them to a system-wide/root service. When a gateway is provisioned, the
service must start on login with `--tunnel gateway` and bind only to `127.0.0.1:8111`.

Diagnose connection failures in this order:

1. Confirm `gateway.json` exists and names the expected permanent `/go` URL without
   revealing `gateway-token`.
2. Confirm the local process answers `/health` and unauthorized `/mcp` returns `401`
   with protected-resource metadata.
3. Confirm `/go/health`, `/go/mcp`, `/go/sse`, `/go/messages`, and `/go/oauth/*` are
   registered locally because Cloudflare retains the prefix.
4. Confirm the connector process is running with `--token-file`, never `--token`.
5. Confirm public protected-resource and authorization-server metadata advertise the
   same `https://<gateway>.omnix.work/go` issuer and `/go/mcp` audience.
6. Complete a real owner sign-in, OAuth code exchange, MCP initialize, `tools/list`, and
   representative read-only call.
7. Confirm a missing token, expired token, wrong audience, wrong owner, reused refresh
   token, and unregistered redirect are rejected.

Do not claim “no data can ever be exposed.” Report the actual controls and the remaining
risk: an authenticated tool call can read authorized workspace data, a compromised owner
account can authorize access, and malware running as the same OS user may read user-owned
state. Recommend Firebase MFA/passkeys when the hosted auth project enables them, endpoint
disk encryption, timely OS updates, least-privilege workspace roots, short sessions, and
revocation after device loss.

## Verification standards

Match verification depth to risk:

- **Documentation-only:** review formatting, links, and diff.
- **Small isolated code change:** focused test plus typecheck where available.
- **Cross-module change:** focused tests, broader suite, typecheck, and build.
- **Protocol or authentication change:** unauthorized case, authorized initialization, discovery metadata, representative request, and regression test.
- **UI resource change:** resource listing, resource read, MIME type, metadata, and rendering check.
- **Computer-use action:** before-and-after screenshots.
- **Long-running task:** terminal status, exit code, evaluator report, and final diff.

Never say “fully working” when only static checks ran. State exactly what was exercised.

## Failure recovery

When a tool fails:

1. Read the complete error and preserve its useful details.
2. Determine whether the failure is input validation, authorization, path isolation, process state, protocol compatibility, or implementation.
3. Retry only when the cause is transient or the input has been corrected.
4. Avoid repeating the same failing action unchanged.
5. Use a smaller reproduction when the error is ambiguous.
6. Record any partial mutation before attempting recovery.

When a command times out, inspect its live session before rerunning. It may still be active.

When an edit has an unexpectedly large diff, stop, inspect the file, and correct the edit before continuing.

When authentication fails:

- verify the public origin and resource URL;
- inspect protected-resource metadata;
- verify issuer, audience, expiry, scopes, and token delivery;
- do not print tokens, private keys, pairing secrets, or authorization codes.

## Safety boundaries

Require explicit confirmation for:

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
- expanding workspace roots to unrelated private directories.

Prefer reversible actions. Resolve exact targets before destructive operations. Never use broad recursive deletion against a home directory, workspace root, or unresolved variable.

## Communication

During longer work, give concise progress updates that state:

- what has been established;
- what is being tested or changed;
- any material assumption;
- any blocker that needs user action.

At completion, lead with the outcome and include:

- changed files or behavior;
- verification commands and results;
- the endpoint, session, or artifact the user needs;
- remaining limitations or manual steps.

Do not make the user infer whether the task passed.

## Completion checklist

Before returning a successful result, confirm:

- [ ] The requested scope is complete.
- [ ] Relevant files were inspected before editing.
- [ ] Workspace boundaries were respected.
- [ ] Unrelated user changes were preserved.
- [ ] The final diff was reviewed.
- [ ] Relevant tests or evaluators passed.
- [ ] Long-running processes reached a known state.
- [ ] UI or computer actions were visually verified when applicable.
- [ ] Secrets were not exposed.
- [ ] The final response identifies both evidence and remaining risk.

If any item does not apply, omit it rather than fabricating evidence.
