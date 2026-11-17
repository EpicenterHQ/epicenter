# Test setup

When several tests need the same starting conditions, let each call a plain `setup()` function. Keep shared stateless declarations at module scope. Give each test fresh mutable state, and return the values it needs by name so it can destructure them. Adding a second fixture then leaves existing callers alone.

This example, shaped like the [data handle tests](../../../../packages/app/src/data.test.ts), uses the named-object form. The data declaration can be shared. The contents of its memory folder belong to one test.

```typescript
import { expect, test } from 'bun:test';
import { createMemoryContext, defineData, field, inRun, Ok } from '@epicenter/app';

const data = defineData({
	books: { fields: { tags: field.list(field.text()) } },
});

function setup() {
	const context = createMemoryContext({ 'data/books/dune.md': '---\n---\nA book\n' });
	return { context };
}

test('a missing list reads as empty', async () => {
	const { context } = setup();
	const dune = await inRun(context, () => data.books.get('dune'));
	expect(dune).toEqual(Ok({
		path: 'data/books/dune.md', id: 'dune', tags: [], body: 'A book\n',
	}));
});
```

- **Compose fixtures when the extra setup matters.** The [CLI export tests](../../../../packages/cli/src/export.test.ts) start with `fixture()`, add a Tasks app and a Git checkpoint, and return the export paths. Tests that only need an empty Epicenter can use the base fixture.
- **Keep setup visible and cleanup reliable.** Create the fixture in the test. Register cleanup that must run after a failure in `afterEach`, as the export tests do for temporary roots.
- **Keep the return value small.** Include values a test or its cleanup needs. Keep intermediate construction details inside the helper.
- **Skip shared setup** for pure functions, type-only tests, and cases whose starting conditions have little in common.

## Single-use definitions

When a schema, builder, or configuration is only used once in a test, inline it directly at the call site rather than extracting to a variable.
The definition and its usage are the same conceptual unit, so they should be the same textual unit.

Introduce a variable when its name explains something useful, the value is reused, or the test needs to inspect an intermediate result. Extract when doing so makes the test easier to read.
