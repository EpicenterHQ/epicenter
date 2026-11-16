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
