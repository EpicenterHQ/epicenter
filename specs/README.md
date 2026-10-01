# Technical Specifications

This directory holds in-flight design scaffolding: feature plans and execution notes for work that is underway. It is **not** the durable record and **not** authoritative. Settled decisions are harvested into `docs/adr/` (the authoritative decision layer), shared vocabulary into `docs/CONTEXT.md`, and current package behavior into package READMEs and the code. The dated index of every past spec, including deleted ones, lives in `docs/spec-history.md`.

When a spec's work lands, harvest any durable decision into an ADR and delete the spent spec; git keeps the body recoverable. Do not keep finished specs here as a knowledge base.

Specs should respect maintainer time. A reader should be able to find the current truth quickly, then decide whether they need the deeper evidence or implementation plan.

## File Names

New specs use:

```txt
YYYYMMDDThhmmss-kebab-case.md
```

Examples:

```txt
20260524T153612-centralize-route-paths.md
20260524T100110-centralize-c-json-error-responses.md
```

Prompt and handoff artifacts may use explicit suffixes:

```txt
*.prompt.md
*.handoff.md
*.execute.md
```

Those artifacts should link back to the canonical spec. Do not treat them as the current implementation plan unless the suffix and header make that explicit.

## First Screen Contract

The top of a spec should answer:

```txt
What is this?
Is it Draft or In Progress? (those are the only two states; a finished spec is deleted, not marked)
What is the current shape?
What is the target shape?
What proves the change is done?
```

Use this header shape for new specs:

```markdown
# [Feature Name]

**Date**: [YYYY-MM-DD]
**Status**: Draft | In Progress
**Owner**: [Name/team responsible for decisions]
**Branch**: [optional branch name]
**Supersedes**: [optional: prior spec or ADR this design grows from]

## One Sentence

[One concrete sentence naming the new shape and the boundary it changes.]
```

If a spec is long or partly historical, add a "How to read this spec" block near the top:

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Implementation Plan
  Verification

Read if changing the architecture:
  Design Decisions
  Rejected Alternatives
  Edge Cases

Historical only:
  Implementation Notes
  Superseded Decisions
  Execution Prompts
```

## Writing Shape

Use prose to explain why. Use visuals to show shape.

Prefer:

- Real code snippets for current state and target state.
- Before/after blocks for API and refactor changes.
- File trees for package and ownership changes.
- Route tables for HTTP, CLI, and protocol surfaces.
- Fenced text diagrams for flows, layers, and ownership.
- Decision tables when multiple choices were considered.

Avoid:

- Wall-of-prose architecture.
- Template sections that do not change implementation.
- Unlabeled historical debate mixed into the active plan.
- Handoff prompts embedded in the main execution path.

## Size

Large specs are allowed. Thorough specs are often better than scattered small ones.

Do not split by line count. Split, add an active slice, or create a companion execution spec only when one file mixes reader jobs:

```txt
north-star architecture
  + historical debate
  + implementation log
  + handoff prompt
  + current execution path
```

The failure mode is not length. The failure mode is making the reader guess which parts are still true.

## Lifecycle

A spec has exactly two states, both meaning "in flight, still in the tree":

- `Draft`: design direction exists, implementation has not started or is not committed to the exact plan.
- `In Progress`: work is underway and checkboxes or implementation notes should stay current.

There is no terminal status. A spec does not become `Implemented`, `Superseded`, or `Retrospective` and linger; when its work lands (or it is abandoned), its durable decision is harvested into `docs/adr/` and the spec is deleted. "Done" has one representation: the file is gone. Git and `docs/spec-history.md` keep the history. This is why an in-tree spec is always safe to treat as live, and why a spec declaring a terminal status is a hygiene smell (see `scripts/check-doc-hygiene.ts`).

When executing a spec, update checkboxes and implementation notes in the same review unit as the code. If implementation diverges from the spec, update the spec instead of leaving stale instructions behind.

Before deleting a spent spec, record any durable decisions using
[the ADR guidance](../docs/adr/README.md). Implementation completion does not
authorize accepting an ADR. A mechanical change with no durable decision needs
no ADR. After retirement, run `bun scripts/check-doc-hygiene.ts`; resolve issues
introduced by the work and report unrelated failures against the task baseline.

## Minimum Useful Sections

Not every spec needs every section. The common shape is:

- One Sentence.
- Current State with concrete code, routes, types, or files.
- Target Shape with code, tree, table, or flow.
- Design Decisions with rationale.
- Implementation Plan with checkboxes or waves.
- Verification with commands, smoke tests, or grep checks.
- Open Questions when a decision is intentionally left to the implementer.

Use judgment. A small feature can stay short. A deep architecture change can be long, as long as the read path is clear.
