---
name: typebox
description: TypeBox in Epicenter: the `typebox` package name, why TypeBox schemas are not Standard Schema, and when to use TypeBox versus Arktype. Use when mentioning TypeBox or `Type.*` schemas.
metadata:
  author: epicenter
  version: '1.0'
---

# TypeBox

Import from `typebox` and `typebox/value`. `@sinclair/typebox` is the deprecated name.

TypeBox does not implement Standard Schema: `schema['~standard']` is undefined. A boundary that needs Standard Schema takes an Arktype schema. A boundary that owns TypeBox schemas stays TypeBox-native and uses JSON Schema as the portable form.

Inside apps, declare data fields and action inputs with `defineData`, `defineAction`, and `field` from `@epicenter/app`. The [field helpers](../../../packages/app/src/field.ts) produce TypeBox schemas, and raw `Type.*` fits beside them when a field needs another JSON Schema shape. Use Arktype for local runtime validation, request parsing, env and config parsing, persisted UI state, transforms, and branded domain values.
