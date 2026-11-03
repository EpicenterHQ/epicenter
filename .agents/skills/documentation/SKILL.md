---
name: documentation
description: 'In-code documentation, folder READMEs, code comments. Use when: "document this", "add JSDoc", "write a README", "explain this code", or writing README.md/JSDoc.'
metadata:
  author: epicenter
  version: '1.0'
---

# Documentation

Follow the [project writing conventions](../../../AGENTS.md#writing-conventions). For architecture walkthroughs, folder mental models, or newcomer explanations, lead with the owner, boundary, or flow; ground the model in code and name the likely misconception when it helps.

Documentation explains **why**, not **what**. Users can read code to see what it does. They need you to explain the reasoning.

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
│ Field Schema│────▶│  to-arktype  │────▶ Runtime validation
└─────────────┘     ├──────────────┤
                    │  to-drizzle  │────▶ SQLite columns
                    └──────────────┘
```

Field schemas are pure JSON Schema objects with `x-component` hints. Each converter takes the same input and produces output for a specific consumer.
````

### Bad

```markdown
# Converters

- `to-arktype.ts` - Converts to ArkType
- `to-drizzle.ts` - Converts to Drizzle
- `index.ts` - Exports
```

The bad example just lists files without explaining the pattern or when to add new converters.

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
