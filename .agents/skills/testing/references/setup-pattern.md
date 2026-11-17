# Test setup

When several tests need the same starting conditions, let each call a plain `setup()` function. Keep stateless declarations at module scope. Give each test fresh mutable state, and return the values it needs by name so it can destructure them. Adding a second fixture then leaves existing callers alone.

This abbreviated [collection list test](../../../../packages/app/src/collection.lists.test.ts) uses the named-object form. The collection definition can be shared. The contents of its memory folder belong to one test.

```typescript
import { expect, test } from 'bun:test';
import { createMemoryContext, defineCollection, field, inRun, Ok } from '@epicenter/app';

const books = defineCollection({
	path: 'data/books/{book}.md',
	fields: { tags: field.list(field.text()) },
});

function setup() {
	const context = createMemoryContext({ 'data/books/dune.md': '---\n---\nA book\n' });
	return { context };
}

test('a missing list reads as empty', async () => {
	const { context } = setup();
	const dune = await inRun(context, () => books.get({ book: 'dune' }));
	expect(dune).toEqual(Ok({
		path: 'data/books/dune.md', book: 'dune', tags: [], body: 'A book\n',
	}));
});
```

- **Compose fixtures when the extra setup matters.** The [CLI export tests](../../../../packages/cli/src/export.test.ts) start with `fixture()`, add a Tasks app and a Git checkpoint, and return the export paths. Tests that only need an empty Epicenter can use the base fixture.
- **Keep setup visible and cleanup reliable.** Create the fixture in the test. Register cleanup that must run after a failure in `afterEach`, as the export tests do for temporary roots.
- **Keep the return value small.** Include values a test or its cleanup needs. Keep intermediate construction details inside the helper.
- **Skip shared setup** for pure functions, type-only tests, and cases whose starting conditions have little in common.
