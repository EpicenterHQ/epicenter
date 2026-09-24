# UI Package Guide

This guide explains the UI package import boundary, the shadcn-svelte style
system it uses, and the component update workflow.

## Component Library Overview

This package is a vendored fork of **shadcn-svelte** (1.x) on the **Vega**
preset, plus a few **shadcn-svelte-extras** and Epicenter-specific components.

It uses shadcn-svelte's `cn-*` style system: component markup carries semantic
hook classes (`cn-button-variant-default`, `cn-dialog-content`) and the actual
styling lives in CSS:

- `src/styles/style-vega.css` (vendored): the Vega preset. All `cn-*` rules,
  scoped under `.style-vega`.
- `src/styles/shadcn-base.css` (vendored): the upstream base (data-* custom
  variants, `no-scrollbar`, accordion keyframes) the `cn-*` rules depend on.
- `src/styles/epicenter-overlay.css`: Epicenter style deltas (custom variants
  and per-component overrides). The single place our styling diverges from Vega.

Apps activate the preset with `class="style-vega"` on their root element; the
`cn-*` rules are scoped under it, so without the class nothing is styled. The
preset is a one-class swap (e.g. to `style-rhea`). Background and rationale:
`specs/20260606T160000-ui-shadcn-cn-style-migration-vega.md`.

## Design Stance

This package is the shared Epicenter product system, not a place for one-off app
branding. Its job is to make product UI consistent, accessible, and easy to
compose across apps. The baseline is intentionally restrained: Vega component
structure, Geist typography, semantic tokens, and app-level composition for
character.

When a screen should feel more designed, improve the workflow first: hierarchy,
density, copy, loading and empty states, grouping, keyboard affordances, and the
shape of the user's next action. Add a new global token, font, animation system,
or component variant only when several apps need the same product concept or the
variant owns an accessibility or interaction contract.

Bespoke visual direction belongs in an app, prototype, landing page, or explicit
redesign until the pattern proves it is shared. Once it is shared, move the
stable primitive here and keep app-specific behavior out of it.

### Surface Choice

Use the component whose interaction contract matches the job:

- `Dialog` or `AlertDialog`: confirmations, simple yes/no prompts,
  display-only content, and simple action confirmations.
- `ConfirmationDialog`: reusable simple confirmations before one-off alert
  dialog markup.
- `Modal`: forms, typing, dropdowns, multi-step input, or any workflow that
  collects user data. `Modal` renders as a dialog on desktop and a drawer on
  mobile.
- `Sheet` or `Drawer`: secondary panels, mobile-friendly drawers, and side
  surfaces.
- `Command` or `CommandPalette`: command menus, filtered actions, and search
  empty states.
- `Item`, `SectionHeader`, `ButtonGroup`, `InputGroup`, `CopyButton`, `Kbd`, and
  `Sidebar.*`: repeated list rows, page sections, grouped controls, inline input
  actions, copy actions, keyboard hints, and app chrome.
- `Field`, `Input`, `Textarea`, `Select`, `Switch`, `Checkbox`, and
  `RadioGroup`: forms and settings surfaces.
- `FileDropZone`, `NaturalLanguageDateInput`, `TimezoneCombobox`, `TreeView`,
  and `Markdown`: stable reusable product widgets. Use them before rebuilding
  their behavior in an app.
- `Sonner` and `toastOnError`: toasts and result-aware error notifications.

Dialog, Modal, Sheet, and Drawer surfaces need accessible titles. Use an
`sr-only` title when the visual design already supplies equivalent context.

### Loading and Empty State Guidelines

Use `Loading` for generic full-surface pending states that only need the
standard spinner shell and an optional caption:

```svelte
<Loading class="h-dvh" label="Checking session" />
<Loading class="flex-1" label="Loading tabs..." />
<Loading class="h-full" />
```

`Loading` wraps the local `Empty.Root` plus `Spinner` structure, so it keeps the
same centering, text alignment, and `aria-live="polite"` behavior without making
every app hand-compose it.

Use `Empty.Root` directly for actual empty, error, or prompt states. Also keep
`Empty.Root` for loading states that need a title, description, custom media,
actions, or exact visual parity with a nearby empty/error branch.

Use `Spinner` for every spinning affordance. Do not hand-roll `animate-spin`,
`LoaderCircleIcon`, or `Loader2Icon` in app code. Use `Skeleton` for known
content shapes instead of raw `animate-pulse` placeholder blocks. A pulsing
status dot is fine when the pulse is the content, not a fake-content skeleton.

### Tooltips

`Button` and `Link` take a `tooltip` prop. Prefer it over hand-wrapping
`Tooltip.Root`, `Tooltip.Trigger`, and `Tooltip.Content` when the content is a
simple label:

```svelte
<Button size="icon" variant="ghost" tooltip="Delete recording" onclick={deleteRecording}>
	<TrashIcon />
</Button>
```

The prop expects a `Tooltip.Provider` above the trigger. Hand-roll `Tooltip.*`
only when the trigger is not a `Button` or `Link`, or the content is more than a
simple label.

### Composition Ladder

Before copying component internals or adding a new package primitive, escalate
in this order:

1. Use an existing local component and its variants.
2. Pass a `class` or supported prop.
3. Add a local variant to the wrapper component.
4. Wrap the component for a real composition boundary: scroll containment, pane
   sizing, table cell structure, sticky headers.
5. Copy upstream component code only when Epicenter needs to own behavior,
   tokens, persistence, shortcuts, or app state.

A new primitive belongs in `packages/ui` only when it is stable, visual, and
shared. If it depends on one app's data model, persistence, or product policy,
keep it in the app and compose UI primitives there.

## Key Differences from Standard shadcn-svelte

### 1. Import Boundary

Apps import UI through the public package API:

```typescript
import { Button } from '@epicenter/ui/button';
import { Loading } from '@epicenter/ui/loading';
import { cn } from '@epicenter/ui/utils';
import '@epicenter/ui/app.css';
```

Files inside `packages/ui/src` import other UI files with relative paths:

```typescript
import { Button } from '../button/index.js';
import { cn } from '../utils.js';
```

Direct raw file imports use the same rule:

```typescript
import Button from '../button/button.svelte';
```

Do not add app aliases or tsconfig paths that point to `packages/ui/src`.
Do not add `kit.alias` entries such as:

```js
kit: {
	alias: {
		'#': '../../packages/ui/src',
	},
}
```

The UI package has no private import aliases. Apps should never define aliases
for `packages/ui/src`.

### 2. Package Imports and Exports Structure

Our `package.json` exposes only the public API for app consumers:

```json
{
	"exports": {
		"./*": "./src/*/index.ts",
		"./utils": "./src/utils.ts",
		"./utils/*": "./src/utils/*.ts",
		"./app.css": "./src/app.css"
	}
}
```

Consumers import components through the package API; UI source imports siblings
with relative paths.

Every `packages/ui/src/<folder>/index.ts` file is a public
`@epicenter/ui/<folder>` subpath. Raw `.svelte` files are private to the package
and should not be imported by apps.

### 3. Styling: the overlay, not inline overrides

Component styling lives in `cn-*` classes, not inline Tailwind. Keep component
markup byte-identical to upstream Vega so it stays trivially re-vendorable, and
put every Epicenter style delta in `src/styles/epicenter-overlay.css`.

**Custom variants** (no upstream equivalent) become a `cn-*` class. Example, the
button `ghost-destructive` variant:

```css
/* epicenter-overlay.css, under .style-vega */
.cn-button-variant-ghost-destructive {
	@apply text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20;
}
```

```svelte
// button.svelte tv()
'ghost-destructive': 'cn-button-variant-ghost-destructive',
```

**Per-component overrides** redefine the Vega `cn-*` class. The overlay is
imported after `style-vega.css` (same `layer(base)`), so a same-specificity rule
here wins:

```css
.cn-select-content { @apply max-w-min; }
```

**Invariant:** every `cn-*` class a component emits must be defined in
`style-vega.css` or `epicenter-overlay.css`. An undefined `cn-*` class is a dead
no-op; do not emit one.

Two kinds of delta stay inline, by necessity:

- **Utilities-layer overrides** of a property Vega sets inline in the component
  (notably z-index). A base-layer `@apply` cannot beat a utilities-layer inline
  utility, so override inline, or use `@apply ...!` in the overlay.
- **Structural divergences** (extra wrapper elements, `<svelte:element>`, an
  injected actions overlay) are markup, not CSS, and live in the component.

### Current Epicenter deltas

`epicenter-overlay.css` is the self-documenting source of truth for **custom
variants** (button `ghost-destructive`, alert `warning`, badge
`id`/`success`/`status.*`) and **per-component overrides** (`cn-table-row`,
`cn-select-content`, `cn-dialog-content`, `cn-resizable-panel-group`,
`cn-sidebar-inset`, `cn-item-*`, `cn-item-media-variant-icon`). Each block is
commented there.

The deltas that must stay **inline** (structural markup, or a property Vega sets
inline that a base-layer rule cannot beat) are listed here so they are not lost
on a re-vendor:

| Inline delta | File | Why it stays inline | Still needed? |
|---|---|---|---|
| `relative` + `[a]:hover:bg-accent/50` on the item base | `item/item.svelte` | positioning context for the actions overlay; accent hover uses an arbitrary `[a&]`-style selector | yes |
| Scroll wrapper `<div class="flex-1 overflow-y-auto">` | `drawer/drawer-content.svelte` | structural (extra element) | yes |
| `onOpenAutoFocus` preventDefault | `drawer/drawer-content.svelte` | workaround for vaul-svelte vs bits-ui 2.x focus recursion | remove when vaul-svelte supports bits-ui 2.x |
| Viewport ring/outline styling | `scroll-area/scroll-area.svelte` | Vega has no `cn-scroll-area-viewport` | until Vega defines it |
| Handle base styling | `resizable/resizable-handle.svelte` | Vega has no `cn-resizable-handle` (only `-icon`) | until Vega defines it |
| `<svelte:element>` span-or-anchor | `badge/badge.svelte` | structural (element choice) | yes |
| `showOnHover` actions overlay | `item/item-actions.svelte` | structural (absolute overlay + gradient) | yes |
| `tooltip` prop (wraps in `Tooltip`) | `button/button.svelte`, `link/link.svelte` | Epicenter feature; upstream Button and Link have none | yes |
| Standard loading shell | `loading/loading.svelte` | Epicenter wrapper around `Empty.Root` + `Spinner` for generic pending panes | yes |
| Portal and available-height limit | `context-menu/context-menu-sub-content.svelte` | lets long folder menus scroll without being clipped by their parent; Bits submenus expose `--bits-menu-content-*` variables | yes |
| Orientation sizing `data-[orientation=horizontal]:h-px …` | `separator/separator.svelte` | byte-identical to upstream; the size is gated on a Tailwind variant, which only attaches to real utilities. Routing it through `cn-separator-horizontal` (a plain class, not an `@utility`) makes the variant emit nothing, so the divider collapses (a fat bar inside `field-separator`, 0px standalone). Do **not** cn-ify it. | yes |

Correctness wiring (making Vega work, not Epicenter style): `switch` and
`alert-dialog` carry a `size` prop that emits `data-size`; sidebar menu and
sub-menu buttons emit `data-active` only when active. Keep these.

## Component Management Workflow

Components are (mostly) byte-identical to upstream shadcn-svelte Vega markup, so
updates are a careful copy plus a translation step.

### Upstream comparison baseline

On 2026-09-22, Dialog, Sheet, and Select were compared with shadcn-svelte commit
[`6b5914a`](https://github.com/huntabyte/shadcn-svelte/tree/6b5914aac9c142a1eff3604995b3cb94eda2f933).
Dialog and Sheet close controls compose the shared ghost icon Button, and
Select's popup uses Bits UI's available height and transform origin.
Other component markup and the preset CSS were not refreshed; their
original upstream revision is unrecorded.

DropdownMenu also caps its height at Bits UI's available height. Callers that
set a tighter maximum must combine both limits with `min()`, as Local Mail's
label menu does, because caller classes replace the default maximum.

For future refreshes, record the source commit and the components updated here.
Review markup and preset CSS together: upstream can move structural utilities
between them. In particular, that revision's Drawer moves positioning and size
constraints from the preset into its markup, so replacing only the preset would
remove constraints from our current Drawer.

### Updating or adding a component

1. Copy the component's `cn-*` Vega markup from upstream shadcn-svelte (or
   generate it in a scratch project pinned to a 1.x version).
2. Normalize imports to relative paths (`../utils.js`, `../button/index.js`).
   The committed package has no generator aliases.
3. Strip `IconPlaceholder`; use direct `@lucide/svelte/icons/*` imports.
4. Move every Epicenter style delta into `epicenter-overlay.css` (see Styling
   above). Do not leave inline override args stacked on a `cn-*` class.
5. Confirm the invariant: every `cn-*` class the component emits is defined.
6. Run `bun run check:ui-boundary` and build a consuming app.

### Re-vendoring the whole preset

To pull a newer Vega, replace `src/styles/style-vega.css` (and `shadcn-base.css`
if the base changed) with the upstream file, then re-check the invariant. Newly
defined `cn-*` classes may let you drop overlay overrides; newly emitted hooks in
components may need definitions.

### Do NOT

- Regenerate with the shadcn-svelte CLI and copy blindly. It pulls
  `IconPlaceholder` and generator aliases, and reintroduces the inline form.
- Stack inline Tailwind overrides on top of a `cn-*` class. Use the overlay.

### Import Path Convention

```typescript
// App code
import { Button } from '@epicenter/ui/button';

// UI package source
import { Button } from '../button/index.js';
import { cn } from '../utils.js';
```

## Component Inventory

Every `src/<folder>/index.ts` is a public `@epicenter/ui/<folder>` subpath. The
inventory is grouped by job so it does not duplicate `ls`.

- Foundations: `button`, `badge`, `card`, `separator`, `skeleton`, `spinner`,
  `tooltip`, `sonner`, `utils`, `hooks`.
- Forms and inputs: `field`, `input`, `textarea`, `select`, `checkbox`,
  `radio-group`, `switch`, `toggle`, `toggle-group`, `input-group`,
  `natural-language-date-input`, `timezone-combobox`, `file-drop-zone`.
- Overlays and menus: `dialog`, `alert-dialog`, `modal`, `drawer`, `sheet`,
  `popover`, `dropdown-menu`, `context-menu`, `command`, `command-palette`,
  `confirmation-dialog`.
- Layout and navigation: `accordion`, `breadcrumb`, `collapsible`, `resizable`,
  `scroll-area`, `sidebar`, `tabs`, `table`, `tree-view`, `section-header`,
  `item`, `button-group`.
- Content and app widgets: `avatar`, `chart`, `chat`, `copy-button`,
  `emoji-picker`, `github-button`, `kbd`, `light-switch`, `link`, `loading`,
  `markdown`, `pm-command`, `progress`, `snippet`, `star-rating`.
- Styles: `styles/shadcn-base.css`, `styles/style-vega.css`,
  `styles/epicenter-overlay.css`, `prose.css`, and `app.css`.

Add a folder only when the component is a shared visual primitive or stable
product widget. App-owned behavior should stay in the app and compose these
parts.

## Best Practices

1. **Keep Components Pure**: no business logic in UI components.
2. **Use Barrel Exports**: each component folder has an `index.ts`.
3. **Style in the overlay**: Epicenter deltas go in `epicenter-overlay.css`, not
   inline on the component, unless they must stay inline (see Styling).
4. **Hold the invariant**: never emit a `cn-*` class that is not defined.
5. **Consistent Imports**: relative inside `packages/ui/src`; `@epicenter/ui`
   only from consumers outside this package.

## Boundary Check

Run the boundary check after changing UI imports or app config:

```bash
bun run check:ui-boundary
```

The executable source of truth is `scripts/check-ui-boundary.ts`.
The check fails when app configs point at `packages/ui/src`, when app configs
or package manifests add private UI import paths, when app source imports
private UI import names, when app or package source imports `packages/ui/src`
directly, or when UI source imports itself through private aliases or
`@epicenter/ui/...`.

## Troubleshooting

### Browser regression checks

From the repo root, run `bun scripts/ui-scroll.browser.mjs` with Playwright's
Chromium installed. The script checks chat listener and observer cleanup,
streaming updates, preservation of the reading position, and long folder
submenus. It prints the temporary directory containing screenshots and results.

### Import Resolution Issues

If imports are not resolving:

1. Check that the component is exported by `@epicenter/ui`.
2. Ensure your IDE recognizes the package's TypeScript config.
3. Restart the TypeScript language server.

### Style Conflicts

If a custom style is not applying:

1. Confirm the rule is in `epicenter-overlay.css` (imported after
   `style-vega.css`, so it wins at equal specificity).
2. If you are overriding a value Vega sets inline in the component (e.g.
   z-index), a base-layer `@apply` will not win: override inline or use
   `@apply ...!`.
3. Confirm the app root carries `class="style-vega"`; without it the `cn-*`
   rules do not apply at all.

### Component Updates

When updating breaks functionality:

1. Check the shadcn-svelte changelog.
2. Review the overlay and any inline overrides.
3. Build a consuming app before committing.
