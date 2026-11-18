# Type Testing Patterns

## When to Read This

Read when writing or reviewing `.types.test.ts` files, adding `@ts-expect-error` assertions, or validating strict type behavior in `bun:test` without `expectTypeOf`.

## Negative Type Tests

For library code, test that incorrect types are rejected. Use `@ts-expect-error` to verify the compiler catches type errors.

### When to Use

- `.types.test.ts` files testing type inference
- Any test verifying a public API's type constraints
- Especially important for generic APIs where incorrect input should fail at compile time

### Pattern

In the [app type tests](../../../../packages/app/src/app.types.test.ts), `vocab` is a typed app fixture. An uncalled function lets TypeScript check an invalid call without executing it in Bun.

```typescript
test('an edit needs both the old and new text', () => {
	// @ts-expect-error an edit names both old and new
	() => vocab.actions.words.edit({ id: 'a', old: 'x' });
});
```

### Rules

1. ALWAYS include a comment explaining what error is expected: `// @ts-expect-error — [reason]`
2. One `@ts-expect-error` per assertion — don't stack them
3. Group negative type tests in their own `describe('type errors', () => { ... })` block
4. These tests verify the compiler catches errors — they don't need runtime assertions

### In `bun:test` (No `expectTypeOf`)

Since we use `bun:test` (not Vitest), we don't have `expectTypeOf`. Use these alternatives:

- **Positive type tests**: Let TypeScript check the types — if it compiles, the types work. Add comments like `// Type: { id: string; title: string }` for documentation.
- **Negative type tests**: `@ts-expect-error` to verify rejection
- **CI enforcement**: `bun typecheck` (runs `tsc --noEmit`) catches type regressions

## No `as any` in Tests

Tests MUST NOT use `as any` to bypass type checking. Tests should prove the types work, not circumvent them.

### Alternatives

| Instead of                          | Use                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `(obj as any).privateMethod()`      | Test through the public API                                                                             |
| `tables.get('bad' as any)`          | Keep `as any` ONLY when testing runtime error handling for invalid input — add a comment explaining why |
| `createMock() as any`               | Create a properly typed mock or use a minimal type                                                      |
| `(content as any).store.ensure(id)` | Expose a test-only accessor or test through public API                                                  |

### Acceptable `as any` (With Comment)

```typescript
// Testing runtime error for invalid table name — bypasses TypeScript intentionally
expect(() => tables.get('nonexistent' as any)).toThrow(
	/Table 'nonexistent' not found/,
);
```

### Never Acceptable

```typescript
// Bad — hiding a real type problem
const result = someFunction(data as any);
expect(result).toBe('expected');
```
