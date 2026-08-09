# OmniX Go — Starting any non-trivial task

## The orientation sequence

For a coding or computer-use task, run these before anything else:

1. `workspace_roots` — learn the only directories you may touch.
2. `list_directory` on the relevant root (depth 1–2 first; go deeper only when needed).
3. `git_status` when the workspace is a Git repository — know the starting state.
4. `read_file` the smallest set of likely relevant files (package manifests, config,
   the module being changed, existing tests, `AGENTS.md`/contributing notes).
5. `search_files` to locate symbols, error strings, configuration, or tests.
6. Form a concise working hypothesis.
7. `create_plan` with goal, definition of done, assumptions, ordered checklist, and
   per-step verification.
8. `update_plan` to mark the first executable step `in_progress`.
9. Choose direct tools, a terminal session, or a durable agent based on the work's shape.

Do not begin by rewriting a whole file when a focused edit will work. Do not run broad
commands before locating the repository and its documented checks.

## Orientation patterns by intent

**Read repository guidance first** (when present): `AGENTS.md`, `CONTRIBUTING.md`,
`package.json` scripts, `Makefile`, `Cargo.toml`, `pyproject.toml` — the documented
test/typecheck/lint/build commands define your evaluators later.

**Find the seam, then the file:** search for the function or config key by name
(`search_files` with a regex) before reading whole files. Line-range reads keep context
small: `read_file { path, startLine, endLine }` for large files.

**Establish a baseline:** for debugging or refactoring, capture the current behavior first
— run the failing command once, or read the passing test — so regressions are
distinguishable from pre-existing failures.

**Check the worktree early:** `git_status` before edits; a dirty worktree belongs to the
user unless the task clearly says otherwise.

## Plan before mutating

Rules of thumb:

- 1–3 step trivial task → plan optional.
- Multi-step, risky, long-running, or anything with verification requirements → plan mandatory.
- The plan's goal must be specific, success criteria observable, and every step bounded
  with a verification instruction.
- Keep exactly one step `in_progress`; a completed final checkbox auto-completes the plan;
  then call `complete_plan` with outcome + evidence.

## Wrong starts to avoid

- Editing before reading the file.
- Running `npm test` or `cargo build` before reading the scripts that define them.
- Assuming the first matching file is the right file (disambiguate with context).
- Creating a plan whose steps are unverifiable (“continue improving”, “make it work”).
- Delegating orientation to an agent — orientation is cheap, sequential, and informs every later choice.
