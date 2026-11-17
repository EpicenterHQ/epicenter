# Type testing

## When to read this

Read when writing or reviewing `.types.test.ts` files, adding `@ts-expect-error` assertions, or checking type inference and constraints in `bun:test`.

## Type assertions in Bun

Import `expectTypeOf` from `bun:test` to assert inferred types.
Use `toEqualTypeOf` when exact equality is the contract, and
`@ts-expect-error` when an operation should be rejected.

Type assertions are checked by the compiler. Plain `bun test`
does not verify them. Ensure the file is included in its package’s
typecheck, and run the relevant package’s typecheck or the repository’s
`bun run typecheck`.

Comments describing an expected type are documentation, not assertions.

For negative tests, verify that the compiler rejects the intended
mistake. An unrelated error can also satisfy `@ts-expect-error`.

For example, assert literal element inference and the possible undefined result:

```typescript
import { expectTypeOf, test } from 'bun:test';

function first<T>(values: readonly T[]): T | undefined {
	return values[0];
}

test('first infers literal element types with undefined', () => {
	const value = first(['draft', 'published'] as const);
	expectTypeOf(value).toEqualTypeOf<'draft' | 'published' | undefined>();
});
```

Bun added `expectTypeOf` in [v1.2.20, released August 10, 2025](https://bun.sh/blog/release-notes/bun-v1.2.20#test-your-types-with-expecttypeof).
Its [current documentation](https://bun.com/docs/test/writing-tests#expecttypeof)
also offers `bun test --check`. Keep the repository's existing typecheck
as the verification command here: adopting Bun's integrated checker is a
separate compiler migration, not a prerequisite for using `expectTypeOf`.

## Negative type tests

For library code, test that incorrect types are rejected. Use `@ts-expect-error` to verify the compiler catches type errors.

### When to use

- `.types.test.ts` files testing type inference
- Any test verifying a public API's type constraints
- Especially important for generic APIs where incorrect input should fail at compile time

### Pattern

In the [app type tests](../../../../packages/app/src/app.types.test.ts), `vocab` is a typed app fixture. An uncalled function lets TypeScript check an invalid call without executing it in Bun.

```typescript
test('an edit needs both the old and new text', () => {
	// @ts-expect-error an edit names both old and new
	() => vocab.actions.words.set({ word: 'a', edit: { old: 'x' } });
});
```

### Rules

1. Explain the intended error after `@ts-expect-error`.
2. Keep each invalid case on its own line with one directive.
3. When adding or revising a case, temporarily remove the directive and inspect the diagnostic. An unrelated error can satisfy it.
4. These tests verify compiler behavior and do not need runtime assertions.

[TypeScript's documentation](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-9.html) explains that the directive requires an error on the following line; it does not assert a particular diagnostic.

## Type escapes in tests

Do not use `as any` to hide a type problem or bypass the contract a type test should verify. A runtime test may deliberately bypass types to exercise malformed input at a validation boundary; explain that purpose beside the cast.

### Alternatives

| Instead of | Use |
| --- | --- |
| `(obj as any).privateMethod()` | Test through the public API |
| `tables.get('bad' as any)` | Use a documented cast only to test runtime validation of invalid input |
| `createMock() as any` | Create a properly typed mock or use a minimal type |
| `(content as any).store.ensure(id)` | Test through the public API; apply the [boundary guidance](../SKILL.md#choose-useful-tests) before exposing internals |

### Intentional runtime-invalid input

```typescript
// Testing runtime error for invalid table name: bypasses TypeScript intentionally
expect(() => tables.get('nonexistent' as any)).toThrow(
	/Table 'nonexistent' not found/,
);
```

### Hiding a type problem

```typescript
// Bad: hiding a real type problem
const result = someFunction(data as any);
expect(result).toBe('expected');
```
