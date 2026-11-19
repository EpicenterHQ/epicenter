# 0244. Epicenter speaks of apps and windows, not surfaces

- **Status:** Accepted
- **Date:** 2026-08-17
- **Relates:** [ADR-0189](0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md), [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md), ADR-0210

## Context

Epicenter had used **surface** as a host-internal word for several things that
people experience differently: an application such as Honeycrisp, a native
window, a route, and a placeholder destination. The word was abstract in the
product model and made the ordinary action harder to describe: a person opens
an app in a window.

The first pass at this record replaced `surface` with `window` everywhere the
old word had stood, which moved the ambiguity rather than removing it. `window`
then named three things at once: the closed set of built-in products, the route
table, and the native frame. The tell was that `Application::Compiled` carried a
`BuiltInWindow`, so the code said an app *is* a window while this record said an
app *opens in* one, and that `BuiltInWindow` did not contain every built-in
window: Whispering's macOS recording overlay is a second native window of the
same app, created under its own label.

## Decision

**One app has zero, one, or several windows.** Three words, three layers, and no
word does two jobs:

- **app** is the product a person opens, installs, switches to, and returns to.
  It is the noun in every ID space: `/apps/<id>/`, `epicenter://app/<id>`, the
  list Home shows, and `apps/<app-id>` under the data root (ADR-0201).
- **window** is a native frame and only that. It is what opens, focuses, hides,
  and closes, and it is the unit Tauri grants authority to, which is why every
  file in `src-tauri/capabilities/` selects windows by label.
- **route** is a URL. `BUILT_IN_ROUTES` is Bun's table of them.

The host's closed built-in set is `BuiltInApp`, because it names products.
`is_launchable` says which of them Home offers: every variant is an app, and
Home is absent from the list only because you are already looking at it, not
because it is above the others or outside the category (ADR-0209). There is no
host-specific `Surface` type, route table, function family, or deep-link
protocol.

The deep-link protocol is `epicenter://app/<id>`. It is the same ID space as
`/apps/<id>/` on purpose: a person pasting a link names the thing they want, not
the frame it arrives in. Neither retired spelling, `epicenter://surface/<id>`
nor `epicenter://window/<id>`, is retained as a compatibility alias, and both
are pinned as refusals by test. Widening the link to admitted catalog members
later needs no new grammar, because an admitted app's ID always carries a dot
and every built-in ID is a bare label (ADR-0210).

Code keeps the long form (`Application`, `listApplications`,
`COMPILED_APPLICATIONS`); what a person reads is **app**. Generic technical
phrases such as API surface or tool surface are unrelated and remain ordinary
English where they name an actual interface, including a synchronous read
surface over a store.

## Consequences

- Home can honestly say that it lists and launches apps.
- Honeycrisp is described as an app that opens in its own window.
- Whispering's recording overlay is describable: a second window of one app.
  So is a second Honeycrisp window, whenever one is wanted, under a
  `honeycrisp-*` capability glob.
- `window` never leaves the Tauri layer, so a future mobile layout with no
  windows inherits `app` and nothing else.
- The `/apps/<id>/` URL namespace remains unchanged, and the deep link now
  matches it.
- The host code has one explicit name for its closed built-in app set rather
  than a vague umbrella term that combines product, route, and presentation.
- Both old deep-link spellings are deliberately deleted rather than supported by
  a fallback parser or compatibility alias.

## Considered alternatives

- **Keep `surface` as a host-only noun.** Rejected: the host's actual objects are
  a closed set of products and the windows it opens for them, and retaining the
  old noun would leave the ambiguity in the implementation even after removing
  it from product language.
- **Name the closed set `BuiltInWindow`.** Rejected after living with it, for
  the reasons in Context: it overclaims (the overlay is a built-in window and is
  not in it), and it makes the code contradict the sentence this record exists
  to protect.
- **Name the closed set `BuiltInRoute`, matching Bun exactly.** This is coherent
  and was close. Rejected because the variants name products that Home lists and
  that own directories and workspaces; a route is what one of them is served
  from, not what it is. It would also have left `is_launchable` hanging off a
  route.
- **Use `destination` everywhere.** Rejected: it describes navigation to a
  place, not a durable app with its own data and lifecycle, it collides with the
  routing vocabulary already in `routes.ts`, and it would force a second term
  for the native window that actually persists.
- **Use `workspace`, `tool`, or `view`.** All three are already spent:
  `workspace` is an app's declaration and identity (ADR-0240, ADR-0243), `tool`
  is the MCP catalog in `src/host.ts`, and ADR-0209 uses `view` for what an app
  *is* over data.
- **Accept `app` without noting the collision.** `Epicenter.app` is itself an
  app, containing apps that the OS does not see as apps. Accepted rather than
  solved: every super app pays this, no candidate word avoids it, and the
  alternatives cost more than the ambiguity does.
