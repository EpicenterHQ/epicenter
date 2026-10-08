# Upstream component baselines

These are the exact distributed registry responses compared during the Vega migration. Vega responses were refreshed on 2026-10-08; extras retain the 2026-09-24 baseline. Git preserves the saved JSON bytes. Registry files are review inputs; `@epicenter/ui` imports only the maintained components in `src/`. Generator placeholders such as `$UTILS$` and `$UI$` become package-relative imports when integrated.

| Family | Distributed response |
| --- | --- |
| `accordion` | [`shadcn-svelte/vega/accordion.json`](https://shadcn-svelte.com/registry/styles/vega/accordion.json) |
| `alert-dialog` | [`shadcn-svelte/vega/alert-dialog.json`](https://shadcn-svelte.com/registry/styles/vega/alert-dialog.json) |
| `alert` | [`shadcn-svelte/vega/alert.json`](https://shadcn-svelte.com/registry/styles/vega/alert.json) |
| `avatar` | [`shadcn-svelte/vega/avatar.json`](https://shadcn-svelte.com/registry/styles/vega/avatar.json) |
| `badge` | [`shadcn-svelte/vega/badge.json`](https://shadcn-svelte.com/registry/styles/vega/badge.json) |
| `breadcrumb` | [`shadcn-svelte/vega/breadcrumb.json`](https://shadcn-svelte.com/registry/styles/vega/breadcrumb.json) |
| `button-group` | [`shadcn-svelte/vega/button-group.json`](https://shadcn-svelte.com/registry/styles/vega/button-group.json) |
| `button` | [`shadcn-svelte/vega/button.json`](https://shadcn-svelte.com/registry/styles/vega/button.json) |
| `card` | [`shadcn-svelte/vega/card.json`](https://shadcn-svelte.com/registry/styles/vega/card.json) |
| `chart` | [`shadcn-svelte/vega/chart.json`](https://shadcn-svelte.com/registry/styles/vega/chart.json) |
| `checkbox` | [`shadcn-svelte/vega/checkbox.json`](https://shadcn-svelte.com/registry/styles/vega/checkbox.json) |
| `command` | [`shadcn-svelte/vega/command.json`](https://shadcn-svelte.com/registry/styles/vega/command.json) |
| `context-menu` | [`shadcn-svelte/vega/context-menu.json`](https://shadcn-svelte.com/registry/styles/vega/context-menu.json) |
| `dialog` | [`shadcn-svelte/vega/dialog.json`](https://shadcn-svelte.com/registry/styles/vega/dialog.json) |
| `drawer` | [`shadcn-svelte/vega/drawer.json`](https://shadcn-svelte.com/registry/styles/vega/drawer.json) |
| `dropdown-menu` | [`shadcn-svelte/vega/dropdown-menu.json`](https://shadcn-svelte.com/registry/styles/vega/dropdown-menu.json) |
| `empty` | [`shadcn-svelte/vega/empty.json`](https://shadcn-svelte.com/registry/styles/vega/empty.json) |
| `field` | [`shadcn-svelte/vega/field.json`](https://shadcn-svelte.com/registry/styles/vega/field.json) |
| `input-group` | [`shadcn-svelte/vega/input-group.json`](https://shadcn-svelte.com/registry/styles/vega/input-group.json) |
| `input` | [`shadcn-svelte/vega/input.json`](https://shadcn-svelte.com/registry/styles/vega/input.json) |
| `item` | [`shadcn-svelte/vega/item.json`](https://shadcn-svelte.com/registry/styles/vega/item.json) |
| `kbd` | [`shadcn-svelte/vega/kbd.json`](https://shadcn-svelte.com/registry/styles/vega/kbd.json) |
| `label` | [`shadcn-svelte/vega/label.json`](https://shadcn-svelte.com/registry/styles/vega/label.json) |
| `popover` | [`shadcn-svelte/vega/popover.json`](https://shadcn-svelte.com/registry/styles/vega/popover.json) |
| `progress` | [`shadcn-svelte/vega/progress.json`](https://shadcn-svelte.com/registry/styles/vega/progress.json) |
| `radio-group` | [`shadcn-svelte/vega/radio-group.json`](https://shadcn-svelte.com/registry/styles/vega/radio-group.json) |
| `resizable` | [`shadcn-svelte/vega/resizable.json`](https://shadcn-svelte.com/registry/styles/vega/resizable.json) |
| `scroll-area` | [`shadcn-svelte/vega/scroll-area.json`](https://shadcn-svelte.com/registry/styles/vega/scroll-area.json) |
| `select` | [`shadcn-svelte/vega/select.json`](https://shadcn-svelte.com/registry/styles/vega/select.json) |
| `sheet` | [`shadcn-svelte/vega/sheet.json`](https://shadcn-svelte.com/registry/styles/vega/sheet.json) |
| `sidebar` | [`shadcn-svelte/vega/sidebar.json`](https://shadcn-svelte.com/registry/styles/vega/sidebar.json) |
| `skeleton` | [`shadcn-svelte/vega/skeleton.json`](https://shadcn-svelte.com/registry/styles/vega/skeleton.json) |
| `switch` | [`shadcn-svelte/vega/switch.json`](https://shadcn-svelte.com/registry/styles/vega/switch.json) |
| `table` | [`shadcn-svelte/vega/table.json`](https://shadcn-svelte.com/registry/styles/vega/table.json) |
| `tabs` | [`shadcn-svelte/vega/tabs.json`](https://shadcn-svelte.com/registry/styles/vega/tabs.json) |
| `textarea` | [`shadcn-svelte/vega/textarea.json`](https://shadcn-svelte.com/registry/styles/vega/textarea.json) |
| `toggle-group` | [`shadcn-svelte/vega/toggle-group.json`](https://shadcn-svelte.com/registry/styles/vega/toggle-group.json) |
| `toggle` | [`shadcn-svelte/vega/toggle.json`](https://shadcn-svelte.com/registry/styles/vega/toggle.json) |
| `tooltip` | [`shadcn-svelte/vega/tooltip.json`](https://shadcn-svelte.com/registry/styles/vega/tooltip.json) |
| `chat` | [`shadcn-svelte-extras/chat.json`](https://www.shadcn-svelte-extras.com/r/chat.json) |
| `file-drop-zone` | [`shadcn-svelte-extras/file-drop-zone.json`](https://www.shadcn-svelte-extras.com/r/file-drop-zone.json) |
| `github-button` | [`shadcn-svelte-extras/github-button.json`](https://www.shadcn-svelte-extras.com/r/github-button.json) |
| `light-switch` | [`shadcn-svelte-extras/light-switch.json`](https://www.shadcn-svelte-extras.com/r/light-switch.json) |
| `link` | [`shadcn-svelte-extras/link.json`](https://www.shadcn-svelte-extras.com/r/link.json) |
| `modal` | [`shadcn-svelte-extras/modal.json`](https://www.shadcn-svelte-extras.com/r/modal.json) |
| `pm-command` | [`shadcn-svelte-extras/pm-command.json`](https://www.shadcn-svelte-extras.com/r/pm-command.json) |
| `snippet` | [`shadcn-svelte-extras/snippet.json`](https://www.shadcn-svelte-extras.com/r/snippet.json) |

The shadcn-svelte-extras responses come from their own registry, not the Vega registry. Epicenter-owned components have no claimed upstream match.

The saved dependency metadata is evidence for a refresh, not an upgrade command. In this checkout `bits-ui` is 2.17.2 and `vaul-svelte` is 1.0.0-next.7. The migrated code uses their installed APIs. Vaul already prevents autofocus when its root uses the default `autoFocus=false`; the redundant local guard was removed after browser checks.

The intentional Epicenter differences and their reasons are recorded below. Subsequent refreshes replace a snapshot only as part of a reviewed component change.

## October 8 refresh

Command disabled attributes, ContextMenu and DropdownMenu selection/portal
behavior, Field slots, and Sidebar formatting now match the current Vega
responses. The other 34 Vega families were compared and their distributed
source was unchanged. Exact raw responses remain review inputs, not runtime
code or a promise to preserve older behavior.

## Intentional upstream differences

Record the maintained change and the caller or shared decision that needs it.
Reconsider each reason during a refresh. This register covers reviewed
customizations; it does not establish that every source difference is intentional
or that every component matches its saved baseline. Unresolved omissions belong
in the refresh PR or an issue, not in this register as accepted behavior.

| Component | Epicenter difference | Reason |
| --- | --- | --- |
| Button and Link | `tooltip` prop and composed trigger props | Apps need one-label tooltips on buttons and links, including controls nested in popovers. `ghost-destructive` remains for existing icon actions. Standard sizes and `buttonVariants` follow upstream. |
| Dialog and Drawer | Viewport scrolling and Drawer content scroll wrapper | Long recording details remain usable, and mobile content can scroll without losing drag behavior. Installed Vaul `1.0.0-next.7` already suppresses autofocus by default. |
| Modal | Extras-based responsive composition with simplified context access | Forms use Dialog on desktop and a draggable Drawer below 768px. The root owns the live media query; children read that root directly. |
| Menu callers | Honeycrisp folder-list scroll cap; LocalMail account items explicitly close after selection | Every folder remains reachable, and a completed account switch dismisses its menu. Shared menu selection defaults follow upstream. |
| Table cells | `bg-clip-padding`, logical header alignment, and checkbox padding | Matter’s sticky and status cells keep their own backgrounds. Row hover follows upstream. |
| Item and Sidebar | Truncation, inset shrink behavior, and the same offcanvas Sidebar at narrow widths | Rows and sidebars fit narrow flex layouts. Item remains a containing block for Honeycrisp’s positioned note controls. Collapsed offcanvas sidebars are inert so hidden navigation cannot receive keyboard focus. Sidebar preserves the existing navigation structure instead of adopting upstream’s separate mobile Sheet. |
| Alert and Badge | Warning, ID, status, success, and destructive variants | Apps use these semantic states. |
| Resizable | Spacing between panes | Adjacent panes need separation in current app layouts. |
| Tooltip provider | Fixed 300 ms opening delay and 150 ms skip delay | App-root providers share one hover group and timing across controls. |
| Input | File-input binding alongside normal value binding | File pickers need access to the selected files through the shared component. |
| Item.Button | A real button using shared Item variants and merged trigger props | Interactive rows use button semantics without repeating Item’s child-snippet composition. |
| Theme | Geist fonts and seven dark Neutral token adjustments | The accepted soft charcoal direction uses existing semantic variables; component geometry remains Vega’s. |

Other structural choices with live callers remain in their components: the
span-or-anchor Badge, ScrollArea viewport ring, Resizable handle, and the
standard Loading shell. `switch` and `alert-dialog` emit `data-size`; sidebar
menu controls emit `data-active` only when active. These attributes feed the
Vega state selectors.

The distributed registry still includes unresolved `cn-font-heading` and
`cn-menu-*` hooks in some files. The maintained package omits those inert hooks;
`shadcn-base.css` retains the upstream data variants, utilities, and animations
used by the components.
