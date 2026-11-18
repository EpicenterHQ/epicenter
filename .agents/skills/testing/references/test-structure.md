# Test Structure Patterns

## When to Read This

Read when test files are becoming deeply nested, when deciding `describe()` boundaries, or when introducing scenario-specific setup helpers.

## Test Structure

For scenarios spanning several modules, place the test with the highest-level consumer or in a dedicated scenario file.

### Flat Over Nested

Prefer flat `test()` calls. Use `describe()` only to group genuinely distinct behavioral categories of the same unit:

```typescript
// Good — describe groups behaviors, tests are flat within
describe('FileTree', () => {
	describe('create', () => {
		test('creates file at root', () => { ... });
		test('rejects invalid names', () => { ... });
	});

	describe('move', () => {
		test('renames file', () => { ... });
		test('moves to different parent', () => { ... });
	});
});
```

```typescript
// Bad — unnecessary nesting
describe('FileTree', () => {
	describe('create', () => {
		describe('when the name is valid', () => {
			describe('and the parent exists', () => {
				test('creates the file', () => { ... });
			});
		});
	});
});
```

### Helper Functions Over Nesting

When tests need different setup scenarios, use named setup variants (not nested `describe` + `beforeEach`):

```typescript
// Good — composable setup functions
function setupWithFiles() {
	const { files } = setup();
	files.set(makeRow('f1', 'test.txt'));
	files.set(makeRow('f2', 'other.txt'));
	return { files };
}

test('lists all files', () => {
	const { files } = setupWithFiles();
	expect(files.count()).toBe(2);
});
```
