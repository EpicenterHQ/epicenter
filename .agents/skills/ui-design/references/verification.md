# Verify the running interface

Source, types, and tests describe what the code should do. The running
interface shows what a person sees and gets. Check a change where it is used,
in a version that contains it, before calling it done.

## Choose the evidence the change needs

- For changes to layout, spacing, color, type, overflow, visibility,
  or a new or restyled surface, including a one-line CSS fix, capture
  screenshots of the running app and look at them. Fix what looks wrong, then
  capture and look again.
- For changes to an interaction, state transition, focus, keyboard
  path, navigation, or save, exercise the changed journey as a person would and
  observe the result. A screenshot shows one moment; it cannot establish that
  an action works, that data survives a reload, or that hardware responds. Add
  screenshots when the journey also changes how things look.
- For changes to a desktop app's UI or native behavior, including shared UI,
  Tauri commands, native windows or menus, and shell capabilities, exercise it in the
  actual native desktop app running current code; see
  [the desktop app](#the-desktop-app).
- For backend, CLI, library, or test-only edits with no UI or native behavior
  changes, use the behavioral checks that code calls for. Screenshots of
  an unchanged screen add nothing.

Capturing a screenshot is not looking at it. DOM queries, accessibility
snapshots, computed-style assertions, and saved but unopened images describe
structure, not appearance. They are useful checks; they do not replace viewing
the rendered result.

## Pick the views

Choose the sizes, themes, data, and states where this change could look or
behave wrong, not a fixed matrix. A truncation fix needs the narrow width and
the longest realistic content. A new empty state needs empty data. A theme
token change needs each theme that uses it. Include the neighboring view most
likely to regress. Prefer disposable local data when the journey writes state.

Confirm the running instance contains the change. Reload or restart after
editing, and make sure the dev server or build serves the current checkout
rather than a stale process or another worktree.

## Use the tools the session provides

Use the computer-use or browser tools actually available, through their
documented entrypoints. For a native desktop window, prefer computer-use tools
that drive and capture the real app. For a web surface, any tool that captures
screenshots you then view will do, including a headless script.

Start apps the repository's way: `bun dev:<app>` for a web app and
`bun dev:<app>:desktop` for a native desktop shell. The
[monorepo skill](../../monorepo/SKILL.md#dev-scripts) owns these scripts.

## The desktop app

A desktop change is verified in the desktop app. The browser build, a test
that mocks `isTauri` or `invoke`, `cargo check`, and `svelte-check` each
establish their own claim: the web branch renders, the mocked contract holds,
the code compiles. None of them shows the native window, the IPC round trip,
capability grants, menus, dialogs, file access, or hardware working.

Launch the native app with current code, exercise the changed journey there,
and view screenshots of the native window for any visible change. Watch the
webview console and the Rust output for errors the journey triggers. Some
OS-owned surfaces, such as system alerts and permission prompts, can be outside
what computer-use controls. Name that step, and have the person perform it or
confirm the outcome another way, such as a process or file check.

## When a live check is unavailable

Tools differ by session and agent. When no screenshot, browser, or computer-use
tool is available, or the app fails to launch, continue the checks you can run.
Then report the specific visual or native acceptance that remains unverified
and what it should cover. A browser preview, DOM check, or successful build is
not a substitute for a desktop or visual check, so do not report one as
verifying it. A delegated worker without these tools returns that acceptance to
the agent that has them.

## Report what you observed

Say what you looked at and exercised: the app and surface, the sizes or states
you viewed, the journey you ran, and what you fixed after looking. Name the
checks you could not run. A sentence or two usually suffices; no screenshot
suite or evidence table is required.
