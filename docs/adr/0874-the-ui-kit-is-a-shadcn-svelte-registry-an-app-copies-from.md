# 0874. The UI kit is a shadcn-svelte registry an app copies from

- **Status:** Proposed
- **Date:** 2026-11-11
- **Relates:** [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (an app's view), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0873](0873-the-command-is-epicenter-cli-and-an-app-builds-against-epicenter-app-released-together.md) (`@epicenter/app` on npm), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (`@epicenter/ui` is not published).

## Context

`packages/ui` is the house kit: shadcn-svelte's `vega` style, a theme, and
components of our own. Monorepo apps import it as `@epicenter/ui/<name>`
through a `workspace:` link. An app in an Epicenter cannot: the live apps
carry a prebuilt `ui/dist` and no `ui/package.json`, because their views only
build inside the monorepo.

The kit has about 43 component folders (survey of `packages/ui/src` against
the saved upstream responses in `packages/ui/upstream/`, 2026-11-11):

| Kind | Count | Examples |
| --- | --- | --- |
| Stock `vega`, unchanged | 8 | `checkbox`, `label`, `progress`, `skeleton`, `toggle` |
| `vega`, changed by us | about 26 | `button` (`tooltip`, `ghost-destructive`), `input` and `textarea` (release their binding when destroyed), `sonner` (`toastOnError`), `tabs` (unmount inactive content), `alert` and `badge` (`warning`, `success`) |
| Ours, or from shadcn-svelte-extras | 9 | `confirmation-dialog`, `loading`, `markdown`, `modal`, `chat`, `copy-button`, `light-switch`, `link`, `section-header` |

Our items depend on our changed components: `light-switch` passes `tooltip`
to `Button`, which stock `Button` does not take. Items also import shared
files (`utils.ts`, `hooks/use-clipboard`, `hooks/use-auto-scroll`).

The theme is `app.css`: Slate light with a warm background and a darker
`--muted`, a lifted Neutral dark, `--warning` and `--success`, Geist and Geist
Mono, `prose.css`, and `styles/shadcn-base.css`. It also has `@source` lines
for sibling monorepo packages, which mean nothing outside the monorepo.

## Decision

**`packages/ui` is published as a shadcn-svelte registry, and that registry
is the whole kit, not a delta on stock.** An app outside the monorepo copies
items into its view with `shadcn-svelte add`, and then owns them.

- **Items.** One `registry:theme` item, `epicenter`, holds the tokens,
  `prose.css`, the base CSS and the font packages. Every component folder,
  stock or changed, is a `registry:ui` item under its own name. `utils` and
  each hook are items of their own.
- **Dependencies point at our registry.** An item names other kit items by
  our registry's URL, never by bare stock name, so `light-switch` brings our
  `button`. The registry is consistent with itself, and an upstream release
  changes nothing until we take it.
- **One source.** `registry.json` is generated from `packages/ui/src`, and the
  monorepo keeps importing `@epicenter/ui/<name>`. What the registry ships is
  what the monorepo's apps run.
- **The theme item carries no monorepo paths.** The `@source` lines for
  sibling packages move out of `app.css` to the monorepo apps that need them.
- **Upstream stays a baseline.** `packages/ui/upstream/` keeps the saved
  `vega` and extras responses, and a change we make to a stock component is
  a diff against them, as now.
- **Served as static JSON** from the Epicenter site at `/r/<item>.json`, built
  with `shadcn-svelte registry build`.
- **An app's view imports the kit by the same path in both places.** An app
  folder maps `@epicenter/ui` to its copied components (`src/lib/ui`) in its
  Svelte config. The view's source is then the same in the monorepo and in
  an Epicenter, and a starter needs no rewrite when it leaves the monorepo.

An app in an Epicenter then builds its own view:

```txt
capture/
  epicenter.ts
  package.json          dev: @epicenter/app
  ui/
    package.json        @epicenter/app, svelte, bits-ui, …
    components.json     names the Epicenter registry
    svelte.config.js    @epicenter/ui → src/lib/ui
    src/lib/ui/         copied items: button, sonner, loading, …
    dist/               built, served by epicenter serve
```

## Consequences

- A starter carries the items its view uses, copied, so it builds with no
  registry fetch. The registry is for adding an item later, which an agent
  does with one command.
- A copied component belongs to the app. An agent can change it there, and
  no update overwrites it; taking a later kit change is a fresh
  `shadcn-svelte add`, reviewed as a diff.
- Reducing our changes to stock components stays worthwhile, one component
  at a time, but it is not a precondition. Many changes are deliberate
  behaviour.
- Items are AGPL-3.0-or-later like `packages/ui`; stock shadcn-svelte code
  inside them keeps its MIT notice. An app that copies items and is shared
  beyond its owner carries those terms.
- Two things are unverified until the registry is built: that
  `shadcn-svelte add` accepts an alias outside `$lib` such as `@epicenter/ui`
  for `aliases.ui`, and how a `registry:theme` item's `css` field carries
  `@import` of `prose.css`. The decision does not depend on either: the
  fallback is `$lib/components/ui` with a one-line import rewrite when a
  starter leaves the monorepo, and inlining `prose.css` into the theme.

## Considered alternatives

- **Only our items in the registry, with stock components as bare-name
  `registryDependencies`.** Smallest registry, but about 26 of the kit's
  components differ from stock, and our items rely on those differences. An
  outside app would get a `button` without `tooltip`.
- **Revert every change to stock first, then publish only our items.** It
  makes the registry a small delta, but it trades away behaviour the apps rely
  on (bindings released on destroy, `toastOnError`, `tabs` unmounting) for a
  smaller list, and it blocks the registry on a long migration.
- **Publish `@epicenter/ui` to npm.** One dependency line per app, but the
  components sit in `node_modules`, where an app's agent cannot change them,
  and every app moves with every release.
</content>
</invoke>
