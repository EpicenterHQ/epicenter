---
name: ui-design
description: Design and review Epicenter interfaces while collapsing local UI primitives into the shared component system. Use when co-designing, exploring comparable apps, turning a feature idea into Svelte UI, or changing `packages/ui`, not for a tiny CSS repair.
metadata:
  author: epicenter
  version: '1.0'
license: Complete terms in LICENSE.txt
---

# UI Design

`ui-design` preserves the user-visible objective while reimagining the simplest
greenfield composition and collapsing local markup, arbitrary styling, and
duplicated visual contracts into `@epicenter/ui`, except where app-specific
behavior or a load-bearing interaction earns the custom shape.

The existing screen is evidence, not a structure to reproduce. For Epicenter
product apps, `@epicenter/ui` is the default system. Treat shadcn-svelte as
implementation lineage and upstream grounding, not as an app import path.

## Canonical Path

1. Name the user-visible objective in one concrete sentence. When the product
   direction is unsettled, read
   [references/direction-discovery.md](references/direction-discovery.md) before
   choosing the composition.
2. Read the current and neighboring surfaces. Inventory the workflow, hierarchy,
   accessibility, important states, and recognizable product intent that matter.
3. Sketch the simplest greenfield composition using the natural anatomy of
   existing `@epicenter/ui` primitives.
4. Run the component-system collapse pass below. Refuse exact reproduction of
   incidental markup, spacing, colors, breakpoints, and one-off states.
5. Implement the whole state surface: loading, empty, error, disabled, pending,
   selected, and filter-empty where relevant.
6. Verify visible, responsive, and interactive results in the browser.
7. Run UI pre-flight before final handoff or committing the change.

For substantial work, state the design read:

```txt
Objective: <what the user accomplishes>.
Greenfield shape: <the simplest natural component-system composition>.
Collapse: <the local structure or styling that disappears>.
```

## Component-System Collapse Pass

Run this for every meaningful UI implementation or review, not only work called
a redesign. This is the UI application of
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

Keep custom UI app-local only when it owns app-specific behavior or product
meaning. Move a stable visual contract into `packages/ui` when several apps need
it or it owns an accessibility or interaction contract.

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
- `writing-voice` owns visible interface copy and tone.

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
