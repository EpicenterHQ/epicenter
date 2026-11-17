# Epicenter Component-System Collapse

This reference owns the smell and ownership decisions that collapse app-local
UI into the product's component system. Monorepo apps use `@epicenter/ui`;
personal apps own copied components under
[epicenter-app](../../epicenter-app/SKILL.md). For the exact monorepo catalog, import
boundary, loading and empty-state guidance, tooltip API, composition ladder,
vendored-fork differences, and update workflow, read the authoritative
[`packages/ui/README.md`](../../../../packages/ui/README.md). Do not copy that
package guide into this reference.

## Collapse Smells

These are high-signal smells, not automatic bans:

- Arbitrary Tailwind values such as `text-[11px]`, `rounded-[7px]`,
  `max-w-[43rem]`, or other exact values outside the shared scale.
- Raw hex, RGB, or palette colors where a semantic token should own the role.
- Stray `div` wrappers whose only job is carrying layout or visual classes.
- Long class bundles that restyle a primitive's spacing, density, radius,
  typography, hover, focus, shadow, or transition budget.
- Local loading, empty, error, confirmation, tooltip, or command markup that a
  shared component already owns.
- The same visual bundle copied across screens or apps.
- One-off responsive branches, hover treatments, or animations preserved only
  to reproduce the old screen exactly.

Standard-scale type and spacing that establish a useful reading hierarchy are
part of composition. Keep their purpose when removing wrappers or overrides.
Likewise, a deliberate token-level theme change has a different owner from
per-component color overrides; inspect the theme before collapsing either.

For each smell, name the user-visible objective and compare the code with the
natural component-system composition. If the objective survives without the
custom detail, delete the detail and its wrappers instead of translating them
line for line.

An arbitrary value or custom color can survive when it owns precise geometry,
data visualization, a third-party integration constraint, or another concrete
product reason that the shared scale cannot express. Name the reason. If the
value repeats or becomes a reusable visual decision, promote it to a semantic
token, component variant, or stable primitive.

## Choose the interaction contract

Choose the control by its job: form field, inline disclosure, exclusive
disclosure group, anchored overlay, menu, or modal. Start with the established
component for that job. Judge its rendered appearance in the theme alongside
its keyboard, focus, dismissal, positioning, and layering behavior. A native
element can be the simpler choice when it meets the required contract without
rebuilding a richer primitive around it.

State ownership and appearance are separate decisions. Styled native inputs
can hold unfinished values; a Bits UI widget can own interaction state inside
a styled component. Prefer the existing component over reconstructing its
behavior or styling locally. Count the caller code and custom CSS that
disappear, rather than treating fewer application runes or bare HTML as the
measure of a collapse. Use [Svelte's ownership guidance](../../svelte/SKILL.md#state-and-handler-defaults)
for bindings and lifetimes.

## What Earns A Custom Shape

Keep a composition in the app when it owns app-specific data, persistence,
policy, workflow, or product meaning. Its styling should still compose shared
primitives rather than rebuilding them.

For monorepo consumers, move a shape into `packages/ui` when it is stable and
visual and either:

- several apps need the same product concept; or
- it owns an accessibility or interaction contract that should not be
  reimplemented locally.

Do not promote speculative reuse. Do not keep a reusable visual contract local
merely because the first consumer happened to live in one app.

When a shape moves into `packages/ui`, follow the package guide instead of
inventing a parallel import, variant, overlay, or vendoring rule. Run
`bun run check:ui-boundary` after changing package imports or app configuration.
