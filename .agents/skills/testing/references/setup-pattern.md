# Test setup

When several tests need the same starting conditions, let each call a plain `setup()` function. Keep shared stateless declarations at module scope. Give each test fresh mutable state, and return the values it needs by name so it can destructure them. Adding a second fixture then leaves existing callers alone.

This example, shaped like the [data handle tests](../../../../packages/app/src/data.test.ts), uses the named-object form. The data declaration is made in `setup()`, because it takes the folder, and the temporary folder's files belong to one test.

```typescript
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineData, field, folderOnDisk, Ok } from '@epicenter/app';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'books-'));
	dirs.push(dir);
	await mkdir(join(dir, 'data/books'), { recursive: true });
	await writeFile(join(dir, 'data/books/dune.md'), '---\n---\nA book\n');
	const data = defineData(folderOnDisk(dir), {
		books: { fields: { tags: field.list(field.text()) } },
	});
	return { data };
}

test('a missing list reads as empty', async () => {
	const { data } = await setup();
	expect(await data.books.get('dune')).toEqual(Ok({
		path: 'data/books/dune.md', id: 'dune', tags: [], body: 'A book\n',
	}));
});
```

- **Compose fixtures when the extra setup matters.** The [CLI install tests](../../../../packages/app/src/command/install.test.ts) start with `fixture()`, add a Notes app with its own `package.json`, and return its folder. Tests that only need an empty Epicenter can use the base fixture.
- **Keep setup visible and cleanup reliable.** Create the fixture in the test. Register cleanup that must run after a failure in `afterEach`, as the install tests do for temporary roots.
- **Keep the return value small.** Include values a test or its cleanup needs. Keep intermediate construction details inside the helper.
- **Skip shared setup** for pure functions, type-only tests, and cases whose starting conditions have little in common.

## Single-use definitions

When a schema, builder, or configuration is only used once in a test, inline it directly at the call site rather than extracting to a variable.
The definition and its usage are the same conceptual unit, so they should be the same textual unit.

With a separate `fields` variable:

```typescript
const fields = { title: field.text() };
const data = defineData(folder, { books: { fields } });
```

With the field definition inline:

```typescript
const data = defineData(folder, {
	books: { fields: { title: field.text() } },
});
```

The `fields` key already names the object. Keep `data` named so the test can call `data.books.get(...)`.

Introduce a variable when its name explains something useful, the value is reused, or the test needs to inspect an intermediate result. Extract when doing so makes the test easier to read.
