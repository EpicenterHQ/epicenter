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
`schema['~standard']`. If a boundary accepts Standard Schema, use a schema
library that implements it natively. If a boundary owns TypeBox
schemas, keep the boundary TypeBox-native and use JSON Schema as the portable
representation.

## Repo Policy

Inside apps declare data fields and action inputs with `defineData`, `defineAction`, and `field` from `@epicenter/app`. An app's actions, declared with them, are the same actions the CLI and MCP expose. The [field helpers](../../../packages/app/src/field.ts) produce TypeBox schemas. Raw TypeBox fits alongside them when a field needs another JSON Schema shape.
