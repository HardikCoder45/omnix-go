# OmniX Go — Local skill tools

OmniX Go scans skill roots (`~/.codex/skills`, `~/.claude/skills`, `~/.agents/skills`,
`~/.config/skills` — configurable) for `SKILL.md` files and their sibling files.

## `read_omnix_go_guide`

`{}` — the built-in operating guide for the harness itself. Read it before complex,
long-running, unfamiliar, risky, multi-tool, or computer-use work. It is also exposed as
the `omnix-go://guide/SKILL.md` MCP resource.

## `list_skills`

`{ query? }` — list/search discovered skills with validity warnings. Use a focused query
term; choose the smallest set that covers the task.

## `refresh_skills`

`{}` — rescan all skill roots when the inventory may have changed (a skill was installed
or edited mid-session).

## `read_skill`

`{ skill, file? }` — read `SKILL.md` (or another file of the skill) **completely** before
following it. If it references required local files, read those too. Do not claim a skill
was used when it was only listed.

## `evaluate_skill`

`{ skill }` — structural quality checks: frontmatter present, name present, description
≥ 20 chars, source ≤ 100 KB, instructions ≥ 20 words. Returns a score and check list.
Run this after authoring a skill.

## `make_skill`

| Field | Constraints |
|---|---|
| `name` | string, ≥ 2 chars — lowercase, hyphenated |
| `description` | string, ≥ 20 chars — must encode ALL trigger conditions |
| `instructions` | string, ≥ 40 chars — imperative operational instructions |
| `root` | string, optional — which skill root to create in |

Authoring workflow:

1. Clarify concrete triggers and expected outcomes.
2. Use a lowercase hyphenated name.
3. YAML frontmatter containing only `name` and `description`.
4. Put all trigger conditions in the description (this drives automatic selection).
5. Write imperative instructions, not prose.
6. Keep the skill focused; avoid redundant content.
7. Evaluate it with `evaluate_skill`.
8. Test it against at least one realistic task when safe.

## Discovery mechanics

- Skills are found at `**/SKILL.md` under each root (up to depth 8); sibling files are
  indexed (up to 250) so `read_skill { skill, file }` can fetch them.
- `valid: false` with warnings means the SKILL.md failed structural checks — prefer valid
  skills unless the task forces otherwise.
- Newly installed skills require `refresh_skills` (and a fresh conversation, since the
  client caches the catalog).
