# Runtime Schema and Branded Types Patterns

## When to Read This
Read this when defining runtime-validatable schemas or introducing nominal/branded ID types.

# Arktype Optional Properties

## Never Use `| undefined` for Optional Properties

When defining optional properties in arktype schemas, always use the `'key?'` syntax instead of `| undefined` unions. This is critical for JSON Schema conversion (used by OpenAPI/MCP).

### Bad Pattern

```typescript
// DON'T: Explicit undefined union - breaks JSON Schema conversion
const schema = type({
	window_id: 'string | undefined',
	url: 'string | undefined',
});
```

This produces invalid JSON Schema with `anyOf: [{type: "string"}, {}]` because `undefined` has no JSON Schema equivalent.

### Good Pattern

```typescript
// DO: Optional property syntax - converts cleanly to JSON Schema
const schema = type({
	'window_id?': 'string',
	'url?': 'string',
});
```

This correctly omits properties from the `required` array in JSON Schema.

### Why This Matters

| Syntax                       | TypeScript Behavior                        | JSON Schema                     |
| ---------------------------- | ------------------------------------------ | ------------------------------- |
| `key: 'string \| undefined'` | Required prop, accepts string or undefined | Broken (triggers fallback)      |
| `'key?': 'string'`           | Optional prop, accepts string              | Clean (omitted from `required`) |

Both behave similarly in TypeScript, but only the `?` syntax converts correctly to JSON Schema for OpenAPI documentation and MCP tool schemas.

# Branded Types Pattern

Two shapes coexist in the codebase, picked by what owns the brand at runtime:

- **Branded table field values**: `field.string<Id>()` carries a capability's branded string type through the TypeBox schema. The store owns row IDs.
- **Arktype-validated IDs** (auth user IDs, persisted-state schemas, HTTP route inputs): type-first + validator + `as*` helper. The branded type and the arktype `Type` share one PascalCase name.

## Branded values in table fields

The store mints row IDs. Do not declare a reserved `id` field or provide a row-ID generator. For references to another capability's identifiers, import its type and carry the brand through `field.string<T>()`.

```typescript
import { defineTable, field } from '@epicenter/app';
import type { BlobId } from '@epicenter/blobs';

const recordings = defineTable({
	title: field.string(),
	blobId: field.nullable(field.string<BlobId>()),
});
```

## Arktype-Validated IDs: Type First, Validator Annotated, Optional `as*` Helper

For IDs that flow through an **arktype** schema at a runtime boundary (auth user IDs read off Better Auth sessions, persisted-state schemas, HTTP route inputs), declare the type first and annotate the validator to it. Both share one PascalCase name. Add a small `as*` helper for branding known-string values without scattering raw `as` casts.

```typescript
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// 1. TYPE: declared first. The brand is written once, here.
export type UserId = string & Brand<'UserId'>;

// 2. VALIDATOR: annotated to the type, so the schema conforms to the brand.
export const UserId = type('string').as<UserId>();

// 3. AS HELPER: shorthand for `value as UserId` at trusted call sites.
export const asUserId = (value: string): UserId => value as UserId;
```

TypeScript keeps value space and type space separate, so the same identifier `UserId` is the arktype `Type` in value positions and the branded type in type positions. There is no runtime ambiguity and no import collision. See `docs/articles/arktype-values-and-types-should-share-the-name.md`.

### Why Type First

The name survives into composition. Hover a type-first brand in value position and TypeScript prints `Type<UserId, {}>`; the validator-first form prints `Type<string & Brand<"UserId">, {}>`, because `typeof UserId.infer` resolves through arktype's distillation and loses the alias. Every schema built from the brand inherits that: a type-first field shows as `id: UserId` in the composed row type, a validator-first one as `id: string & Brand<"UserId">`. Type positions expand either way, so this is a value-side difference.

The exported type is also a constraint you state rather than a consequence of the validator chain. Add a `.pipe()` to a validator-first declaration and `typeof UserId.infer` silently becomes the morph's output type, and every consumer follows it. Type-first pins the type and makes the validator conform.

Both orders write `string` twice, and `.as<castTo>()` is unconstrained in either (`type('number').as<UserId>()` compiles). Neither is a reason to pick one.

### Derive What Arktype Computes, Declare What You Supply

One question decides the order, and the expression already answers it: **does the type appear as a type argument you typed?**

| You wrote | Who owns the type | Order |
| --- | --- | --- |
| `.as<T>()` | you, `T` is your input | declare the type, annotate the validator to it |
| `type({...})` | arktype, from the fields | derive with `typeof X.infer` |
| `.pipe(fn)` | arktype, from `fn`'s return type | derive with `typeof X.infer` |

```typescript
// Supplied: `Brand<'UserId'>` appears nowhere in `type('string')`. Arktype cannot
// compute it, so you hand it in. Reading it back with `.infer` is a round trip.
export type UserId = string & Brand<'UserId'>;
export const UserId = type('string').as<UserId>();

// Computed from fields: you never state the object, arktype assembles it.
export const AuthUser = type({ id: UserId, email: 'string', 'image?': 'string | null' });
export type AuthUser = typeof AuthUser.infer;

// Computed from a function: the output type comes from the arrow's return type.
export const PollVote = type({ post_id: 'string' }).pipe((row) => ({ id: row.post_id, ...row }));
export type PollVote = typeof PollVote.infer;
```

Branded primitives are not an exception to `derive-types-before-you-declare-them.md`; they are the same rule pointing the other way, because `.as<T>()` is an input rather than a derivation. The question also settles cases the repo has not hit yet: `.narrow()` supplies nothing new, so derive.

See `docs/articles/derive-types-before-you-declare-them.md`.

### Branding a Known-String Value

At trusted call sites that receive a `string` from another typed source (Better Auth user id, URL params, Hono context vars), use the `as*` helper:

```typescript
// Good: uses the shorthand helper
const userId = asUserId(c.var.user.id);
const ownerId = asOwnerId(c.req.param('ownerId')!);

// Bad: scattered raw casts
const userId = c.var.user.id as UserId;
```

`asUserId(value: string)` is a typed cast in one place: the input is constrained to `string` at compile time, the body is the only `as UserId` in the codebase, and it's grep-friendly when auditing brand boundaries.

For genuinely untyped boundaries (parsing `unknown` JSON, network input) use the validator's `.assert(value)` or schema-level validation (e.g., `PersistedAuth.assert(...)`). That throws on shape mismatch; the `as*` helper trusts the compiler.

`as*` never validates. The prefix borrows Rust's `as_` convention: free, unchecked, the same bytes viewed at a higher abstraction. The day a helper needs a runtime check it stops being `as*` and becomes a validator or a parse.

### When Each Part Is Needed

| Origin of the value                         | Parts                                            |
| ------------------------------------------- | ------------------------------------------------ |
| Minted fresh into a workspace table         | Type alias + `generate*` (no validator)          |
| Received as a typed string (auth, URL, DB)  | Type + Validator + `as*` helper                  |
| Received as `unknown` at a network boundary | Type + Validator (validate via arktype schema)   |
| Set from an external source, never minted   | Type + Validator (with `as*` helper if branded)  |

### Schema Body Reads Cleanly

Because the validator shares the type name, arktype schemas read with no `Schema` suffix anywhere:

```typescript
// Good: one PascalCase name covers both namespaces
export const PersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	userId: UserId,
	ownerId: OwnerId,
	mode: OwnershipMode,
});

// Bad: artificial `Schema` alias next to the type import
import { UserIdSchema, type UserId } from './ids.js';
```

Reach for an alias only when two imported values genuinely collide in the same namespace. A runtime arktype validator and its inferred type do not collide.

### Why Not a Same-Name PascalCase Cast Function?

An older pattern declared a PascalCase function that doubled as the brand constructor:

```typescript
// Old pattern: DO NOT use for new code
export type UserId = string & Brand<'UserId'>;
export const UserId = (value: string): UserId => value as UserId;
export const UserIdSchema = type('string').as<UserId>();
```

This is rejected in favor of the type-first pattern because:

1. It exports three symbols per ID and forces an `XxxSchema` alias that contradicts the shared-name idiom.
2. Every schema body has to read `id: UserIdSchema` instead of `id: UserId`.
3. The same name (`UserId`) serves two unrelated runtime behaviors (typed cast vs. arktype validator), splitting reader intent.

The type-first + `as*` helper pattern keeps the arktype schema name unified and pushes brand-casting into a clearly named function. Note what survives from the old pattern: the type is still declared first. What changes is that the validator takes the shared name and the cast moves to `asUserId`.
