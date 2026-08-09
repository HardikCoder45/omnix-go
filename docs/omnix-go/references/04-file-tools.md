# OmniX Go — File tools

All file tools are confined to workspace roots returned by `workspace_roots`; symlink
escapes are rejected. Diffs are returned for every mutation — inspect them.

## `workspace_roots`

`{}` — list the only directories file and command tools may access. Call it at the start
of every task and after any session boundary.

## `read_file`

| Field | Constraints |
|---|---|
| `path` | string, required |
| `startLine` | positive int, optional |
| `endLine` | positive int, optional |

- Use for precise source inspection; request a line range for large files
  (`read_file { path, startLine: 120, endLine: 180 }`).
- Reads are UTF-8 only; binary files are not supported — use a terminal command for those.
- Read a file again after editing it to confirm the change landed correctly.

## `list_directory`

| Field | Constraints |
|---|---|
| `path` | string, required |
| `depth` | int 1–8, optional |
| `includeHidden` | bool, optional |

- Start shallow (depth 1–2) and increase only when needed.
- Respect `includeHidden` — hidden config matters for tooling, ignore it only if the task says so.

## `search_files`

| Field | Constraints |
|---|---|
| `directory` | string, required |
| `pattern` | regex, required |
| `glob` | optional file filter (e.g. `*.ts`, `**/*.test.*`) |
| `maxResults` | int 1–1,000, optional |

- The pattern is a regex — escape literal dots (`\\.`), use word boundaries for symbols.
- Example: `{ directory: "src", pattern: "\\bRouter\\b", glob: "*.ts" }`.
- Truncated results are flagged; narrow the glob or directory before assuming completeness.

## `write_file`

| Field | Constraints |
|---|---|
| `path` | string, required |
| `content` | string, required |
| `createDirectories` | bool, optional |

- Atomically creates or replaces a UTF-8 file; returns a unified diff.
- Use for new files or intentional full rewrites. Do NOT use to patch one line of a
  5,000-line file — use `edit_file`.
- Set `createDirectories: true` when the parent path may not exist.
- Confirm the diff shows exactly the intended content, then re-read the file.

## `edit_file`

| Field | Constraints |
|---|---|
| `path` | string, required |
| `oldText` | string, ≥ 1 char, required |
| `newText` | string, required |
| `replaceAll` | bool, optional |

- Replaces an exact text fragment. `oldText` must match the file byte-for-byte (watch
  indentation and line endings).
- Use `replaceAll` only when every occurrence must change — otherwise the match set must
  be unique. If a match fails or is ambiguous, read the exact region first.
- An unexpectedly large diff means the `oldText` matched more than intended: stop, inspect,
  and redo the edit with a longer anchor.

## Common patterns

**Create a file:** `write_file` with `createDirectories: true`.

**Update one function:** `read_file` the function → `edit_file` a precise anchor →
re-read the region.

**Rename across the repo:** `search_files` to find every reference → `edit_file`
per site (or `apply_patch` from the Git tools for a multi-file change).

**Never:** write whole files to delete a stray line; guess indentation instead of reading;
edit generated artifacts (dist/, build/) unless the task targets them explicitly.
