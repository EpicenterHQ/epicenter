# `as*` Helpers Are the Third Part of the Branded-ID Pattern

When a branded ID flows through an arktype schema and into trusted internal call sites, the canonical shape is three exports: the type, a validator annotated to it, and an `as*` helper that is syntactic sugar for the assertion.

```typescript
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// 1. TYPE: declared first, the single place the brand is written.
export type PrincipalId = string & Brand<'PrincipalId'>;

// 2. VALIDATOR: annotated to the type.
export const PrincipalId = type('string').as<PrincipalId>();

// 3. AS HELPER: syntactic sugar for `value as PrincipalId`.
export const asPrincipalId = (value: string): PrincipalId =>
	value as PrincipalId;
```

That is it. The helper is optional: generators like `generateSavedTabId()` cover the "minted fresh" case, and the validator's `.assert(unknown)` covers the network-boundary case. Reach for the `as*` helper when external typed strings flow in (Better Auth user ids, route params, DB columns) and you want a single named cast site.

## What the Helper Earns

The arktype validator is callable, but its signature is `(value: unknown) => T | ArkErrors`. At a trusted call site that already holds a `string`, you do not want to thread an error result through. The `as*` helper does one thing:

```typescript
export const asPrincipalId = (value: string): PrincipalId =>
	value as PrincipalId;
```

- **Constrained input**: `value: string` rejects accidental `unknown` widenings at compile time.
- **One assertion**: the function body is the only `as PrincipalId` in the codebase.
- **Grep-friendly**: `asPrincipalId(` finds every brand-cast site.
- **Cheap rename**: change the brand or the underlying primitive in the type and the helper signature follows.

## `as*` Never Validates

The prefix is a promise about cost, borrowed from [Rust's conversion naming](https://rust-lang.github.io/api-guidelines/naming.html): `as_` is free and returns a view of the same value at a different level of abstraction, where `to_` does work and `into_` consumes. `asPrincipalId` is exactly that: no check, no allocation, the same string seen as a partition key.

This is not the functional-programming smart constructor, which validates and can fail. The closest documented analogue is Effect's `Brand.nominal`, the unvalidated sibling of `Brand.refined`. Keeping the two apart is the point of the name.

So the rule the prefix carries: an `as*` helper never grows a runtime check. The day one needs to validate, it stops being an `as*` and becomes a parse that can fail, with a name that says so.

## Where the Helper Fits

```typescript
// Trusted string from another typed source
const principalId = asPrincipalId(c.var.principal.id);

// Test fixture
const cell = {
  principalId: asPrincipalId('user-1'),
  // ...
} satisfies PersistedAuth;

// Schema validation throws: use the validator, not the helper
const parsed = PersistedAuth.assert(JSON.parse(rawCellJson));
```

## What Not to Do

```typescript
// Bad: scattered raw casts
const principalId = c.var.principal.id as PrincipalId;
const another = processString(data as PrincipalId);

// Bad: calling the validator at a trusted site (returns PrincipalId | ArkErrors)
const principalId = PrincipalId(c.var.principal.id); // type is `PrincipalId | type.errors`
```

## JSDoc Convention

Always include a JSDoc above the helper that calls it out as syntactic sugar. The reader should know at a glance that this is a typed cast, not a runtime validator:

```typescript
/**
 * Syntactic sugar for `value as PrincipalId`. The function body is a single typed
 * cast; the constrained `string` parameter is what earns it over a raw `as`
 * (callers can't accidentally widen to `unknown`). The only place in the
 * codebase where `as PrincipalId` appears.
 */
export const asPrincipalId = (value: string): PrincipalId =>
	value as PrincipalId;
```

## When You Do Not Need the Helper

Skip it when:

- The ID is minted fresh in this code: use `generateXxxId()` instead.
- The branded type is only ever consumed from an arktype-validated schema: `id: PrincipalId` in the schema body already produces a branded value.
- Path-style types that flow through a single `path.resolve()` choke point: cast there once.

## Naming

`as` + the type name, camelCased: `asPrincipalId`, `asFileId`, `asSavedTabId`. The `as` prefix mirrors the runtime assertion and reads naturally: `asPrincipalId(str)` says "treat this string as a PrincipalId."

Not `toPrincipalId`: under the convention the prefix borrows, `to` implies work and a copy, and nothing happens here. Not `unsafePrincipalId` either, which is honest but noisy at every call site; the unchecked part is what `as` already means.

## Summary

1. **Declare the type first**: `export type PrincipalId = string & Brand<'PrincipalId'>`
2. **Annotate the validator to it**: `export const PrincipalId = type('string').as<PrincipalId>()`
3. **Add `asXxx` if external strings flow in**: `export const asPrincipalId = (value: string): PrincipalId => value as PrincipalId`
4. **Document it as syntactic sugar** in the JSDoc

The `as*` helper is the third optional part of the canonical branded-ID pattern. It is the only place `as PrincipalId` appears in the codebase; everywhere else is the helper, the validator, or `.assert(...)`.
