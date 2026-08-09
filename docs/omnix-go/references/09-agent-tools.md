# OmniX Go — Durable agents and evaluators

For work that may outlive one short command or needs repeated evaluation, use durable
agents (`codex` subagents) with attached evaluator commands. History persists in
`~/.omnix-go/tasks/` and survives restarts.

## `start_agent`

| Field | Constraints |
|---|---|
| `prompt` | string ≥ 10 chars, required — fully self-contained objective |
| `workspace` | string, optional — which allowed workspace |
| `model` | string, optional |
| `evaluationCommands` | array ≤ 20, optional — commands that must pass |

Returns immediately with a `taskId`. The prompt must be independently executable: exact
objective, owned files, expected output, stopping condition, and any approval gates —
the agent cannot ask clarifying questions mid-flight.

## `agent_status`

`{ taskId: UUID }` — durable status, output, and evaluator results for one task.

## `list_agents`

`{}` — queued, running, completed, failed tasks with history.

## `cancel_agent`

`{ taskId }` — cancel queued/running work. Only when cancellation is requested or
continuing is clearly harmful.

## `evaluate_workspace`

| Field | Constraints |
|---|---|
| `workspace` | string, optional |
| `commands` | array of 1–20 commands, required — ordered |

Run ordered test/lint/typecheck/build/validation commands; returns a pass/fail report.

## When to use an agent vs direct tools

**Use a durable agent when:**
- the task is independently specifiable;
- it requires multi-file coding judgment;
- it can be evaluated with concrete commands;
- its workspace does not overlap another active agent's edits.

**Use direct tools or a long-running terminal session when:**
- one process owns the work;
- output is the primary feedback;
- interaction is occasional;
- the command is a server, watcher, or test suite;
- the task is a one-line edit or needs constant shared judgment.

## Evaluator discipline

- Prefer evaluators that reflect the repository's actual contracts: focused test file,
  package test suite, typecheck, lint, build, format check, schema validation.
- Order matters: fast specific checks first, slow broad checks later.
- A task is complete only when Codex exits successfully AND every evaluator passes.
- Service restarts preserve completed history and mark interrupted jobs clearly.

## Parallel agents

Parallelize only independent work: separate areas, unrelated tests, separate packages
with no shared outputs, pure research. Keep sequential when one result determines the
next edit, files overlap, or a shared build directory/lockfile exists. For each agent
specify exact objective, owned files, expected output, evaluators, stopping condition,
and approval gates. Review every agent's output and diff before accepting it.
