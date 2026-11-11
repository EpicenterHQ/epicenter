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
  composed confirmations. Use `Dialog` for other overlays.
- Use `Command` for filtered actions and search.
- Use `Field` and shared input components for forms. Put Select options inside
  `Select.Group`, which owns their padding.
- Use `Item`, `SectionHeader`, `InputGroup`, and `Sidebar` for repeated rows,
  sections, grouped controls, and navigation.

Dialogs need accessible titles. Use an `sr-only` title
when the visual design already supplies equivalent context. Keep interaction
policy with the caller: for example, the API user menu's theme toggle sets
`closeOnSelect={false}` so the menu stays open, while ordinary items keep the
upstream close-on-select behavior.

### Tooltips

Place one `Tooltip.Provider` around each app’s root content. It shares the
300 ms opening delay and 150 ms skip delay across controls. Nesting another
provider creates a separate hover group.

Use `IconButton` for an icon-only button. Its required `label` is both its
accessible name and its tooltip; `shortcut` adds a keyboard shortcut to the
tooltip. Buttons with visible words need no tooltip. Link keeps its `tooltip`
prop. Compose `Tooltip.Root`, `Tooltip.Trigger`, and `Tooltip.Content` for other
triggers or richer content.

### Editor control and panel lifetimes

`Textarea` and `Input` expose `bind:value`, including function bindings for values
read from an editor.

Default editor composition needs no tabs: render structured controls for valid
rows and a text editor for invalid rows. Bind to current editor values and submit
complete replacements. Add tabs when the app offers a choice among views of valid
input.

`Tabs.Content` unmounts inactive children by default, including custom `child`
snippets. Do not repeat the selected-tab condition inside every panel. Keep editor
input, refused input, and unfinished forms above disposable panels. Use
`forceMount` when an inactive panel intentionally owns state that must survive.
The retained panel stays hidden and its controls remain alive.

A structured panel still renders only while the current row is valid. Its setters
check current row and application eligibility because input may arrive before
Svelte removes a leaving control. The common ownership pattern is recorded in
[ADR-0523](../../docs/adr/0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md).

### Loading and empty states

Use `Loading` for a page or panel loading state with an optional caption:

```svelte
<Loading class="flex-1" label="Loading tabs..." />
```

Use `Empty` for empty, error, or prompt states, and for pending states that need
custom media or actions. Use `Spinner` for spinning affordances and `Skeleton`
for known content shapes rather than rebuilding them in an app.

## Updating upstream components

A stock component is what the shadcn-svelte CLI installs for the `vega` style,
plus at most one patch that says why it differs. [`upstream/README.md`](upstream/README.md)
explains the snapshots, the check, and the differences not yet recorded as
patches. The source ownership decision is in
[ADR-0455](../../docs/adr/0455-epicenter-ui-tracks-distributed-shadcn-svelte-components-with-explicit-deltas.md).

1. Run `bun scripts/upstream.ts refresh` and read `git diff upstream/` for what
   upstream changed and which dependency versions it now expects.
2. Run `bun scripts/upstream.ts apply` for the changed components. A patch that
   no longer applies is the decision: drop it if upstream now covers its reason,
   or edit `src/<name>` and record it with `bun scripts/upstream.ts diff <name>`.
3. Adopt upstream defaults. Keep a difference only when a workflow or shared
   decision establishes its need, and put that reason at the top of its patch.
4. Check a consuming app at desktop and narrow widths, including keyboard
   behavior and long content. Remove obsolete caller overrides and build the app.

The CLI runs in a scratch project, never against this package or an app.
Preserving the previous appearance alone is not a reason to reject an upstream
update.

## Verification

After changing imports or app configuration, run from the repository root:

```bash
bun run check:ui-boundary
```

The check in `scripts/check-ui-boundary.ts` enforces the public import boundary.

For styling conflicts, inspect the component’s `cn()` call and caller classes
at the rendered viewport and state. A responsive utility such as `sm:max-w-md`
can outrank an unprefixed override; use the matching variant when the caller
owns that width. For import failures, check the component’s public export and
the package TypeScript configuration.
