---
name: asymmetric-wins
description: Identify an asymmetric win by refusing a small promise that would eliminate disproportionate complexity. Use when the user asks about asymmetric wins, pixel perfect fidelity, compatibility, fallbacks, modes, duplicate paths, or what would delete disproportionate complexity.
---

# Asymmetric Wins

An asymmetric win is a refusal that gives back more complexity than it costs in
product capability.

The spine:

```txt
Preserve the product sentence.
Refuse the small promise.
Delete the code family.
```

The usual shape: trade a small amount of fidelity, compatibility, modes, or
reproducibility to collapse a much larger implementation graph.

This is not arithmetic and not a quota. Do not remove arbitrary features. The
job is to find the one small promise that owns a disproportionate code family,
then decide whether refusing that exact promise leaves the product sentence
intact.

Do not say "good enough" and ship drift. Name the product sentence first. Keep
the workflow, safety, accessibility, and recognizable product feel. Refuse only
the promise that was forcing a second system, and keep it when the evidence says
the loss is load-bearing.

Complexity is evidence, not a verdict. A feature can own a large code family and
still be worth keeping when the capability it provides is load-bearing. Establish
the valuable workflow before ranking deletion prizes. Compare each refusal on two
axes: what the person loses and what machinery disappears. Treat a change to the
product's purpose as a separate product decision, not as an ordinary
simplification.

## Compose With

- `one-sentence-test` detects the opportunity (the surface audit surfaces the
  convenience feature that forces a second product sentence). This skill owns
  the decision.
- `refactoring` counts callers, fixtures, state branches, styling branches,
  docs paths, and other code-family evidence before the refusal is executed.
- `ui-design` owns visual direction, accessibility, brand, and whether a
  UI detail is load-bearing before pixel fidelity is refused.
- [Rethink's clean-break reference](../rethink/references/clean-breaks.md) guides
  the resulting replacement, verification, and old-path deletion. Use
  [rethink](../rethink/SKILL.md) when the refusal calls for developing a new
  destination.

## Domain Manifestations

The same move shows up in different clothes:

```txt
UI refactor
  Refuse exact pixel or markup reproduction only when the core workflow,
  hierarchy, accessibility, important states, and product feel survive.

Code refactor
  Refuse legacy aliases, duplicate helpers, fallback parsers, and old call
  shapes when callers can move to one canonical path.

Tests and reproducibility
  Refuse exact old snapshots, fixture quirks, or transitional behavior when the
  product contract is clearer than the old artifact.

Design artifacts
  Refuse full HTML facsimiles and exhaustive component trees when a native
  primitive, screenshot, compact sketch, or state table preserves the same
  decision.

Architecture
  Refuse keeping both mental models alive. A half-old, half-new system is
  usually the expensive promise.
```

## Procedure

```txt
1. Name the product sentence and the workflow that must remain true.
2. List candidate refusal points: fast paths, old shapes, rare modes, provider
   exceptions, compatibility aliases, fallback parsers, exact reproduction,
   partial reflection, hand-reproduced UI structure.
3. For each candidate, name both the capability loss and the deletion prize:
   methods, adapters, unions, error variants, tests, docs branches, UI states,
   styling branches, fixtures, screenshots, migrations, local markup, custom CSS,
   and diagram upkeep.
4. Separate candidates that change the product's purpose from candidates that
   remove a convenience within the same workflow.
5. Prefer the smallest capability loss that removes the underlying second shape;
   do not choose a larger product sacrifice merely because it deletes more code.
6. If the loss is load-bearing, keep the feature and write down why its
   complexity is worth owning. Otherwise, refuse the behavior when the deletion
   removes a second shape and write that refusal into the spec.
```

The rule is evidence-seeking, not dramatic: if the valuable workflow survives and
the code family disappears, refusal is the default recommendation. Keep the
feature when the user loss is load-bearing or when the "deletion" would only move
complexity somewhere harder to see.

## Decision Template

Use this shape in specs and design notes:

```txt
Product sentence:
  ...

Candidate refusal:
  ...

Deletion prize:
  ...

User loss:
  ...

Decision:
  Refuse it / keep it because ...
```

## UI Refactor Template

Use this when the promise is visual or interaction fidelity:

```txt
Product sentence:
  ...

Must preserve:
  workflow, information hierarchy, accessibility, important states,
  recognizable product feel, inspectable state, reviewable intent

Can refuse:
  exact spacing, old breakpoints, one-off hover states, incidental animation,
  pixel-perfect empty/loading/error states, duplicate responsive layouts,
  locally reproduced HTML when a shared primitive owns the same contract,
  exhaustive component trees when a smaller artifact preserves the decision

Deletion prize:
  ...

Replacement artifact:
  shared primitive / screenshot / compact sketch / state table / full tree

Decision:
  Refuse it / keep it because ...
```

Pixel, markup, and screenshot fidelity are load-bearing when the exact detail
carries comprehension, accessibility, trust, brand, or a regression-sensitive
state. Otherwise, exact reproduction is a promise like any other: keep it only
when it earns the code family it forces.

## UI Artifact Ladder

Use the smallest artifact that preserves the design decision:

```txt
1. Shared primitive or existing component
   Use when the UI library already owns the structure, spacing, states, and
   accessibility contract.

2. Screenshot or generated image
   Use when visual appearance matters more than exact markup.

3. Compact sketch or state table
   Use when the decision is hierarchy, state, or flow.

4. Partial tree
   Use when parent-child structure is the point under review.

5. Full HTML diagram
   Use only when exact DOM shape is the product contract or the bug.
```

Do not make agents reproduce a full HTML tree to prove a design unless the tree
is the thing that must stay stable. Prefer the natural primitive, then verify the
states that matter.

## Worked Example: Social Sign-In

```txt
Product sentence:
  All social sign-in routes through the API-hosted page via OAuth 2.1 PKCE.

Candidate refusal:
  Browser SPAs can use Google GIS for a roughly 1-second sign-in.

Deletion prize:
  signInWithIdToken
  OIDCProvider narrowing
  per-app GIS helpers
  GIS blocked-browser UI
  SocialSignInUnavailable
  provider-specific SDK scaling for Apple and Microsoft
  two social sign-in docs branches
  two social sign-in test paths

User loss:
  Google sign-in is a few seconds slower in browser SPAs.

Decision:
  Refuse it. The UX loss is small; the second auth shape is permanent.
```

The product still has social sign-in. It refuses one fast path so one invariant
can own every provider and environment.

For narrative context, see
`docs/articles/20260504T160541-asymmetric-wins-support-fewer-features-to-collapse-complexity.md`.
