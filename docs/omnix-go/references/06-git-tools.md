# OmniX Go — Git tools

Git tools operate inside allowed workspaces. The inline UI renders unified diffs with
hunk headers and old/new line numbers.

## `git_status`

`{ cwd? }` — short Git status. Call it:
- before editing (know the starting state);
- before final handoff (know what changed).

A dirty worktree belongs to the user unless the task clearly establishes otherwise —
never discard unrelated modifications.

## `git_diff`

| Field | Constraints |
|---|---|
| `cwd` | string, optional |
| `staged` | bool, optional — only when reviewing staged changes |
| `path` | string, optional — narrow to one file/directory |

Review the diff **after every edit**, and before claiming an edit is correct. Look for:
- unintended deletions or reformatting;
- secret material in the diff;
- changes outside the requested scope.

## `apply_patch`

| Field | Constraints |
|---|---|
| `cwd` | string, optional |
| `patch` | string, ≥ 1 char, required — unified diff |
| `checkOnly` | bool, optional — validate without applying |

- The patch is validated before application; malformed hunks are rejected.
- Use for focused multi-file changes where several `edit_file` calls would be fragile.
- Use `checkOnly: true` first when you are unsure the patch matches the current files.
- Generate patches from actual `git diff` output so line numbers and context are correct.

## Git workflows

**Standard change cycle:**

```
git_status            # starting state
read/edit files
git_diff              # review exact change
run focused tests
git_status            # final state
```

**Multi-file focused change:** assemble edits as a unified patch → `apply_patch`
(with `checkOnly: true` first on doubt) → `git_diff` review → evaluators.

**Never** discard unrelated modifications, reset to a branch state, or force-push without
explicit confirmation. When a diff is unexpectedly large, stop and inspect before continuing.
