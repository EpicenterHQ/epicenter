# 0101. Native typed-row projection views are earned serially; board is first

- **Status:** Superseded
- **Superseded by:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), which deletes Matter.
- **Date:** 2026-07-02

## Context

Matter is a standalone disk-as-truth tool (ADR-0065) whose grid already writes
markdown through one pure, per-file-serialized primitive; a view is just another
caller of that primitive. The first views wave added a persisted
`views: ViewSpec[]` to `matter.json` with three spec variants (board, calendar,
form) before any renderer existed, and a product-collapse review found a third of
the wave existed only for the two unrendered variants. Separately, the Hubble.md
precedent shows agent-authored HTML apps can cover long-tail views entirely, while
Matter's typed rows still warrant native surfaces that work identically in zero
minutes. A spec authored before its renderer also guesses the shape wrong: the
review itself produced a better calendar shape than the one already persisted.

## Decision

Matter supports a small family of native, editable, typed-row projection views
(each anchored to a field kind the schema already declares), but a view type earns
its persisted `matter.json` spec surface only when its renderer is being built,
one view at a time. `Contract.views: ViewSpec[]` is the stable additive seam; a
new view type enters as a new union member, and unknown types degrade per-entry.
Board ships first because it is the cheapest complete proof of an editable
projection and pays the one-time pattern cost every later view inherits. Calendar
is the presumptive second native view, deferred until its renderer is scheduled
and then spec'd fresh. Create/edit forms are refused as a view type: a form is a
schema-derived capability rendered straight off the contract, never a persisted
spec. Views the schema cannot type (maps, bespoke dashboards) belong to a future
sandboxed agent-authored HTML surface, not new native code.

## Consequences

- The Wave 1 calendar and form spec variants and their helpers are deleted from
  `matter-core` (recoverable from git); the wave lands board-only.
- `matter.json` never carries a view shape that nothing renders, so no shipped
  config shape is locked in by a pre-renderer guess.
- Adding a view type later is additive on disk and in the union: no breaking
  `matter.json` change, and older builds degrade gracefully by dropping the
  unknown entry.
- The family is bounded by the schema: a view's obligations stop at what field
  kinds can express, which is the guard against Notion-clone surface growth.
- Foreclosed: shipping several native views in one wave, and a persisted `form`
  spec; a future create surface must derive from the contract.

## Considered alternatives

- **Keep board/calendar/form specs now, render later:** persists unrendered,
  wrongly-guessed shapes into user config; a third of the wave served no renderer.
- **Collapse to a single `Contract.board` key:** ~100 fewer lines but returning to
  multiple views breaks stored `matter.json`; the array seam is the cheaper option
  long-term.
- **No native views; HTML apps only (the Hubble model):** works for a notepad, but
  Matter sells typed rows whose standard views must exist in zero minutes with
  identical editing invariants everywhere.
