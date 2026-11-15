# 0909. An Epicenter's theme is one plain CSS file at its top that each app's UI links to

- **Status:** Proposed
- **Date:** 2026-11-14
- **Relates:** [ADR-0874](0874-the-ui-kit-is-a-shadcn-svelte-registry-an-app-copies-from.md) (components are copied; this replaces its theme dependency), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (sharing an app shares its code), [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (a UI rebuilds from its sources on disk), [ADR-0884](0884-an-epicenter-is-a-repository-that-lists-the-repositories-inside-it-and-init-from-rebuilds-it.md) (the Epicenter's own repository).

## Context

ADR-0874 proposed that each app outside the monorepo install a released
`@epicenter/theme` and import `@epicenter/theme/theme.css`, its lockfile
pinning the version. That file mixed the palette with Tailwind's
`@custom-variant dark` and `@theme inline`, so only a Tailwind CSS 4 build
could import it, and publishing it needed the owner's go under ADR-0875.
Meanwhile each personal app carried its own copy of the Graphite + blue
values in its `app.css`.

A palette belongs to the person, not to one app. Under ADR-0874 a change of
colors meant a release and a dependency bump in every app, and an app shared
with someone else brought its author's colors with it.

## Decision

**An Epicenter's colors and base corner radius live in `theme.css` at its top.**

```txt
~/Epicenter/
  theme.css                                 :root and .dark custom properties
  apps/vocab/                               the app's own repository
    ui/src/theme.css -> ../../../../theme.css
    ui/src/app.css                          @import "./theme.css"; @theme inline { --color-primary: var(--primary); ... }
```

- **`epicenter init` writes `theme.css` once.** Its text is
  `packages/theme/src/theme.css`, which the compiled `epicenter` carries. A
  folder that already has a `theme.css` keeps it. After that the file is the
  person's: no upgrade, `init`, `install`, `update`, or `serve` writes it, and
  the Epicenter's repository tracks it.
- **`theme.css` is plain CSS.** It declares custom properties under `:root`
  and `.dark`, such as `--radius`, `--background`, and `--primary`, and
  nothing else: no at-rules, fonts, or element rules.
- **An app's UI links to it.** `ui/src/theme.css` is the relative symlink
  `../../../../theme.css`, committed in the app's repository, and `app.css`
  imports `./theme.css`. A shared app resolves the link in the Epicenter it
  lands in.
- **The Tailwind names stay in the app.** `@custom-variant dark` and the
  `@theme inline` mappings name variables and hold no palette values. The monorepo
  imports them from `@epicenter/theme/tailwind.css`.
- **Fonts, spacing, layout, type, primitive state selectors, and components
  stay in each app.**
- **A theme edit rebuilds through the UI fingerprint.** `src/ui.ts` stats a
  link under `ui/` as the file it points to, so an edit to `theme.css`
  changes the fingerprint of every app that links it, and `serve` rebuilds
  each on its next page load, serving the last good build if one fails.

## Consequences

- Changing every app's colors is one edit to one file, with its history in
  the Epicenter's repository and one rebuild per app.
- `@epicenter/theme` stays private: no app outside the monorepo installs it.
- An Epicenter made before `init` wrote `theme.css` has none. A UI linking it
  there fails to build on the unresolved `./theme.css` and keeps its last
  build until the person adds the file; no command adds it later.
- An `apps/` entry that is a link to a folder elsewhere resolves
  `../../../../theme.css` from its real folder, not the Epicenter's top; such
  an app keeps a `theme.css` file of its own instead of the link.
- A checkout with Git's `core.symlinks` off, as on Windows by default, gets
  a text file holding the path instead of the link.
- A change to `packages/theme/src/theme.css` reaches new Epicenters only.

## Considered alternatives

- **A released `@epicenter/theme` in each app** (ADR-0874 before this). Each
  palette change is a release and a bump per app, and a shared app keeps its
  author's colors.
- **`@import "../../../../theme.css"` in `app.css`, with the Epicenter's
  `theme.css` added to every UI's fingerprint.** It resolves the same file but
  adds an input to `src/ui.ts` that every app pays for, and nothing in the
  app's file list shows the dependency.
- **`epicenter` copying `theme.css` into each app before a build.** Two
  copies drift, and `epicenter` would write into an app's code.
