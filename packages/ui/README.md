# @epicenter/ui

Shared Svelte components for Epicenter apps. This package maintains
shadcn-svelte component source, selected shadcn-svelte-extras components, and
Epicenter widgets in one place so apps share fixes and behavior.

[shadcn-svelte distributes source](https://www.shadcn-svelte.com/docs), which we
maintain in `src/`. Bits UI, Vaul, and Paneforge supply installed behavior
primitives. Updating those dependencies or the shadcn CLI does not refresh our
copied component files.

## Usage

Apps import public package subpaths and the shared stylesheet:

```svelte
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import '@epicenter/ui/app.css';
</script>

<Button>Save</Button>
```

Every `src/<folder>/index.ts` exposes a public subpath. Raw Svelte files are
private. Inside this package, use relative imports:

```typescript
import { Button } from '../button/index.js';
import { cn } from '../utils.js';
```

Do not point app aliases or configuration at `packages/ui/src`.

## Styling

Vega is the current component style baseline. It supplies component markup and
utilities. It is a choice we can revisit, not a restriction on customization.
Other upstream styles use different distributed component source; switching
styles requires reviewing and integrating that source.

`src/app.css` owns Geist fonts and the shared semantic color tokens. Dark mode
uses Neutral with seven existing token values adjusted for soft charcoal.
[Theme variables](https://www.shadcn-svelte.com/docs/theming) can change colors
without replacing the component style. Changing a variable does not switch the
component markup, spacing, or interaction contract. Components own their utility
classes; no app root class activates the style.

Use existing variants and supported props first, then caller classes for
app-specific layout. A shared component change needs a demonstrated workflow
or shared theme decision. Keep app data, persistence, and product policy in the
app. Add a new shared primitive when the composition is stable and useful across
apps.

## Choosing components

- Use `ConfirmationDialog` for reusable confirmations and `AlertDialog` for
  composed confirmations. Use `Dialog` for other simple overlays.
- Use `Modal` for forms and input workflows. It renders a Dialog on desktop
  and a Drawer below 768px. Use `Sheet` or `Drawer` for secondary panels.
- Use `Command` or `CommandPalette` for filtered actions and search.
- Use `Field` and shared input components for forms. Put Select options inside
  `Select.Group`, which owns their padding.
- Use `Item`, `SectionHeader`, `ButtonGroup`, `InputGroup`, and `Sidebar` for
  repeated rows, sections, grouped controls, and navigation.

Dialog, Modal, Sheet, and Drawer need accessible titles. Use an `sr-only` title
when the visual design already supplies equivalent context. Keep interaction
policy with the caller: for example, a completed account switch sets
`closeOnSelect`, while a multi-toggle menu keeps the upstream open behavior.

### Tooltips

Place one `Tooltip.Provider` around each app’s root content. It shares the
300 ms opening delay and 150 ms skip delay across controls. Nesting another
provider creates a separate hover group.

Use Button or Link’s `tooltip` prop for a simple label. Compose `Tooltip.Root`,
`Tooltip.Trigger`, and `Tooltip.Content` for other triggers or richer content.

### Loading and empty states

Use `Loading` for a page or panel loading state with an optional caption:

```svelte
<Loading class="flex-1" label="Loading tabs..." />
```

Use `Empty` for empty, error, or prompt states, and for pending states that need
custom media or actions. Use `Spinner` for spinning affordances and `Skeleton`
for known content shapes rather than rebuilding them in an app.

## Updating upstream components

The [upstream baseline and customization register](upstream/README.md) records
saved registry responses and intentional differences. The source ownership
decision is in [ADR-0453](../../docs/adr/0453-epicenter-ui-tracks-distributed-shadcn-svelte-components-with-explicit-deltas.md).

1. Fetch the distributed component for the chosen style and save its exact
   registry response. Extras use their separate registry.
2. Compare it with the maintained component and real callers. Adapt import
   and icon placeholders; review requested dependency versions.
3. Adopt upstream defaults. Retain a local difference only when a workflow or
   shared decision establishes its need. Record the change and reason in the
   customization register; track unverified differences in the PR or an issue.
4. Check a consuming app at desktop and narrow widths, including keyboard
   behavior and long content. Remove obsolete caller overrides and build the app.

Do not run the CLI against the live package as an automatic overwrite or create
separate component copies in each app. Preserving the previous appearance alone
is not a reason to reject an upstream update.

## Verification

After changing imports or app configuration, run from the repository root:

```bash
bun run check:ui-boundary
```

The check in `scripts/check-ui-boundary.ts` enforces the public import boundary.
For scrolling regression checks, run `bun scripts/ui-scroll.browser.mjs` with
Playwright’s Chromium installed. It checks chat cleanup, streaming updates,
reading position, and long folder submenus, and prints its artifact directory.

For styling conflicts, inspect the component’s `cn()` call and caller classes
at the rendered viewport and state. A responsive utility such as `sm:max-w-md`
can outrank an unprefixed override; use the matching variant when the caller
owns that width. For import failures, check the component’s public export and
the package TypeScript configuration.
