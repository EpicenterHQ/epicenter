# Direction Discovery

Use this reference when a rough UI request has not yet converged on one
buildable direction. This is not a visual polish pass. It decides what the
surface is for, which category pattern it should borrow or refuse, and what
proof is needed before implementation is done.

## Design Brief

Start with the smallest useful brief:

```txt
Surface:
  What screen, component, or flow is changing?

User job:
  What is the user trying to get done?

Category:
  Which comparable product category should this feel like?

Constraint:
  What must stay true in this repo, app, or design system?
```

If the request is vague but implementation can still move, state the assumption
and continue. Ask a question only when its answer would change the surface or
data model.

## Design Pass

1. Write a one-sentence thesis for the screen.
2. When category fit is load-bearing, read
   [comparable-apps.md](comparable-apps.md) and name the pattern being borrowed
   or refused.
3. Choose one primary direction. When uncertainty is visual rather than verbal,
   use [prototype](../../prototype/SKILL.md) to create two or three throwaway
   variants before choosing. Match the comparison to the uncertainty: keep the
   same layout and content when comparing palettes; keep the palette when
   comparing hierarchy. Change structure when the workflow is the question.
4. Translate the direction into concrete controls, states, density, layout, and
   copy.
5. Return to the parent `ui-design` workflow for implementation and browser
   verification.

## Output Shape

```txt
Thesis:
  One sentence.

Comparisons:
  App or surface | Pattern | Borrow or refuse

Direction:
  The chosen design and why it fits Epicenter.

Implementation:
  Files or surfaces that need to change.
```

Keep Epicenter workspace-first. Prefer dense, quiet, operational UI for tools.
Do not stop at mood words: every direction must map to layout, controls, states,
and verification. Do not prototype when the existing surface already answers
the question.
