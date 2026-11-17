---
name: typebox
description: TypeBox patterns for runtime schema validation and JSON Schema generation. Use when mentioning TypeBox, Standard Schema, or schema-based validation.
metadata:
  author: epicenter
  version: '1.0'
---

# TypeBox

## Package Names

**Use `typebox`, not `@sinclair/typebox`**. The `@sinclair/typebox` package is deprecated.

```typescript
// Correct
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';

// Wrong - deprecated
import { Type } from '@sinclair/typebox';
```

## When to Use What

| Need                        | Use                                  |
| --------------------------- | ------------------------------------ |
| Define schemas              | `typebox` with `Type.*`              |
| One-off validation          | `Value.Check()` from `typebox/value` |
| High-performance validation | `Compile()` from `typebox/compile`   |

TypeBox schemas are portable JSON Schema-shaped data. If a TypeBox boundary
needs validation, validate the TypeBox schema directly:

```typescript
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';

const schema = Type.Object({ name: Type.String(), age: Type.Number() });

Value.Check(schema, value); // boolean

const validator = Compile(schema);
validator.Check(value); // boolean
validator.Parse(value); // throws or returns typed value
```

## Standard Schema Boundary

TypeBox does not implement Standard Schema. Do not write TypeBox code that expects
`schema['~standard']`. If a boundary accepts Standard Schema, prefer Arktype or
another schema library that implements it natively. If a boundary owns TypeBox
schemas, keep the boundary TypeBox-native and use JSON Schema as the portable
representation.

## Repo Policy

Inside apps declare collection fields and action inputs with `defineCollection`, `defineAction`, and `field` from `@epicenter/app`. The [writing app](../../../examples/writing/epicenter.ts) uses those declarations for the same actions the CLI and MCP expose. The [field helpers](../../../packages/app/src/field.ts) produce TypeBox schemas. Raw TypeBox fits alongside them when a field needs another JSON Schema shape. Use Arktype for local runtime
validation, request parsing, env/config parsing, persisted UI state, transforms,
and branded domain values.

## References

- [TypeBox is a Beast](../../../docs/articles/typebox-is-a-beast.md)
- [The Schema Wars Just Shifted](../../../docs/articles/20260429T120000-typebox-standard-schema-pivot.md)
