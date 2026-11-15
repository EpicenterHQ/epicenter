# @epicenter/theme

Graphite + blue semantic colors for Epicenter interfaces using Tailwind CSS 4.
The package contains CSS only: light and dark variables, the radius scale,
the class-based dark variant, and Tailwind's color and radius mappings.

```css
@import "tailwindcss";
@import "@epicenter/theme/theme.css";

/* Keep the app's font imports, font variables, base rules, and local styles. */
```

Components keep using classes such as `bg-background`, `text-foreground`,
`bg-primary`, and `border-border`. They stay in the app's source and remain
editable. Adding `.dark` to the root selects the dark variables. An app can
override a variable after this import when it needs a deliberate exception.

`src/theme.css` is the source of the default palette. It contains no fonts,
element styles, component code, or monorepo `@source` paths. It has no runtime
dependencies; Tailwind CSS 4 is a peer used by the consuming build.

Monorepo apps receive the theme through `@epicenter/ui/app.css`. An outside
app will install a released version directly and import this stylesheet.
Its lockfile pins that version. Updating or reverting the dependency and
rebuilding changes its theme without upgrading the `epicenter` runtime.

## Distribution

This package is private and unpublished. The nine live personal apps still
contain their existing Graphite + blue tokens. Their migration requires a
published package, so their committed dependencies never name an unavailable
version or a path that exists only on the Studio.

Before publication, verify the packed artifact in isolated copies of the
consumers. Publication needs the owner's explicit go under
[ADR-0875](../../docs/adr/0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md).
The package is AGPL-3.0-or-later.
