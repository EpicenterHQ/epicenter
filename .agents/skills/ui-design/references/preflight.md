# UI Pre-Flight

Pre-flight is the final shippability check before handoff or commit. It is not a
design phase. Run it after the UI direction and implementation are in place.

Report only failures, intentional exceptions, or checks that materially changed
the implementation.

## Light Pre-Flight

Run this for any visible UI change:

```txt
Observed:
  The running change was viewed or exercised as verification.md describes,
  or the view left unverified is named.

Foundation:
  Imports follow the app's established component boundary described in ui-design.
  Monorepo consumers import public @epicenter/ui subpaths, never
  packages/ui/src or copied stock $lib/components/ui primitives.
  For these consumers, shadcn-svelte is upstream source rather than
  an app import path. Personal apps use their owned, copied components.
  Does not create a one-off primitive when a local one exists.
  Preserves explicit user constraints; challenges incidental choices left open.
  Where the person has left markup and styling open, does not preserve
  incidental details merely for exact reproduction.

Collapse:
  No class-heavy wrapper survives when a primitive can own the composition.
  Arbitrary values and custom colors have a named product or geometry reason.
  Primitive overrides express parent layout or product state, not a second theme.
  Surviving app-local UI owns app-specific behavior or product meaning.

States:
  Loading, empty, error, disabled, selected, and pending states are considered.
  Async actions keep useful labels or context.

Accessibility:
  Text and controls have sufficient contrast.
  Focus states are visible.
  Icon-only controls have accessible labels; no meaning lives only in a tooltip.
  Clickable rows or custom controls have keyboard behavior.

Layout:
  Responsive behavior is not obviously broken.
  Scroll regions have a clear height boundary.
  No unnecessary wrapper exists only to carry classes.

Copy and visuals:
  The reading path and primary content or action are clear.
  Visible strings are reread.
  No obvious filler copy, fake precision, or generic placeholder names ship.
  The user-visible objective survives even when inherited structure does not.
```

## Full Pre-Flight

Run this for new surfaces, redesigns, explicit polish requests, dashboards,
marketing pages, docs home pages, and playful or interactive public surfaces:

```txt
Design read:
  The output matches the stated surface, audience, posture, and density.

System coherence:
  One component foundation.
  One semantic palette, with a consistent role for any action color.
  One radius, shadow, and border language, or a named rule for variants.
  Typography matches the surface and does not rely on random font contrast.
  Repeated visual contracts have an owner in the established component system.
  Promote repeated visual contracts to a semantic token, component variant,
  or stable primitive when they meet the component-system ownership criteria.
  Monorepo consumers share through packages/ui; personal apps consolidate
  repetition within their owned components.

Hierarchy and density:
  The primary action or reading path is obvious.
  Dense screens scan cleanly.
  Marketing or docs pages have rhythm without repeating the same section pattern.

State quality:
  Loading, empty, error, disabled, pending, selected, and filter-empty states are designed.
  No UI affordance implies an unavailable or impossible state.

Motion:
  Motion has a reason: hierarchy, storytelling, feedback, or state transition.
  Reduced-motion behavior is safe.
  Page/view transitions do not hide state or interrupt fast app use.

Responsive behavior:
  Multi-column or high-variance layouts have explicit mobile collapse.
  Navigation fits the target viewport.
  CTAs and important controls do not wrap into broken shapes.

Content:
  Copy is specific and natural.
  Numbers are real or clearly illustrative.
  Logo walls, testimonials, and examples do not use generic filler.

Implementation fit:
  The established component system owns primitives.
  Agent patterns preserve actual execution, draft, and decision semantics.
  styling owns Tailwind/CSS mechanics.
  svelte owns component lifecycle and state mechanics.
```

## Exceptions

A failed check can ship only when the exception is intentional and named:

```txt
Pre-flight exception:
  <check> is intentionally skipped because <reason>.
```

Do not add hidden compatibility UI or one-off components to satisfy the checklist.
Fix the design, narrow the scope, or report the exception.
