# Array Access: `.at()` vs Bracket Notation

Use `.at()` by default. Use brackets `[]` only for `as const` arrays.

## The Problem

TypeScript doesn't add `| undefined` to array index access by default:

```typescript
const items = ['a', 'b', 'c'];

// TypeScript says this is `string`, but it's actually `string | undefined`
const first = items[0];

// Runtime: undefined, but TypeScript thinks it's a string
const oops = items[100];
```

You can enable `noUncheckedIndexedAccess` in tsconfig to fix this, but many projects don't have it enabled.

## The Solution: `.at()`

The `.at()` method always returns `T | undefined`, forcing you to handle the undefined case:

```typescript
const items = ['a', 'b', 'c'];

// TypeScript correctly types this as `string | undefined`
const first = items.at(0);

// Now you're forced to handle it
if (first !== undefined) {
	console.log(first.toUpperCase());
}
```

This is especially valuable for `.at(-1)` to get the last element, where the undefined possibility is more obvious.

## The Exception: `as const` Arrays

When you have an `as const` array, TypeScript knows the exact length and element types at each index. Bracket access is not only safe but preferable because it preserves the literal type:

```typescript
const SECTIONS = [
	{ title: 'Modifiers', keys: ['Cmd', 'Ctrl', 'Alt'] as const },
	{ title: 'Letters', keys: ['A', 'B', 'C'] as const },
	{ title: 'Numbers', keys: ['0', '1', '2'] as const },
] as const;

// Bracket access: TypeScript knows this exists and infers the exact type
const modifiers = SECTIONS[0];
// Type: { readonly title: "Modifiers"; readonly keys: readonly ["Cmd", "Ctrl", "Alt"] }

// .at() access: TypeScript returns the union type | undefined
const modifiersAt = SECTIONS.at(0);
// Type: { readonly title: "Modifiers"; ... } | { readonly title: "Letters"; ... } | ... | undefined
```

With `as const`, bracket access gives you:

1. The exact type at that index (not a union of all possible types)
2. No `| undefined` (TypeScript knows the element exists)
3. Compile-time error if you access an out-of-bounds index

## Real Example

From our codebase, accessing the first section of keyboard shortcuts:

```svelte
<!-- Before: .at(0) returns undefined, even though we know it exists -->
{#each ACCELERATOR_SECTIONS.at(0).keys as modifier}
	<!-- Error: Object is possibly 'undefined' -->
{/each}

<!-- After: [0] on as const array is guaranteed to exist -->
{#each ACCELERATOR_SECTIONS[0].keys as modifier}
	<!-- Works perfectly, type is inferred correctly -->
{/each}
```

The array is defined as `as const` with a fixed structure, so `[0]` is guaranteed to exist at compile time.

## Summary

| Scenario          | Use       | Why                                          |
| ----------------- | --------- | -------------------------------------------- |
| Regular arrays    | `.at()`   | Forces undefined handling                    |
| `as const` arrays | `[]`      | Preserves literal types, no undefined needed |
| Negative indices  | `.at(-1)` | Only way to access from end                  |
