---
name: specification-writing
description: Write technical specs that let agents implement autonomously. Use for "write a spec", "plan this feature", "create a planning doc".
metadata:
  author: epicenter
  version: '1.0'
---

# Specification Writing

Follow [writing-voice](../writing-voice/SKILL.md) for prose sections. For ownership or flow explanations, lead with the useful model, ground it in the relevant boundary, and keep only the diagrams and prose implementation needs.

A specification gives an agent or maintainer the context they need to implement a feature autonomously. The goal is not to describe everything exhaustively. The goal is to show enough evidence that the direction is credible and give the implementer a concrete launch point.

**A spec is in-flight scaffolding, not the durable record.** It plans work and holds research while the work is underway. It is not authoritative and does not outlive the work. Durable decisions live in `docs/adr/`, shared vocabulary in `docs/CONTEXT.md`, current state in `docs/reference/` and the code. When a load-bearing decision crystallizes while you are writing the spec, record it as a `Proposed` ADR in `docs/adr/` right then and reference it from the spec; do not leave it buried in the spec to be "harvested" later. When the work lands, retire the spec using [the spec lifecycle](../../../specs/README.md#lifecycle). ADR acceptance follows [the ADR guidance](../../../docs/adr/README.md); implementation completion does not authorize a status change. Git and `docs/spec-history.md` keep the history.

> **Note**: This guide uses `[PLACEHOLDER]` markers for content you must fill in. Code blocks show templates; replace all bracketed content with your feature's details.

## References

Load these on demand based on the spec's decision surface:

- If writing a spec with **many trade-offs, migration cleanup, or "keep for consistency" decisions**, read [references/decision-hygiene.md](references/decision-hygiene.md).
- If writing a spec with **architecture, API, lifecycle, or ownership changes**, read [../pull-request/references/body-patterns.md](../pull-request/references/body-patterns.md) for before/after examples and visual communication rhythm.

## The Core Philosophy

Specs should:

- **Provide context, not instructions**: Give the "why" and "what", let the implementer figure out "how"
- **Document research, not conclusions**: Show what was explored, what exists, what doesn't
- **Leave questions open**: The Open Questions section is a feature, not a bug
- **Enable autonomous implementation**: An agent reading this should spawn sub-agents to verify and extend
- **Respect maintainer time**: Make the active path obvious before asking the reader to absorb history, appendices, or implementation logs
- **No process theater**: Include a section because it changes implementation or review, not because the template lists it

A good spec is a launching pad, not a script to follow.

**Before outlining sections, apply the [one-sentence-test](../one-sentence-test/SKILL.md).** If you can't name what this spec is about in one concrete sentence, the design is not coherent yet. That is the finding, and the spec is not ready.

---

## Maintainer-Time Contract

The first screen of a spec must answer:

```txt
What is this?
Is it active, implemented, superseded, or historical?
What is the current shape?
What is the target shape?
What proves the change is done?
```

Large specs are allowed. Thoroughness is useful when the work is deep. The rule is not "split after N lines." The rule is: do not make one reader job fight another.

Split or add a short active slice when a document mixes:

- North-star architecture and concrete execution steps.
- Historical debate and current implementation path.
- Spec content and handoff prompts.
- Appendices or ledgers that are useful, but not needed to start work.

When keeping everything in one file, add a "How to read this spec" block near the top:

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

The reader should be able to get the current truth in one minute, the model in five minutes, and the execution path in fifteen minutes.

---

## Spec Placement

All implementation specs live in root `/specs/`. Do not create nested specs under `apps/` or `packages/`.

Name new specs `specs/YYYYMMDDThhmmss-feature-name.md`: local timestamp, kebab-case feature name.

Prompt and handoff artifacts can live beside specs with explicit suffixes like `.prompt.md`, `.handoff.md`, or `.execute.md`. They should link back to the canonical spec and should not be treated as the current implementation plan unless the suffix says so.

---

## Decision Hygiene

Classify every material decision:

| Class | Resolved by | Rule |
| --- | --- | --- |
| 1 | Evidence | Verify with source, test, or version check. |
| 2 | Design coherence | Apply the spec thesis consistently. |
| 3 | Taste under constraints | Pick deliberately and write the constraint. |

Before any "keep" decision, ask: "Would I add this if it did not already exist?"

- If yes, record the use case.
- If no but removal is churn, record it as a Class 3 keep in the Decisions Log.
- If no and removal is cheap, drop it now.

Never let evidence questions hide behind design coherence. Verify before deleting old paths. For examples and failure modes, read [references/decision-hygiene.md](references/decision-hygiene.md).

---

## Document Structure

Not every spec needs every section. A small feature might skip Research Findings. A migration spec might focus heavily on Edge Cases. Use judgment.

### Header (Required)

```markdown
# [Feature Name]

**Date**: [YYYY-MM-DD]
**Status**: Draft | In Progress
**Owner**: [Name/team responsible for decisions]
**Branch**: [optional: branch name if work has started]
**Supersedes**: [optional: previous spec paths]
**Superseded by**: [optional: later spec path]
```

### One Sentence

Every spec needs one concrete sentence before the overview. This is the maintainer's anchor.

```markdown
## One Sentence

[One sentence naming the new shape and the boundary it changes.]
```

### Overview

One paragraph max. Describe what the feature does. Don't sell it.

```markdown
## Overview

[One to two sentences describing what this feature adds or changes and what it enables. Be specific about the capability, not vague about benefits.]
```

### Motivation

Structure as **Current State**, **Problems**, then **Desired State**.

```markdown
## Motivation

### Current State

[Show actual code or configuration demonstrating how things work TODAY. Use real code blocks, not prose descriptions.]

This creates problems:

1. **[Problem Title]**: [Specific explanation of what breaks or is painful]
2. **[Problem Title]**: [Specific explanation of what breaks or is painful]

### Desired State

[Brief description of what the target looks like. Can include a code snippet showing the ideal API or structure.]
```

### Research Findings

This is where specs shine. Document what you FOUND, not what you assumed.

```markdown
## Research Findings

### [Topic Researched]

[Description of what you investigated and methodology]

| [Category]    | [Dimension 1]  | [Dimension 2]    |
| ------------- | -------------- | ---------------- |
| [Project/Lib] | [What they do] | [Their approach] |
| [Project/Lib] | [What they do] | [Their approach] |

**Key finding**: [Your main discovery, for example that no standard exists, or that everyone does X]

**Implication**: [What this means for your design decisions]
```

Include:

- What similar projects do (comparison tables)
- What you searched for but didn't find ("No Established Pattern Exists")
- Links or references to documentation you consulted

### Design Decisions

Use a table for traceability. Every material decision should have a class and rationale.

A load-bearing decision (a Class 2 coherence or Class 3 taste choice about architecture, ownership, an API shape, or a rejected alternative worth not re-litigating) belongs in an ADR, not only in this table. Write it as a `Proposed` ADR in `docs/adr/` as soon as it crystallizes and reference the ADR number in the table's rationale. The table then traces the spec's decisions to their durable home; the ADR survives after the spec is deleted.

```markdown
## Design Decisions

| Decision            | Class       | Choice           | Rationale                       |
| ------------------- | ----------- | ---------------- | ------------------------------- |
| [Decision point]    | 1 evidence  | [What you chose] | [Source, test, or version checked] |
| [Decision point]    | 2 coherence | [What you chose] | [How this follows the thesis]   |
| [Decision point]    | 3 taste     | [What you chose] | [Constraint and trade-off]      |
| [Deferred decision] | Deferred    | Deferred         | [Why it is deferred and what would bring it back] |
```

### Architecture

Diagrams over prose. Prefer fenced text diagrams, file trees, route tables, and before/after blocks. Use simple ASCII diagrams by default because they are fast to write and easy to edit. Use box-drawing characters only when a polished diagram is worth the extra weight.

```markdown
## Architecture

[Describe what the diagram shows]
```

```txt
[caller]
  -> [boundary or route]
    -> [policy or validation]
      -> [storage or primitive]
```

For multi-step flows:

```txt
Step 1: [Step name]
  [What happens in this step]

Step 2: [Step name]
  [What happens in this step]
```

### Catalogs (when introducing a primitive set)

When the spec introduces a coherent set of new primitives (column types, action variants, error kinds, modifier methods, etc.), present them as a **catalog**: a compact code block that lists every primitive with a one-line annotation, followed by detail sections only for the ones that need elaboration.

Catalogs let a reader scan the entire surface in one glance before diving into any single primitive.

````markdown
## The field.* catalog

```ts
field.string<TBrand?>(s?)               // TEXT (TBrand for branded strings)
field.number(s?)                        // REAL
field.integer(s?)                       // INTEGER
field.boolean()                         // INTEGER 0/1
field.select([value])                   // TEXT (single-element set)
field.select([...])                     // TEXT + CHECK constraint
field.json<S extends TSchema>(schema)   // TEXT JSON-encoded, schema required
nullable(inner)                         // Type.Union([inner, Type.Null()]) (standalone)
field.datetime(s?)                      // RFC 3339 string, branded DateTimeString
field.string<IanaTimeZone>()            // IANA zone string, branded IanaTimeZone
```

Every primitive justified by N+ existing call sites in the audit.

### What was considered and rejected

| Candidate | Why rejected |
|---|---|
| `field.id()` | Subsumed by `field.string<IdBrand>()` + a co-located `generate*` factory |
| `field.array(of)` | Subsumed by `field.json(Type.Array(of))` |
| Declaring `_v` as a column | Library-managed; positional in `defineTable(v1, v2, ...)` |
````

A "rejected candidates" table is often as useful as the catalog itself: it shows the implementer what *not* to add, and why. The reader gains confidence that the surface is tight.

### Call Sites (before/after on real code)

When the spec changes a consumer-facing API, show **at least 2-3 real call sites translated**, not invented examples. Real code surfaces semantic shifts the abstract proposal misses.

Find actual usages in the codebase first. Show the verbatim "Before" with file:line, then the "After" translation. Annotate any non-obvious mapping with a brief comment.

````markdown
## Call sites: before and after

### honeycrisp notes table

**Before** (`apps/honeycrisp/src/lib/workspace.ts:78`):

```ts
const notesTable = defineTable(
  type({ id: NoteId, title: 'string', _v: '1' }),
  type({ id: NoteId, title: 'string', wordCount: 'number | undefined', _v: '2' }),
).migrate(...)
```

**After**:

```ts
const notesTable = defineTable(
  { id: field.string<NoteId>(), title: field.string() },
  {
    id: field.string<NoteId>(),
    title: field.string(),
    wordCount: nullable(field.number()),
  },
).migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, wordCount: null };
    case 2: return value;
  }
});
```

**Semantic shift to flag**: rows previously stored with `wordCount` key absent will now read as `null` instead of `undefined`. Affects app code doing `if (row.wordCount === undefined)`. Also: `_v` no longer appears in the column record; it is library-managed and stripped from returned rows.
````

The "semantic shift to flag" callouts are critical: they're what the implementer needs to grep for and codemod across the codebase.

### Implementation Plan

Break into phases. Use checkboxes for tracking. Phase 1 should be detailed; later phases can be rougher (the implementer will flesh them out).

```markdown
## Implementation Plan

### Phase 1: [Phase Name]

- [ ] **1.1** [Specific, atomic task]
- [ ] **1.2** [Specific, atomic task]
- [ ] **1.3** [Specific, atomic task]

### Phase 2: [Phase Name]

- [ ] **2.1** [Higher-level task the implementer will break down]
- [ ] **2.2** [Higher-level task]
```

#### Wave ordering for clean breaks: Build, Prove, Remove

If the spec replaces an old code path, plan how consumers switch to the new path,
what proves the replacement works, and how recovery remains possible before
retirement. Use [rethink's clean-break reference](../rethink/references/clean-breaks.md)
for separable and inseparable replacements. Let dependencies determine the
phases rather than imposing a fixed wave count.

### Edge Cases

List scenarios that might break assumptions or need special handling.

```markdown
## Edge Cases

### [Scenario Name]

1. [Initial condition]
2. [What happens]
3. [Expected outcome or "See Open Questions"]

### [Scenario Name]

1. [Initial condition]
2. [What happens]
3. [Expected outcome]
```

### Open Questions

This section signals "you decide this" to the implementer. Include your recommendation but don't close the question.

```markdown
## Open Questions

1. **[Question about an unresolved design decision]**
   - Options: (a) [Option A], (b) [Option B], (c) [Option C]
   - **Recommendation**: [Your suggestion and why, but explicitly leave it open]

2. **[Another unresolved question]**
   - [Context about why this is uncertain]
   - **Recommendation**: [Suggestion or "Defer until X"]
```

### Adjacent Work

Most specs do not need this section; a spec is an execution spine, not a file whitelist. When adjacent work matters, write only what the implementer needs: deferred items (not required now, allowed later) and opportunistic ones (acceptable to fix if discovered and grounded).

```markdown
## Adjacent Work

- [Decision or feature]: [Why it is not required now, and what would bring it back.]
- [Issue or cleanup]: [Why it is not required, but may be fixed if discovered and grounded.]
```

### Decisions Log

Use this section only for Class 3 keeps. Each entry must name the constraint and a revisit trigger.

```markdown
## Decisions Log

- Keep `[name]`: [constraint or trade-off].
  Revisit when: [specific signal that would make the keep decision worth re-opening].
```

### Success Criteria

How do we know this is done? Checkboxes for verification.

```markdown
## Success Criteria

- [ ] [Specific, verifiable outcome]
- [ ] [Specific, verifiable outcome]
- [ ] [Tests pass / build succeeds / docs updated]
```

### References

Files that will be touched or consulted.

```markdown
## References

- `[path/to/file.ts]` - [Why this file is relevant]
- `[path/to/pattern.ts]` - [Pattern to follow or reference]
```

If your spec is too prescriptive, the agent will blindly follow it. If it's too vague, the agent will flounder. The sweet spot is: **enough context to start, enough openness to own the implementation**.
