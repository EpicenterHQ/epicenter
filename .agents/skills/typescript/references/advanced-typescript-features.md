# Advanced TypeScript and Iterator Features

## When to Read This
Read this when using modern TypeScript generics or ESNext iterator helper APIs.

## Iterator Helpers Over Spread

TS 5.9+ with `lib: ["ESNext"]` includes TC39 Iterator Helpers (Stage 4). `MapIterator`, `SetIterator`, and `ArrayIterator` all extend `IteratorObject`, which provides `.filter()`, `.map()`, `.find()`, `.toArray()`, `.some()`, `.every()`, `.reduce()`, `.take()`, `.drop()`, `.flatMap()`, and `.forEach()`.

**Prefer `.toArray()` over `[...spread]`** for materializing iterators:

```typescript
// Bad
const all = [...map.values()];
const active = [...map.values()].filter((n) => !n.deleted);

// Good
const all = map.values().toArray();
const active = map.values().filter((n) => !n.deleted).toArray();
```

`.sort()` is not on `IteratorObject` (requires random access). Materialize first: `map.values().toArray().sort(fn)`.

# Const Generic Array Inference

Use `const T extends readonly T[]` to preserve literal types without requiring `as const` at call sites.

| Pattern                             | Plain `['a','b','c']`      | With `as const`            |
| ----------------------------------- | -------------------------- | -------------------------- |
| `T extends string[]`                | `string[]`                 | `["a", "b", "c"]`          |
| `T extends readonly string[]`       | `string[]`                 | `readonly ["a", "b", "c"]` |
| `const T extends string[]`          | `["a", "b", "c"]`          | `["a", "b", "c"]`          |
| `const T extends readonly string[]` | `readonly ["a", "b", "c"]` | `readonly ["a", "b", "c"]` |

The `const` modifier preserves literal types; the `readonly` constraint determines mutability.

[`field.select`](../../../../packages/app/src/field.ts) takes a `const V extends readonly [string, ...string[]]`. The first element makes the list nonempty. The `const` type parameter preserves the caller's literal choices.

```typescript
import { field } from '@epicenter/app';
import type { Static } from 'typebox';

const status = field.select(['draft', 'published']);
type Status = Static<typeof status>; // 'draft' | 'published'
```

See `docs/articles/typescript-const-modifier-generic-type-parameters.md` for details.
