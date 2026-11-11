# 0874. The UI kit is a shadcn-svelte registry an app copies from

- **Status:** Proposed
- **Date:** 2026-11-11
- **Unbuilt:** no `registry.json`, build script, or `/r/` route exists, and `app.css` still holds the monorepo `@source` lines. Built: the check that every stock component is upstream's text plus at most one patch (`packages/ui/scripts/upstream.ts`, `packages/ui/upstream/README.md`).
- **Relates:** [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (an app's view), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (`epicenter` supplies `@epicenter/app`), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (`@epicenter/ui` is not published), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (an app's code is its own repository, and the Studio's apps are the source).

## Context

`packages/ui` is the house kit: shadcn-svelte's `vega` style, a theme, and
components of our own. Monorepo apps import it as `@epicenter/ui/<name>`
through a `workspace:` link. An app in an Epicenter cannot: the live apps
carry a prebuilt `ui/dist` and no `ui/package.json`, because their views only
build inside the monorepo. Under ADR-0877 those apps become the source of
their starters, so their views have to build where they live.

A stock component is checked against what `shadcn-svelte add` installs for
`vega` with Lucide icons, saved in `packages/ui/upstream/`, plus at most one
patch that opens with its reason. The kit on 2026-11-11:

| Kind | Count | Items |
| --- | --- | --- |
| Stock, upstream's text | 23 | `button`, `checkbox`, `dropdown-menu`, `field`, `input`, `item`, `textarea`, … |
| Stock with one patch | 2 | `tooltip` (300 ms delay), `sonner` (rich colors) |
| Stock, not yet rebased | 7 | `command`, `context-menu`, `dialog`, `popover`, `select`, `sidebar`, `tabs`; only apps that wait (ADR-0840) import them |
| Ours | 8 | `icon-button`, `confirmation-dialog`, `loading`, `section-header`, `copy-button`, `toast-on-error`, and `light-switch` and `link` from shadcn-svelte-extras |

Our items build on stock ones: `light-switch` is an `IconButton`, which is a
`Button` inside a `Tooltip`. Items also import shared files (`utils.ts`,
`hooks/use-clipboard`).

The theme is `app.css`: Slate light with a warm background and a darker
`--muted`, a lifted Neutral dark, `--warning` and `--success`, Geist and Geist
Mono, `prose.css`, and `styles/shadcn-base.css`. It also has `@source` lines
for sibling monorepo packages, which mean nothing outside the monorepo.

## Decision

**`packages/ui` is published as a shadcn-svelte registry, and that registry
is the whole kit.** An app copies items into its view with
`shadcn-svelte add`, and then owns them.

- **Items.** One `registry:theme` item, `epicenter`, holds the tokens,
  `prose.css`, the base CSS and the font packages. Every component folder,
  stock or ours, is a `registry:ui` item under its own name. `utils` and each
  hook are items of their own.
- **Dependencies point at our registry.** An item names other kit items by
  our registry's URL, never by bare stock name. A stock item is then the text
  the kit was checked against, with its patch, not whatever upstream serves
  that day. An upstream release reaches an app when we refresh, check, and
  serve it.
- **One source.** `registry.json` is generated from `packages/ui/src`, and the
  monorepo keeps importing `@epicenter/ui/<name>`. What the registry ships is
  what the monorepo's apps run and what the check compared with upstream.
- **The theme item carries no monorepo paths.** The `@source` lines for
  sibling packages move out of `app.css` to the monorepo apps that need them.
- **Served as static JSON** from the Epicenter site at `/r/<item>.json`, built
  with `shadcn-svelte registry build`.
- **An app's view uses the CLI's own layout.** Copied items land in
  `src/lib/components/ui/<name>` and are imported from
  `$lib/components/ui/<name>`, the `shadcn-svelte` defaults, so the CLI and
  its documentation work unchanged. A view moving from `apps/<app>` to the
  Studio (ADR-0877) rewrites its `@epicenter/ui/` imports to that path once.

An app in an Epicenter then builds its own view:

```txt
capture/
  epicenter.ts
  package.json                dev: @epicenter/app
  ui/
    package.json              @epicenter/app, svelte, bits-ui, …
    components.json           names the Epicenter registry
    src/lib/components/ui/    copied items: button, sonner, loading, …
```

## Consequences

- A starter carries the items its view uses, copied, so it builds with no
  registry fetch. The registry is for adding an item later, which an agent
  does with one command.
- A copied component belongs to the app. An agent can change it there, and
  no update overwrites it; taking a later kit change is a fresh
  `shadcn-svelte add`, reviewed as a diff.
- A copied item carries its patched text but not the patch's reason, which
  stays in `packages/ui/upstream/patches/`.
- The seven components not yet rebased are served as they are. Each is
  rebased when an app that imports it returns.
- Items are AGPL-3.0-or-later like `packages/ui`; stock shadcn-svelte code
  inside them keeps its MIT notice. An app that copies items and is shared
  beyond its owner carries those terms.
- How a `registry:theme` item's `css` field carries an `@import` of
  `prose.css` is unverified until the registry is built. The fallback is
  inlining `prose.css` into the theme.

## Considered alternatives

- **Only our items in the registry, with stock components as bare-name
  `registryDependencies`.** With two patches left the registry would be
  small, but an outside app would get upstream's text of the day for
  twenty-three components, while our items such as `IconButton` were built
  and checked against the snapshot. The kit would stop being one checked set.
- **An `@epicenter/ui` alias in every app's view, mapped to its copied
  components** (this record's first form). A view's source was then the same
  in the monorepo and in an Epicenter, which mattered while starters were
  developed in the monorepo. Under ADR-0877 a view moves once, and the alias
  would cost a custom Svelte config in every app and an `aliases.ui` outside
  `$lib` that the CLI was never shown to accept.
- **Publish `@epicenter/ui` to npm.** One dependency line per app, but the
  components sit in `node_modules`, where an app's agent cannot change them,
  and every app moves with every release.
