# @epicenter/theme

The Graphite + blue palette Epicenter interfaces share: light and dark color
variables and the base corner radius, in plain CSS. A Tailwind CSS 4 build
imports a separate file that names those variables for its utilities.

| File | Holds | Needs |
| --- | --- | --- |
| `theme.css` | `--background`, `--primary`, `--radius`, and the rest under `:root`, with dark values under `.dark` | a browser |
| `tailwind.css` | `@custom-variant dark` and `@theme inline` names such as `--color-primary: var(--primary)` and `--radius-lg` | Tailwind CSS 4 |

`theme.css` declares custom properties and nothing else: no at-rules, fonts,
element rules, or monorepo `@source` paths. Any page can import it and use
`var(--primary)`; a `.dark` ancestor selects the dark values. `tailwind.css`
declares no color values, so the palette is in one file. Tailwind CSS is an
optional peer, needed only for `tailwind.css`. `theme.test.ts` checks both
properties.

## In the monorepo

`@epicenter/ui/app.css` imports both, then adds its fonts, base rules, and
`@source` lines:

```css
@import "tailwindcss";
@import "@epicenter/theme/theme.css";
@import "@epicenter/theme/tailwind.css";
```

Components keep using classes such as `bg-background`, `text-foreground`,
`bg-primary`, and `border-border`.

## In an Epicenter

`epicenter init` writes `src/theme.css` to the new Epicenter's top as
`theme.css`
([ADR-0909](../../docs/adr/0909-an-epicenters-theme-is-one-plain-css-file-at-its-top-that-each-apps-ui-links-to.md)).
From then on it is the person's file: no `epicenter` upgrade, `init`, or
`install` rewrites it, and the Epicenter's own repository keeps its history.
An app's UI links to it and imports the link:

```txt
~/Epicenter/
  theme.css                                 the Epicenter's palette
  apps/vocab/ui/src/
    theme.css -> ../../../../theme.css      a link the app's repository tracks
    app.css                                 @import "./theme.css"; and its Tailwind names
```

An app does not depend on this package. Its `app.css` holds its own copy of
the names in `tailwind.css`, which carry no colors, so a palette change is an
edit to the Epicenter's `theme.css` alone. A change to `src/theme.css` here
changes what a new Epicenter starts with; an existing one keeps its own.

The package is private and unpublished, and AGPL-3.0-or-later.
