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

Two shapes coexist in the codebase, picked by what owns identity at runtime:

- **Record table IDs** are structural strings minted by the record runtime.
  Never declare `id` in Lens fields or generate a replacement at the app layer.
  A product facade may brand the returned id when the distinction prevents a
  real mix-up, but the physical record key remains runtime-owned.
- **Arktype-validated IDs** (auth user IDs, persisted-state schemas, HTTP route
  inputs) use a validator-first shape plus an `as*` helper. The arktype `Type`
  and inferred type share one PascalCase name.

See the `data-lens` skill for record schema and structural identity rules.

## Arktype-Validated IDs: Validator First, Type Inferred, Optional `as*` Helper

For IDs that flow through an **arktype** schema at a runtime boundary (auth user IDs read off Better Auth sessions, persisted-state schemas, HTTP route inputs), declare the validator first and derive the type via `.infer`. Both share one PascalCase name. Add a small `as*` helper for branding known-string values without scattering raw `as` casts.

```typescript
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

// 1. VALIDATOR: declared first; brand lives inside `.as<>()`.
export const UserId = type('string').as<string & Brand<'UserId'>>();

// 2. TYPE: derived from the validator. One source of truth.
export type UserId = typeof UserId.infer;

// 3. AS HELPER: shorthand for `value as UserId` at trusted call sites.
export const asUserId = (value: string): UserId => value as UserId;
```

TypeScript keeps value space and type space separate, so the same identifier `UserId` is the arktype `Type` in value positions and the inferred branded type in type positions. There is no runtime ambiguity and no import collision. See `docs/articles/arktype-values-and-types-should-share-the-name.md`.

### Why Validator First

Declaring the validator first and deriving the type via `typeof UserId.infer` makes the validator the single source of truth. If you change the brand or the underlying primitive, you update one place and the type follows. Declaring the type first and re-passing it into `type('string').as<UserId>()` works but encodes the same shape twice and risks drift.

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

### When Each Part Is Needed

| Origin of the value                         | Parts                                            |
| ------------------------------------------- | ------------------------------------------------ |
| Minted fresh into a workspace table         | Type alias + `generate*` (no validator)          |
| Received as a typed string (auth, URL, DB)  | Validator + Type + `as*` helper                  |
| Received as `unknown` at a network boundary | Validator + Type (validate via arktype schema)   |
| Set from an external source, never minted   | Validator + Type (with `as*` helper if branded)  |

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

This is rejected in favor of the validator-first pattern because:

1. It exports three symbols per ID and forces an `XxxSchema` alias that contradicts the shared-name idiom.
2. Every schema body has to read `id: UserIdSchema` instead of `id: UserId`.
3. The same name (`UserId`) serves two unrelated runtime behaviors (typed cast vs. arktype validator), splitting reader intent.

The validator-first + `as*` helper pattern keeps the arktype schema name unified and pushes brand-casting into a clearly named function.

See the `data-lens` skill for the current record schema structure and rules.
