---
name: documentation
description: 'In-code documentation, folder READMEs, code comments. Use when: "document this", "add JSDoc", "write a README", "explain this code", writing README.md/JSDoc, updating docs after a change, or removing duplicate or conflicting docs.'
metadata:
  author: epicenter
  version: '1.0'
---

# Documentation

Follow the [project writing conventions](../../../AGENTS.md#writing-conventions). For architecture walkthroughs, folder mental models, or newcomer explanations, lead with the owner, boundary, or flow; ground the model in code and name the likely misconception when it helps.

Documentation explains **why**, not **what**. Users can read code to see what it does. They need you to explain the reasoning.

## Don't over-document

Give each idea one canonical location, usually the README beside what it
governs. Everywhere else links there instead of restating it. When you find
another copy, remove it. When a copy conflicts, work out which is true from the
code and the user's intent, correct the canonical version, and delete the
conflicting one. Archives and `docs/history.md` are records, so leave them.

Leave out what the code already shows, so the words stay true when the code
changes: a command lists its own actions, and an error explains itself. When
something must never happen, make the code refuse it rather than writing a
warning.

Sparse documentation is a failure too. Let the canonical version be as full as
its reader needs, and use taste about what earns a place.

## Folder READMEs

Primary job: explain **why** this folder exists and the mental model.

Open with the useful model: what this folder owns, why it exists, and what boundary future edits should preserve.

### Can Include

- ASCII art diagrams for complex relationships
- Overview of key exports or entry points
- Brief file descriptions IF they add context beyond the filename
- Relationships to other folders

### Avoid

- Exhaustive file listings that just duplicate `ls`
- Descriptions that repeat the filename ("auth.ts - authentication")
- Implementation details better expressed in code

### Good

````markdown
# Converters

Transform field schemas into format-specific representations.

```
┌─────────────┐     ┌──────────────┐
│ Field Schema│────▶│  to-typebox  │────▶ Runtime validation
└─────────────┘     ├──────────────┤
                    │  to-drizzle  │────▶ SQLite columns
                    └──────────────┘
```

Field schemas are pure JSON Schema objects with `x-component` hints. Each converter takes the same input and produces output for a specific consumer.
````

### Bad

```markdown
# Converters

- `to-typebox.ts` - Converts to TypeBox
- `to-drizzle.ts` - Converts to Drizzle
- `index.ts` - Exports
```

The bad example just lists files without explaining the pattern or when to add new converters.

## Decisions sections

A README's `## Decisions` section holds the rules its code follows that
someone would likely undo by mistake. Each entry is the rule, its reason, and
the tempting alternative that lost:

```markdown
- **The rule, as one sentence in the present tense.** Why it holds, in one
  or two sentences.
  Refused: the tempting alternative, when there was one.
```

- Group entries by topic under `###` headings. They carry no numbers,
  statuses, or dates.
- Keep the section short, around 15 to 20 entries. Behavior belongs in the
  README's other sections, code arrangement in `AGENTS.md`, and a rule about
  one function in a comment beside it.
- Only built rules go in. Something designed but unbuilt goes in the README's
  "Not built yet" section, a spec, or an issue.
- Change a rule in place, in the same pull request as the code. Put long
  reasoning in the pull request body. When a rule is reversed, and an agent
  might propose the old one again, propose an entry in `docs/history.md`.
- Check each rule against the code before writing it. A rule that the code
  does not follow is worse than none.

## JSDoc Comments

JSDoc explains **when and why** to use something, not just what it does.

### Good

````typescript
/**
 * Get all table helpers as an array.
 *
 * Useful for providers and indexes that need to iterate over all tables.
 * Returns only the table helpers, excluding utility methods like `clearAll`.
 *
 * @example
 * ```typescript
 * for (const table of tables.defined()) {
 *   console.log(table.name, table.count());
 * }
 * ```
 */
defined() { ... }
````

### Bad

```typescript
/** Returns all table helpers as an array. */
defined() { ... }
```

### Rules

- Include `@example` blocks with realistic usage
- Explain WHEN to use it, not just WHAT it does
- Document non-obvious behavior or edge cases
- Public APIs get detailed docs; internal helpers can be minimal

## Code Comments

Comments explain **why**, not **what**.

### Good

```typescript
// Y.Doc clientIDs are random 32-bit integers, so we can't rely on ordering.
// Use timestamps from the entries themselves for deterministic sorting.
const sorted = entries.sort((a, b) => a.timestamp - b.timestamp);
```

### Bad

```typescript
// Sort the entries
const sorted = entries.sort((a, b) => a.timestamp - b.timestamp);
```

### Rules

- If the code is clear, don't comment it
- Comment the "why" when it's not obvious
- Comment workarounds with links to issues/docs
- Delete commented-out code; that's what git is for
