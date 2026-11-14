# Upstream component baselines

`shadcn-svelte/vega/<name>/` holds what the shadcn-svelte CLI installs for
each stock component in a project set to the `vega` style with Lucide icons.
`@epicenter/ui` imports only `src/`; a snapshot is the text its stock
component is checked against. The snapshot is the CLI's output rather than the
registry's response because the CLI finishes the text: it resolves the
registry's `IconPlaceholder` to a Lucide import and drops the `cn-*` style
hooks a project does not define.

`shadcn-svelte-extras/` holds the 2026-09-24 responses for
[`light-switch`](https://www.shadcn-svelte-extras.com/r/light-switch.json) and
[`link`](https://www.shadcn-svelte-extras.com/r/link.json). They are review
inputs and are not checked. Epicenter-owned components have no upstream match.

## Patches and the check

A stock component is the CLI's text with our import paths, plus at most one
patch, `patches/<name>.diff`, which opens with its reason (`Epicenter: …`).
Upstream's `.ts` files are compared as Biome commits them; `.svelte` files are
compared as the CLI wrote them. `packages/ui/scripts/upstream.test.ts` fails when a
component differs from upstream plus its patch. The kit's own components
(`icon-button`, `confirmation-dialog`, `loading` and the rest without a
snapshot) are not checked.

```sh
bun scripts/upstream.ts refresh [<name>...]   # install the CLI's current output as snapshots
bun scripts/upstream.ts diff <name>           # record src/<name> as its patch, keeping the reason
bun scripts/upstream.ts apply <name>...       # rewrite src/<name> as upstream plus its patch
```

A refresh is `refresh`, then `apply` for every component. `git diff upstream/`
shows what upstream changed, and a patch that no longer applies is the review.
The CLI names the dependency versions the components expect; the kit's own are
in `package.json`. The test's `NOT_YET_REBASED` list names the components
still carrying their differences from before the check. Each is rebased by
reverting what has no reason and recording what does, and its row below moves
into its patch.

## Intentional upstream differences

The reasons for components not yet rebased. Reconsider each when its
component is rebased; a difference without a reason is reverted.

| Component | Epicenter difference | Reason |
| --- | --- | --- |
| IconButton and Link | `IconButton` owns icon labels and tooltips; Link keeps its `tooltip` prop | Icon-only controls need an accessible name. `IconButton` composes trigger props when nested in popovers. Both are the kit's own; Button is upstream's text. |
| Dialog | Viewport scrolling | Long recording details remain usable. |
| Sidebar | The same offcanvas Sidebar at narrow widths | Collapsed offcanvas sidebars are inert so hidden navigation cannot receive keyboard focus. Sidebar preserves the existing navigation structure instead of adopting upstream’s separate mobile Sheet. |
| Tabs.Content | Inactive children unmount; `forceMount` retains them explicitly | Editor panels share one selection and disposable controls; the main app shell preserves its chat and settings state. |
| Theme | Geist fonts and seven dark Neutral token adjustments | The accepted soft charcoal direction uses existing semantic variables; component geometry remains Vega’s. |

Other structural choices with live callers remain in their components: the
standard Loading shell. Badge’s span-or-anchor
rendering and Tooltip’s arrow customization follow upstream. `alert-dialog`
emits `data-size`; sidebar menu controls emit `data-active` only when active.
These attributes feed the Vega state selectors.
