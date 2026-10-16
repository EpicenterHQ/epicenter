# Test Setup Pattern

## When to Read This

Read when adding shared test infrastructure, deciding between `setup()` and `beforeEach`, or designing reusable test fixtures.

## The `setup()` Pattern

Every test file that needs shared infrastructure MUST have a `setup()` function. This replaces `beforeEach` for code reuse, following Kent C. Dodds' principle: "We have functions for that."

### Rules

1. `setup()` ALWAYS returns a destructured object, even for single values
2. Tests ALWAYS destructure the return: `const { thing } = setup()`
3. `setup()` is a plain function, not a hook; each test calls it independently
4. No mutable `let` variables at describe scope. Setup returns fresh state per test

### Why Always an Object (Even for One Value)

- **Extensibility**: Adding a second value later doesn't require changing any existing callsites
- **Self-documenting**: `const { files } = setup()` tells you what you're getting by name
- **Consistency**: Every test file follows the same pattern. No guessing

### Single Value

```typescript
// Good: always an object, even for one thing
function setup() {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
	});
	return { files: workspace.tables.files };
}

test('creates a file', () => {
	const { files } = setup();
	files.set({ id: asFileId('1'), name: 'test.txt' });
	expect(files.has('1')).toBe(true);
});
```

```typescript
// Bad: returns value directly
function setup() {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
	});
	return workspace.tables.files; // No destructuring = breaks convention
}
```

### Multiple Values

```typescript
function setup() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('test-table');
	const ykv = new YKeyValueLww(yarray);
	return { ydoc, yarray, ykv };
}

test('stores a row', () => {
	const { ykv } = setup(); // Take only what you need
	// ...
});

test('atomic transactions', () => {
	const { ydoc, ykv } = setup(); // Take multiple when needed
	ydoc.transact(() => {
		ykv.set('1', { name: 'Alice' });
	});
});
```

### Composable Setup Functions

When tests need additional setup beyond the base, create composable setup variants that build on `setup()`:

```typescript
function setup() {
	const tableDef = defineTable(fileSchema);
	const workspace = createWorkspace({
		id: 'test-workspace',
		tables: { files: tableDef },
	});
	return { ydoc: workspace.ydoc, tables: workspace.tables };
}

function setupWithBinding(
	overrides?: Partial<Parameters<typeof createDocumentBinding>[0]>,
) {
	const { ydoc, tables } = setup();
	const binding = createDocumentBinding({
		guidKey: 'id',
		tableHelper: tables.files,
		ydoc,
		...overrides,
	});
	return { ydoc, tables, binding };
}
```

### When `setup()` Is NOT Needed

- Pure function tests with no shared infrastructure (e.g., `parseFrontmatter('# Hello')`)
- Tests where each case has completely different inputs with no overlap
- Type-only test files (`*.test-d.ts`)

## Avoid `beforeEach` for Setup

Use `beforeEach`/`afterEach` ONLY for cleanup that must run even if a test fails (server shutdown, spy restoration). Never use them for data setup.

```typescript
// Bad: mutable state, hidden setup
let files: TableHelper;
beforeEach(() => {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
	});
	files = workspace.tables.files;
});

// Good: setup function, immutable per-test
function setup() {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
	});
	return { files: workspace.tables.files };
}
```

## Shared Schemas at Module Level

Table definitions used across multiple tests should be defined at module level, outside `setup()`:

```typescript
const filesTable = defineTable({
	id: field.string<FileId>(),
	name: field.string(),
	updatedAt: field.integer(),
});

function setup() {
	const workspace = createWorkspace({
		id: 'test',
		tables: { files: filesTable },
	});
	return { files: workspace.tables.files };
}
```

These are stateless definitions, safe to share. Stateful objects (Y.Doc, workspace instances) go in `setup()`.

## Don't Return Dead Weight

Every property in the setup return should be used by at least one test. If no test uses `ydoc`, don't return it:

```typescript
// Bad: ydoc is never destructured by any test
function setup() {
	const ydoc = new Y.Doc();
	return { ydoc, tl: createTimeline(ydoc) };
}

// Good: only return what tests actually use
function setup() {
	return { tl: createTimeline(new Y.Doc()) };
}
```

Exception: if a value is needed for cleanup or might be needed by future tests in the same file, keeping it is fine.
