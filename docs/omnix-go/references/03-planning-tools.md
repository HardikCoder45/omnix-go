# OmniX Go — Planning tools

Plans are the persistent memory of a task: goal, context, definition of done, assumptions,
and an ordered checklist with per-step verification. They survive restarts
(`~/.omnix-go/plans.json`) and render as a progress-ring board in the inline UI.

## `create_plan`

Create a persistent ordered execution plan before complex work.

| Field | Constraints |
|---|---|
| `goal` | string, 10–2,000 chars, required |
| `context` | string, ≤ 10,000, optional |
| `successCriteria` | array of 1–20 strings (3–1,000 each), required |
| `assumptions` | array of ≤ 20 strings (3–1,000 each), optional |
| `steps` | array of 1–50 objects `{ title (3–300), description (≤3,000)?, verification (≤2,000)? }`, required |

Good goal: `"Add user-settable theme selection with localStorage persistence"`.
Bad goal: `"Improve the app"` — no observable stopping condition.

Good criterion: `"toggling Theme in Settings persists across reload"`.
Bad criterion: `"Everything works"`.

Every step needs a verification instruction when possible:
`"Run npm test -- theme.test.ts and confirm the new case passes"`.

## `get_plan`

Read one plan with checklist, progress %, current step, criteria, assumptions, completion
state. `planId` optional — omitting it returns the active or latest plan. Use it before
resuming work or when context may have changed.

## `list_plans`

List plans by status: `{ status: "active" | "completed" }` (optional). Use it to inspect
prior work and avoid duplicating plans for the same goal.

## `update_plan`

| Field | Constraints |
|---|---|
| `planId` | optional UUID (defaults to active/latest) |
| `updates` | 1–50 items `{ stepId (UUID), status, note (≤2,000)? }` |
| `status` | `pending` \| `in_progress` \| `blocked` \| `completed` |
| `completionSummary` | ≤ 5,000, optional |

Rules:
- Call it immediately after meaningful progress, not at the end of the whole task.
- Keep **no more than one** step `in_progress`.
- Use `blocked` only for a concrete dependency preventing progress — then explain in the note.
- Attach evidence notes: a test result, diff review, endpoint response, or screenshot observation.
- Completing the final open checkbox **automatically completes the plan**.

Never mark a checkbox complete merely because work was attempted. A checked item means its
stated verification condition was satisfied.

## `complete_plan`

| Field | Constraints |
|---|---|
| `planId` | optional UUID |
| `outcome` | string, 3–5,000, required |
| `evidence` | array of ≤ 50 strings, optional |

Refuses while any step is pending, in_progress, or blocked. Always call it before
reporting a task finished. Include concrete evidence (command + result).

## Full plan lifecycle

```
create_plan ──> update_plan(in_progress) ──> work ──> update_plan(completed, note)
   │                                              │
   └── (final checkbox) auto-completes ───────────┘
   └── complete_plan(outcome, evidence) ───> done
```

## Plan-change discipline

If the plan changes materially mid-task, create a new plan for the new scope — never
conceal unplanned work under an unrelated checklist item. If a step is no longer needed,
mark it `completed` with a note explaining why rather than leaving it dangling.
