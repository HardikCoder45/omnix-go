# OmniX Go — Computer control (macOS)

Control the local macOS screen through screenshots and synthetic input. Fresh visual
state is the source of truth — never assume the screen is unchanged after a click,
navigation, dialog, animation, or delay.

## `computer_screenshot`

`{}` — captures the current screen and identifies the frontmost application. Returns a
text summary plus the image (rendered in the inline panel).

**Call it:** before every coordinates-based action and after every meaningful UI change.

## `computer_click`

| Field | Constraints |
|---|---|
| `x` | non-negative int, required — from a FRESH screenshot |
| `y` | non-negative int, required |
| `button` | `left` \| `right`, optional |

- Click only against coordinates established from the latest screenshot.
- Click once. Then capture the new state before clicking again.

## `computer_type`

`{ text }` — type into the currently focused control. Only after confirming the intended
field is focused (via screenshot). Mind field-specific expectations: URLs, keyboard
shortcut conflicts, password fields (see safety — do not type secrets).

## `computer_key`

| Field | Constraints |
|---|---|
| `key` | string, required |
| `modifiers` | array of `command` \| `control` \| `option` \| `shift`, optional |

Explicit keys and modifiers for shortcuts (⌘S, ⌘C, Escape, arrows, Tab).

## `computer_scroll`

`{ amount }` — int between −50 and 50; positive values scroll down. Scroll in small
increments, then recapture state.

## Computer-use workflow

1. `computer_screenshot` — identify the frontmost app and target control.
2. Decide whether an app-specific API or file tool is safer than UI interaction
   (usually it is: prefer config files, CLIs, and scripts over clicking).
3. `computer_click` once.
4. `computer_screenshot` — verify the new state.
5. `computer_type` / `computer_key` only after focus is confirmed.
6. `computer_screenshot` — capture the final state.

## Hard rules

- Before sending, deleting, purchasing, publishing, approving, or changing permissions:
  **stop and request explicit confirmation**.
- If coordinates become unreliable, do not guess repeatedly. Recapture, resize or
  foreground the app if authorized, or report the blocker.
- Verify by before/after screenshots — a click that "seemed to land" is not evidence.
- Prefer non-UI paths whenever one exists; computer use is the fallback, not the default.
