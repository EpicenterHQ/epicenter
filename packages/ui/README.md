# UI package guide

This guide explains the UI package's shared contract, current styling, and
component update workflow. The distribution baseline is recorded in
[ADR-0453](../../docs/adr/0453-epicenter-ui-tracks-distributed-shadcn-svelte-components-with-explicit-deltas.md).

## Component library overview

This package is a shared, vendored fork of **shadcn-svelte** (1.x) on the
**Vega** preset, plus selected **shadcn-svelte-extras** and Epicenter-owned
components. Apps import its public subpaths rather than installing separate
copies of the same components.

The baseline for a shadcn-svelte component is the current Vega component a
developer receives from the CLI. Upstream visual and interaction defaults may
change during a refresh; matching the previous appearance is not an acceptance
requirement. Compare each local component with a recorded
upstream registry artifact. Keep differences that provide an explicit Epicenter
contract or fix a demonstrated problem; record those differences here. Source
import paths change to the package's relative imports. Extras follow the same
rule using their own distributed components as the baseline.

Place Select options inside `Select.Group`; the group owns upstream padding
and binds its reference. Keep selection policy at the caller: a completed
account switch can set `closeOnSelect`, while multi-toggle menus use the
upstream default that stays open.

The maintained components carry Vega utilities in their own files. The exact
registry responses used for this migration live under
[`upstream/`](upstream/README.md). They are comparison inputs, not runtime code.

### Epicenter house style

Vega supplies the component geometry. `app.css` supplies Epicenter's Geist
fonts and semantic color tokens. Apps compose the same `@epicenter/ui`
components, adding product-specific layout and behavior at their call sites.

`Button` and `Link` accept `tooltip` for a simple label. Import
`@epicenter/ui/tooltip` when another element is the trigger or the tooltip
needs composed content. Each app places one `Tooltip.Provider` around its root
content. The provider owns the shared 300 ms opening delay and 150 ms skip
delay. A nested provider creates a separate hover group rather than changing
the app-wide timing.

An Epicenter change to an upstream component must have a named caller,
interaction, or shared theme decision behind it. Current examples include
Button tooltip composition, Drawer scrolling and focus behavior, and component
variants listed under
[Current Epicenter deltas](#3-component-styling-and-epicenter-deltas). These are package
contracts to check during an upstream refresh.

### Styling

`src/app.css` owns the shared color tokens. Dark mode uses shadcn-svelte's
[Neutral palette](https://www.shadcn-svelte.com/docs/theming#neutral) with a
charcoal lift for the page, cards/popovers, secondary fills, and focus ring.
Seven existing token values differ from Neutral; no theme variables are added.
Light mode, sidebar colors, and status/chart colors retain their existing values.


`src/app.css` supplies Geist fonts, semantic tokens, and the upstream data
variants and animations from `src/styles/shadcn-base.css`. Components own their
Vega utility classes. Apps import `@epicenter/ui/app.css`; no app root class is
needed to activate the components.

## Design stance

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

## Key differences from standard shadcn-svelte

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

### 3. Component styling and Epicenter deltas

Keep each component's distributed Vega utilities in its maintained source file.
Add a local utility or markup change only for a named caller or interaction.
The following differences remain reviewable, rather than permanent compatibility
requirements:

| Component | Epicenter difference | Reason |
| --- | --- | --- |
| Button and Link | `tooltip` prop and composed trigger props | Apps need one-label tooltips on buttons and links, including controls nested in popovers. `ghost-destructive` remains for existing icon actions. Standard sizes and `buttonVariants` follow upstream. |
| Dialog and Drawer | Viewport scrolling and Drawer content scroll wrapper | Long recording details remain usable, and mobile content can scroll without losing drag behavior. Installed Vaul `1.0.0-next.7` already suppresses autofocus by default. |
| Modal | One responsive Dialog or Drawer with a shared open state | Forms use Dialog on desktop and a draggable Drawer below 768px. |
| Menus and Select | Current distributed defaults | Upstream owns surfaces, destructive states, animations, selection behavior, and submenu portals. Honeycrisp’s folder-list caller supplies its scroll cap so every folder remains reachable. |
| Table | Current distributed row hover | Rows own the hover surface; cells retain their deliberate status and sticky backgrounds. |
| Item and Sidebar | Truncation, icon media, inset shrink behavior, and the same offcanvas Sidebar at narrow widths | Rows and sidebars fit narrow flex layouts. Item remains a containing block for Honeycrisp’s positioned note controls. Collapsed offcanvas sidebars are inert so hidden navigation cannot receive keyboard focus. Sidebar preserves the existing navigation structure instead of adopting upstream’s separate mobile Sheet. |
| Alert and Badge | Warning, ID, status, success, and destructive variants | Apps use these semantic states. |
| Resizable | Spacing between panes | Adjacent panes need separation in current app layouts. |
| Extras | Local imports and the same shared tokens; Link's tooltip and Modal's responsive behavior above | Extras ship from a separate registry and keep their own baselines. |

Other structural choices with live callers remain in their components: the
span-or-anchor Badge, ScrollArea viewport ring, Resizable handle, and the
standard Loading shell. `switch` and `alert-dialog` emit `data-size`; sidebar
menu controls emit `data-active` only when active. These attributes feed the
Vega state selectors.

The distributed registry still includes unresolved `cn-font-heading` and
`cn-menu-*` hooks in some files. The maintained package omits those inert hooks;
`shadcn-base.css` retains the upstream data variants, utilities, and animations
used by the components.

## Component management workflow

For an upstream refresh, fetch the distributed Vega response, save its exact
JSON under [`upstream/`](upstream/README.md), and compare it with the
maintained component and real callers. The registry contains generator imports
such as `$UTILS$`; normalize them to package-relative imports. Review dependency
requests. Reconsider each local difference against the incoming implementation;
a caller alone does not establish that an old workaround is still necessary.

Check a consuming app at desktop and narrow widths. Verify that the person can
complete the task; changed geometry alone does not establish a regression.
Remove obsolete caller overrides when upstream defaults meet that task. Update
the snapshot and the reason for any surviving local difference in the same change. Do not add a runtime vendor
tree, patch generator, or per-app component copy.

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
- Styles: `styles/shadcn-base.css`, `prose.css`, and `app.css`.

Add a folder only when the component is a shared visual primitive or stable
product widget. App-owned behavior should stay in the app and compose these
parts.

## Best Practices

1. **Keep Components Pure**: no business logic in UI components.
2. **Use Barrel Exports**: each component folder has an `index.ts`.
3. **Keep the comparison local**: component utilities stay in their source files;
   record intentional differences from the saved distributed baseline.
4. **Consistent Imports**: relative inside `packages/ui/src`; `@epicenter/ui`
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

### Style conflicts

Check the component's `cn()` call and the caller's class at the rendered
viewport and state. Responsive utilities such as `sm:max-w-md` can outrank an
unprefixed caller class. Put an override in the matching variant when the
caller owns that width or color.

### Component Updates

When updating breaks functionality:

1. Check the shadcn-svelte changelog.
2. Compare the saved registry artifact with the component's local behavior and classes.
3. Build a consuming app before committing.
