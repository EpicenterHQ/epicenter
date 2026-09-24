---
name: refactoring
description: Apply caller-aware, behavior-preserving code simplifications such as inlining, branch collapse, and typed access boundaries. Use when cleaning up code or planning focused refactor commits.
metadata:
  author: epicenter
  version: '1.0'
---

# Refactoring Methodology

Systematic approach to auditing and improving code. Every change is evidence-based: count callers, show diffs, commit surgically.

> **Related Skills**: See `post-implementation-review` for the full second-read ritual after implementation. See `rethink` when the refactor changes public shape, ownership, naming, or lifecycle boundaries. See `control-flow` for linearizing conditionals and guard clauses. See `factory-function-composition` for the four-zone factory anatomy. See `method-shorthand-jsdoc` for when to use `this.method()` vs direct calls. See `code-prose` for the naming and comment pass over whatever the refactor leaves behind.

Use [asymmetric-wins](../asymmetric-wins/SKILL.md) when a refactor is preserving
a small promise that owns a large code family: legacy aliases, fallback parsers,
exact old fixtures, pixel-perfect UI reproduction, duplicate call shapes, or a
rare mode with its own tests and docs. Refactors do not need to preserve every
old promise. They need to preserve the product sentence and the load-bearing
contracts.

## The Audit: Count Callers First

Before changing anything, map every internal function with its exact call count.

```
INTERNAL FUNCTIONS                          CALLERS
────────────────────────────────────────────────
lastEntry()                                 5  (currentType, validated, 3× replace*)
validated()                                 6  (getter, read, appendText, asText, asRichText, asSheet)
pushText(content)                           8  (write, appendText×3, asText×3, replace)
replaceCurrentText(content)                 1  ← restoreFromSnapshot only ⚠️
pushSheetFromSnapshot(cols, rows)           1  ← restoreFromSnapshot only ⚠️
```

**1 caller = inline candidate.** Always ask: does this function earn its name?

### Decision Table

| Callers | Action |
|---|---|
| 0 | Dead code. Delete. |
| 1 | Inline candidate. Keep only if: complex logic worth naming, part of a constructor family, or carries important JSDoc. |
| 2-3 | Evaluate. If all callers are in the same method, might still inline. |
| 4+ | Keep. |

### When to Keep a Single-Caller Function

Not every 1-caller function should be inlined. Keep it when:

- **Part of a family**: `pushText`, `pushSheet`, `pushRichtext` all follow the same structure. Inlining one breaks the visual symmetry.
- **Complex logic worth naming**: Deep-clone operations, recursive tree walks, or multi-step parsing where the name documents intent.
- **The calling method is already long**: Inlining 15 lines into a 50-line method hurts readability.

## Type Safety Boundaries

All raw/untyped access should go through a single parsing boundary. Everything downstream uses typed results.

```
BAD: Multiple raw access points scattered across methods
─────────────────────────────────────────────────────────
currentType getter  → entry.get('type') as ContentType     ← raw .get() + cast
write()             → entry.get('columns') as Y.Map<...>   ← raw .get() + cast
replaceCurrentText  → entry.get('content') as Y.Text       ← raw .get() + cast

    GOOD: Single boundary, everything else uses typed discriminated union
    ───────────────────────────────────────────────────────────────────
readEntry()         → entry.get('type'), instanceof checks  ← THE boundary
    currentEntry getter → readEntry(last)                       ← typed from here
    write()             → this.currentEntry (discriminated)     ← typed
read()              → this.currentEntry (discriminated)     ← typed
```

    Fix: route all access through the typed getter. Public methods use `this.currentEntry` with type discrimination instead of raw `.get()`.

## Collapsing Duplicate Branches

When a switch has 2+ branches doing the same thing with different inputs, collapse via a shared method.

### The Tell

If you can describe two branches with the same sentence, they're duplicates.

```typescript
// BEFORE: "flatten to string and push" appears twice
switch (entry.type) {
	case 'richtext':
		pushText(xmlFragmentToPlaintext(entry.content) + text);
		break;
	case 'sheet':
		pushText(serializeSheetToCsv(entry) + text);
		break;
}

// AFTER: this.read() already does "flatten to string"
} else {
	pushText(this.read() + text);
}
```

 Also applies to `as*()` conversion methods. If every non-matching branch does "read as string → push as target type", collapse:

         ```typescript
// BEFORE: 3 cases, 2 are near-identical
asRichText(): Y.XmlFragment {
	const entry = this.currentEntry;
	if (!entry) return ydoc.transact(() => pushRichtext()).content;
	switch (entry.type) {
		case 'richtext':
			return entry.content;
		case 'text': {
			const plaintext = entry.content.toString();
			return ydoc.transact(() => { /* push richtext from plaintext */ }).content;
		}
		case 'sheet': {
			const csv = serializeSheetToCsv(entry);
			return ydoc.transact(() => { /* push richtext from csv */ }).content;
		}
	}
}

// AFTER: Same-type early return + single conversion path
asRichText(): Y.XmlFragment {
	const entry = this.currentEntry;
	if (!entry) return ydoc.transact(() => pushRichtext()).content;
	if (entry.type === 'richtext') return entry.content;
	const plaintext = this.read();
	return ydoc.transact(() => {
		const { content } = pushRichtext();
		populateFragmentFromText(content, plaintext);
		return { content };
	}).content;
}
```

## Composition Over Duplication

When function B is function A + one extra step, compose instead of duplicating:

```typescript
// BEFORE: pushSheetFromCsv duplicates 90% of pushSheet's body
function pushSheet(): SheetEntry { /* 10 lines of Y.Map setup */ }
function pushSheetFromCsv(csv: string): SheetEntry {
	/* same 10 lines of Y.Map setup */
	parseSheetFromCsv(csv, columns, rows);
}

    // AFTER: Compose
    const result = pushSheet();
parseSheetFromCsv(csv, result);
```

## Prefer Inline for Trivial Duplications

When a duplicated block is 1-3 lines and appears 2-3 times within the same file, keeping it inline is usually more readable than extracting a helper. The helper adds a name to learn, a definition to jump to, and an abstraction boundary to reason about: all of which cost more than the duplication saves.

**The readability test:** Does a reader need to leave the callsite to understand what's happening? If the inline code is self-explanatory, extraction hurts more than it helps.

```typescript
// Two adjacent functions with identical 2-line path construction.
// A buildChildPath() helper saves zero cognitive load: readers
// understand the inline version instantly.

// GOOD: Keep inline. The repetition is obvious and local.
async createFile(parentId: FileId | null, name: string) {
	const parentPath = parentId ? (this.getPath(parentId) ?? '/') : '/';
	const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
	await fs.writeFile(path, '');
}

async createFolder(parentId: FileId | null, name: string) {
	const parentPath = parentId ? (this.getPath(parentId) ?? '/') : '/';
	const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
	await fs.mkdir(path);
}

// BAD: Extracted for 2 callers in the same file.
// Reader now has to find buildChildPath() to understand either function.
function buildChildPath(parentId: FileId | null, name: string): string {
	const parentPath = parentId ? (this.getPath(parentId) ?? '/') : '/';
	return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}
```

Same principle in templates: a class string used twice is easier to scan inline than to chase to a `$derived` variable:

```svelte
<!-- GOOD: Both usages visible at a glance while scanning the template -->
<TreeView.Folder
	class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent
		{isHighlighted ? 'bg-accent text-accent-foreground' : ''}"
/>
<!-- ...later in the same template... -->
<TreeView.File
	class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent
		{isHighlighted ? 'bg-accent text-accent-foreground' : ''}"
/>

<!-- BAD: Extracted to a variable: reader leaves the template to understand styling -->
<TreeView.Folder class={itemClass} />
```

### When extraction IS worth it

- The block is 5+ lines (the abstraction pays for itself)
- It appears 4+ times (pattern, not coincidence)
- The callers are in different files (no local context to rely on)
- The logic is non-obvious and the function name documents intent

## Inline Known-Behavior Calls

    When a "smart" function branches internally but every caller already knows which branch it takes:

```typescript
// replaceCurrentText branches on type, but callers know the answer:
function replaceCurrentText(content, current) {
	if (current?.type === 'text') { /* in-place overwrite */ }
	else { pushText(content); }
}

// write() KNOWS it's text → always takes the if-branch
// appendText() KNOWS it's NOT text → always takes the else-branch
```

    Inline the known branch at each call site. Keep the branching function only for callers that genuinely don't know (e.g., `restoreFromSnapshot` where the live doc's type is unknown).

## Parameter Objects and Derivation

### Parameter Objects

When 2+ params always travel together and a type already describes them:

```typescript
// BEFORE
serializeSheetToCsv(entry.columns, entry.rows)

// AFTER: SheetBinding already bundles columns + rows
serializeSheetToCsv(entry)
```

### Type Derivation

Derive types instead of duplicating fields:

```typescript
// BEFORE: columns/rows duplicated in both types
type SheetBinding = { columns: Y.Map<...>; rows: Y.Map<...> };
type SheetEntry = { type: 'sheet'; columns: Y.Map<...>; rows: Y.Map<...>; createdAt: number };

// AFTER: Intersection
type SheetEntry = SheetBinding & { type: 'sheet'; createdAt: number };
```

### Value Derivation

The same rule one level down: if a value can be computed from values already in scope, don't pass or store it separately.

```typescript
// BEFORE: isDirty is always editorContent !== baseline
function save(editorContent: string, baseline: string, isDirty: boolean) { ... }

// AFTER: derive it
function save(editorContent: string, baseline: string) {
	const isDirty = editorContent !== baseline;
	...
}
```

Removing derivable state often simplifies signatures, types, and control flow in one move.

## File Shape

Caller counts audit a function. These audit the file it lives in.

1. **Inverted pyramid.** Lead with the exported or significant functions and push helpers below them. Don't bury the lead.
2. **Related concepts over monoliths.** Break a large file into modules that each own one concept.
3. **Combine overlapping concepts.** If two types, functions, or constants overlap significantly, merge them. The fewer distinct concepts a reader must hold in their head, the better.
4. **Use shared code.** A common utility (file path parsing, say) may already exist. Check for it before writing the same thing inline.

## Presenting Changes

Always show the proposed change as a diff with tradeoffs before implementing:

```
Proposed: inline replaceCurrentSheet into write()

 write(text: string) {
     ydoc.transact(() => {
-        if (type === 'sheet') replaceCurrentSheet(text);
+        if (type === 'sheet') {
+            entry.columns.forEach((_, key) => entry.columns.delete(key));
+            entry.rows.forEach((_, key) => entry.rows.delete(key));
    +            parseSheetFromCsv(text, entry);
+        }

Tradeoff: write() goes from 6 to 14 lines, but is now self-contained.
```

State what gets better AND what gets worse. Let the reviewer decide.

## Surgical Commits

One logical change per commit. Test between each.

```
    edit → diagnostics → test → commit → next edit
    ```

Never mix two unrelated refactors in one commit:

```
98fcabe  refactor: inline ValidatedEntry type and single-use write helpers
af643fd  refactor: replace validated()/currentType() closures with this.currentEntry
19d108a  refactor: remove pushSheetFromCsv, compose pushSheet + parseSheetFromCsv
c4f8ddc  refactor: move SheetBinding to sheet.ts, accept as single param
```

## Post-Refactor Straggler Sweep

After a refactor lands, immediately hunt for dead references the change left behind. Refactors that remove or move code create orphaned exports, stale JSDoc, and unnecessary indirection that won't trigger type errors: they compile fine but add confusion.

### The Sweep Checklist

Run these searches against the codebase after every non-trivial refactor:

1. **Dead exports**: Grep for the removed symbol. If nothing imports it, un-export or delete.
2. **Stale imports**: An import that pulled the old name may now be partially unused. Check each importing file.
3. **Orphaned JSDoc**: Comments that reference removed endpoints, deleted types, or old patterns. These mislead future readers worse than no comment.
4. **Single-file directories**: If a refactor moved the only meaningful file out of a directory, the directory may now hold just an `index.ts` barrel re-exporting one thing. Flatten `dir/index.ts` → `dir.ts` when the import path resolves identically (Node/Vite resolve both `$lib/auth` and `$lib/auth/index.ts`).
5. **Unnecessary indirection**: A contract type that existed solely for a removed endpoint. A helper that wrapped a one-liner. A re-export chain where the middle barrel is now a single passthrough.
6. **Indirect re-exports outside barrels**: `export { Foo } from './bar'` in a non-`index.ts` file. These accumulate at the bottom of implementation files and nobody imports through them. They also leave orphaned imports that only existed to feed the re-export.

### Example: Key Delivery Refactor

Embedding encryption keys in the session response (eliminating `GET /workspace-key`) left these stragglers:

```
Straggler                                    Found by
─────────────────────────────────────────────────────────────
currentKeyVersion import in create-auth.ts    grep for the symbol → imported but unreferenced
currentKeyVersion export from encryption.ts   only consumer was create-auth.ts → dead export
SessionResponse JSDoc: "without fetching       grep for old pattern language → stale
 key material"
WorkspaceKeyResponse contract type             grep for the type → zero consumers
```

### When to Sweep

- After removing an endpoint, type, or module
- After collapsing a multi-step flow into fewer steps
- After inlining a function (its callers may have stale comments)
- After renaming (old name may linger in JSDoc, error messages, tests)

The sweep is a separate commit from the refactor. Label it `refactor(scope): remove dead X` or `refactor(scope): fix stale JSDoc after Y`.

## Go-to-Definition Check

After a refactor that moves, renames, or re-exports a symbol, press Go-to-Def from a real call site. The cursor should land on the actual definition, not on an alias line, a re-export passthrough, or a destructure-re-export of a module-level object. If it lands somewhere worse than before, the refactor regressed navigation: fix it before committing.

Common regressions introduced by refactors:

- Re-export chains added during file moves where the intermediate file does nothing.
- Module-level `const x = {...} satisfies T; export const { fn } = x;` introduced "for symmetry" that lands Go-to-Def on the destructuring line.
- Wrapper / adapter functions inserted with no behavior change.
- Hand-written interface annotation added to a factory whose `ReturnType<typeof ...>` already covered it.

See `typescript` "Go-to-Definition Awareness" for the per-shape mechanics.

## Anti-Patterns

- **Premature extraction**: Extracting a 1-3 line block used 2-3 times into a named helper. The indirection costs more than the duplication. See "Prefer Inline for Trivial Duplications" above.
- **Abstracting away differences**: Three push constructors with different fields share boilerplate, but a `pushEntry(type, fields: Record<string, unknown>)` helper loses all type safety. The duplication communicates structure.
- **Type-erasing helpers**: Any helper that accepts `unknown` or `Record<string, any>` to "reduce duplication"
- **Refactoring while fixing bugs**: Fix the bug at the owning boundary first, then use a separate commit for cleanup that is not required by that correction
- **Batch-committing**: "Cleaned up the module" as one commit with 15 changes: impossible to review or revert
- **Shotgun inlining**: Inlining everything with 1 caller regardless of context. Respect constructor families and complex logic.
- **Skipping the straggler sweep**: Refactoring without cleaning up dead references. The code compiles, but the next person reads stale JSDoc and wastes 30 minutes confused about an endpoint that no longer exists.
- **Identity functions**: `function f(x) { return x; }` has callers, but does nothing. It's dead code wearing a disguise. Inline the call.
- **Compatibility with unshipped code**: Supporting an old signature, alias, or data shape that only existed earlier in the same branch is compatibility with something that was never deployed. Delete the old path and update its callers.
- **Speculative v2 code**: Commented-out types, tables, or functions "deferred to v2" with zero consumers. Git remembers: delete from the source file.
- **Secondary key when primary exists**: Matching records by a secondary key (name, slug, path) when a stable primary key (id) is available. The secondary key can collide, change, or diverge across systems. If the primary key exists, use it.
- **Indirect re-exports from non-barrel files**: `export { Foo } from './types.js'` at the bottom of `create-foo.ts`. The `export { }` re-export syntax belongs in `index.ts` barrels only. Implementation files export directly at the declaration. Same principle in any module system: Python's `from .types import Foo` at EOF, Rust's `pub use` in non-`mod.rs` files.
