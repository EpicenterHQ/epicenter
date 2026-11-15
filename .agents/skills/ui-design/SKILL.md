---
name: ui-design
description: Design and review Epicenter interfaces while collapsing local UI primitives into the established component system. Use when co-designing, exploring comparable apps, turning a feature idea into Svelte UI, or changing `packages/ui`, not for a tiny CSS repair.
metadata:
  author: epicenter
  version: '1.0'
license: Complete terms in LICENSE.txt
---

# UI Design

`ui-design` preserves the user-visible objective while reimagining the simplest
composition and collapsing local markup, arbitrary styling, and duplicated
visual contracts into the established component system, except where
app-specific behavior or a load-bearing interaction earns the custom shape.

The existing screen is evidence, not a structure to reproduce. Monorepo apps
use public `@epicenter/ui` imports. Personal apps in an Epicenter own copied
components and theme CSS; follow [epicenter-app](../epicenter-app/SKILL.md) for
their paths. Treat shadcn-svelte as the upstream component and pattern source.

## Canonical Path

The person's explicit constraints bound the change. A palette, copy, or
single-state request changes only that. Run the collapse pass within the
surface you are changing; report wider opportunities instead of performing
them. Reconsider the whole composition when that choice is open.

1. Name the user-visible objective in one concrete sentence. When the product
   direction is unsettled, read
   [references/direction-discovery.md](references/direction-discovery.md) before
   choosing the composition.
2. Read the current and neighboring surfaces. Inventory the workflow, hierarchy,
   accessibility, important states, and recognizable product intent that matter.
3. Where composition is open, sketch the simplest greenfield shape using the
   natural anatomy of the existing component system. For agent interactions,
   consult the upstream patterns below when they fit the work.
4. Run the component-system collapse pass below within the requested scope.
   Refuse exact reproduction of incidental markup, spacing, colors,
   breakpoints, and one-off states where the person has left those choices open.
5. Implement the whole state surface: loading, empty, error, disabled, pending,
   selected, and filter-empty where relevant.
6. Verify visible, responsive, and interactive results in the browser.
7. Run UI pre-flight before final handoff or committing the change.

For substantial composition work, state the design read:

```txt
Objective: <what the user accomplishes>.
Greenfield shape: <the simplest natural component-system composition>.
Collapse: <the local structure or styling that disappears>.
```

## Component-System Collapse Pass

Run this within the requested scope for every meaningful UI implementation or
review, not only work called a redesign. This is the UI application of
[asymmetric-wins](../asymmetric-wins/SKILL.md); load that skill when a candidate
refusal needs an explicit product-loss versus deletion-prize decision.

```txt
Preserve the product sentence.
Challenge the inherited composition.
Refuse the incidental visual promise.
Delete the local code family.
```

Inspect every wrapper, class bundle, arbitrary Tailwind value, custom color,
locally reconstructed state surface, and primitive override. Ask:

1. Does an existing primitive or variant already own this contract?
2. Can the primitive's natural shape replace the wrapper and its classes?
3. Is the exact local detail load-bearing for comprehension, accessibility,
   interaction, brand, or required geometry?
4. If it survives, who owns it: the app's product behavior or the shared system?

Implement obvious collapses directly. Ask the user only when the refusal changes
workflow, hierarchy, product meaning, brand posture, or a plausibly load-bearing
detail.

Keep custom UI app-local when it owns app-specific behavior or product meaning.
For monorepo consumers, move a stable visual contract into `packages/ui` when
several apps need it or it owns an accessibility or interaction contract.

## Emphasis and theme coherence

Make the reading path and current action clear. Judge quietness by how easily
the person can read and act; larger type and stronger color are choices, not
requirements. Keep one coherent visual language and change theme colors
through semantic tokens. Inspect a token's callers before changing its role:
in shadcn, `--accent` commonly supplies hover and other interactive surfaces.

## Agent interactions

When they fit the work, consult shadcn-svelte's
[Trace](https://www.shadcn-svelte.com/docs/components/trace),
[Code Block](https://www.shadcn-svelte.com/docs/components/code-block),
[Questionnaire](https://www.shadcn-svelte.com/docs/components/questionnaire), and
[AI Elements](https://www.shadcn-svelte.com/docs/ai-elements).
Verify local exports and current upstream source and dependencies before
adopting one; follow the component-system guide for its source ownership.

Use the smallest composition that fits: a status line for one asynchronous
action, a trace for several meaningful steps. Show only activity and status
the source actually reports. A borrowed pattern keeps the app's verb: filling
a draft and sending a message are different actions. A choice UI records a
decision; the backend owns what it authorizes.

## Buttons And Tooltips

A tooltip never carries meaning. A phone has no hover, and the phone is one of
the screens every view serves, so text that only a tooltip shows is text a
phone never shows.

- A button with words is a `Button` and has no tooltip; its words are its name.
- A button with only an icon is an `IconButton`, whose required `label` is its
  accessible name and the tooltip a pointer that can hover shows. Use an icon
  alone only when the icon reads without the label (close, add, search,
  settings, theme); otherwise give the button words.
- A tooltip may add a keyboard shortcut (`IconButton`'s `shortcut`), since
  shortcuts exist only where hover does.
- A toggle keeps one label and states its state with `aria-pressed`: "Pin",
  pressed or not, never "Pin" and "Unpin".
- What a button sends, deletes, or costs, and why it is disabled, goes in
  visible text beside it or in its confirmation, never in a tooltip.

## Human Taste Gate

Ask one focused question when human preference would materially change the
visual language, brand posture, primary hierarchy, navigation, density, or the
direction of an expressive public surface. Present concrete alternatives and a
recommendation. Do not ask about choices settled by the shared system,
accessibility, existing product intent, or a mechanical collapse.

## Product UI And Expressive Surfaces

Product UI should usually be dense, quiet, and operational. Distinctiveness
comes from workflow fit, hierarchy, copy, state design, and purposeful details.
Marketing pages, docs entry points, prototypes, and explicitly expressive work
can use a stronger visual identity, but still run the collapse pass and keep only
details that serve the chosen direction.

## References

- Read [references/direction-discovery.md](references/direction-discovery.md)
  when the user wants to co-design, compare directions, or turn a rough UI idea
  into a buildable surface.
- Read [references/comparable-apps.md](references/comparable-apps.md) when the
  design question depends on category fit or what other apps do.
- Read [references/component-system.md](references/component-system.md) for every
  meaningful Epicenter product UI implementation or review. It owns collapse
  smells and exceptions, then routes exact component and package mechanics to
  the authoritative `packages/ui` guide.
- Read [references/anti-slop-tells.md](references/anti-slop-tells.md) for public,
  marketing, docs, portfolio-like, or highly polished work where templated output
  is a material risk.
- Read [references/preflight.md](references/preflight.md) before final handoff or
  committing any visible UI change. Report only failures or intentional exceptions.

## Delegation Boundaries

- `styling` owns CSS, Tailwind, spacing, wrappers, overflow, and scroll traps.
- `svelte` owns component structure, runes, lifecycle, and state mechanics.
- Visible interface copy follows the person-facing [project writing conventions](../../../AGENTS.md#writing-conventions); [references/anti-slop-tells.md](references/anti-slop-tells.md) covers templated copy.

For an explicit external standards or accessibility audit, WebFetch the Vercel
Web Interface Guidelines and apply them directly, reporting findings as
`file:line`. Fetch them per review rather than caching a copy here, because the
upstream rules change and a stale copy would be worse than no copy.

```txt
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

The design decision and component-system collapse stay here even when another
skill owns their implementation mechanics.

## Final Output

Report the changed surfaces, browser verification, any material deletion prize,
and only the custom shapes or pre-flight exceptions that intentionally remain.
