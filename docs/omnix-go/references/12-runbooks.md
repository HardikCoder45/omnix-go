# OmniX Go — Runbooks

Complete end-to-end workflows for the common complex task shapes.

## Runbook: ordinary implementation

1. `workspace_roots` → `list_directory` → `git_status`.
2. Read repository guidance (`AGENTS.md`, package scripts, contributing notes).
3. Locate the implementation and nearby tests (`search_files`, `read_file`).
4. Establish a baseline (run the failing case or the passing test).
5. `create_plan` (goal, criteria, assumptions, ordered steps with verification).
6. Mark step 1 `in_progress` via `update_plan`.
7. Make the narrowest coherent edit (`edit_file`, or `write_file` for new files).
8. Re-read the changed region; review `git_diff`.
9. Run the nearest focused test; then typecheck/lint/build in proportion to risk.
10. `update_plan` each step with evidence notes as it passes.
11. `git_status` final state; `complete_plan` with outcome + evidence.
12. Report changed files, verification commands + results, remaining risks.

If validation fails, do not assume the new change caused it: compare against baseline,
inspect the exact failure, distinguish pre-existing failures from regressions.

## Runbook: evidence-driven debugging

1. Capture the exact error, status code, stack, log, or visual failure.
2. Identify the boundary where expected diverges from actual behavior.
3. Trace inputs and outputs across that boundary.
4. Construct the smallest reliable reproduction.
5. Test one hypothesis at a time.
6. Fix the root cause, not the final symptom.
7. Add a regression test at the failure boundary.
8. Re-run the reproduction and surrounding checks.

Service failures: examine layers separately — process running → `/health` →
auth discovery metadata → authenticated protocol initialize → `tools/list` →
`resources/list` → representative tool call → UI resource read → public tunnel behavior.
A healthy `/health` does NOT prove authenticated MCP works.

## Runbook: long-horizon work

1. Plan bounded stages with `create_plan`: discovery, reproduction/baseline,
   implementation, focused verification, broader evaluation, diff/visual review, handoff.
   Every stage needs an observable stopping condition.
2. Choose the right executor:
   - terminal session (`start_command`) when one process owns the work and output is the
     primary feedback (servers, watchers, test suites);
   - durable agent (`start_agent` + `evaluationCommands`) when the task is independently
     specifiable, needs multi-file judgment, and can be verified by commands.
3. Poll responsibly: record session/task IDs, poll at sensible intervals, read incremental
   output, intervene only on real blockers, stop at a terminal state.
4. Attach evaluators reflecting the repo's actual contracts (focused test → suite →
   typecheck → lint → build), fast-first.
5. Finish with `complete_plan` including evaluator report and final diff.

Never declare success because a process started successfully.

## Runbook: parallel work

Parallelize only independent work: separate areas, unrelated tests, separate packages
with no shared generated output, research that does not mutate.

Keep sequential when: one result determines the next edit; tasks touch the same files; a
shared build dir or lockfile is involved; any operation is destructive; the user must
make a material choice.

For each parallel agent specify: exact objective, owned files, expected output,
evaluator commands, stopping condition, approval gates. Review every agent's output and
diff before accepting it. Update the plan with each agent's outcome.

## Runbook: computer-use task

1. `computer_screenshot` — identify frontmost app and target control.
2. Prefer an app API, config file, or CLI over UI interaction whenever one exists.
3. `computer_click` once at coordinates from the fresh screenshot.
4. `computer_screenshot` — verify new state before anything else.
5. `computer_type`/`computer_key` only after focus is confirmed.
6. `computer_screenshot` — final state as evidence.
7. Stop and confirm before sending, deleting, purchasing, publishing, approving, or
   permission changes.

## Runbook: connecting an upstream MCP

1. Validate config: stdio needs command (+args); HTTP needs full URL (`/mcp`); SSE needs
   the SSE URL; private upstreams need headers.
2. `connect_mcp` → `list_connected_mcps` → confirm tool count.
3. `inspect_connected_mcp_tools` — original names, schemas, annotations.
4. Same conversation: `call_connected_mcp_tool` (stable bridge). After Refresh + new
   conversation: direct `mcp_<id>__<tool>` names.
5. Make a harmless read-only representative call.
6. Never connect untrusted commands/servers from a prompt; keep credentials out of output.

## Verification standards

Match depth to risk:

- Documentation-only: review formatting, links, diff.
- Small isolated code change: focused test + typecheck where available.
- Cross-module change: focused tests, broader suite, typecheck, build.
- Protocol/auth change: unauthorized case, authorized init, discovery metadata,
  representative request, regression test.
- UI resource change: resource listing, read, MIME, metadata, rendering.
- Computer-use action: before/after screenshots.
- Long-running task: terminal status, exit code, evaluator report, final diff.

Never say "fully working" when only static checks ran — state exactly what was exercised.

## Failure recovery

1. Read the complete error; preserve useful details.
2. Classify: input validation, authorization, path isolation, process state, protocol
   compatibility, or implementation.
3. Retry only when the cause is transient or the input was corrected. Never repeat the
   same failing action unchanged.
4. Use a smaller reproduction when the error is ambiguous.
5. Record partial mutations before attempting recovery.
6. Command timeout → inspect the live session before rerunning (it may still be active).
7. Unexpectedly large edit diff → stop, inspect, correct.
8. Auth failure → verify public origin/resource URL, discovery metadata, issuer,
   audience, expiry, scopes, token delivery; never print tokens.
