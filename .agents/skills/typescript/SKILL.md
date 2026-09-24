---
name: typescript
description: Apply project conventions for TypeScript types, imports, generics, factories, and runtime schemas. Use when editing `.ts` files or reviewing TypeScript design and tests.
metadata:
  author: epicenter
  version: '2.0'
---

# TypeScript Guidelines

Project-wide TypeScript conventions compose with narrower skills such as `arktype`, `typebox`, `testing`, and `method-shorthand-jsdoc`.

## Core Rules

- Try to derive or import a type before declaring a new named type. New named types must earn their place as a real contract, protocol vocabulary, discriminated result union, capability port, or multi-implementation shape.
- Treat local shape copies as boundary smells. Prefer the owning runtime type, schema inference, factory return type, function signature, or a caller-owned capability function.
- Compose types upward from a named base: extend with `Base & Extra`, never subtract-and-replace with `Omit<Base, 'k'> & { k: U }`. An `Omit<...> &` in a type you author is structural override; it is the tell that a smaller base wants a name. To narrow a surface, return that base rather than `Omit`-ing a member away. See [project conventions](references/project-conventions.md).
- Use `type`, not `interface`.
- Use `readonly` only for arrays and maps, unless matching an upstream type exactly.
- Treat acronyms as normal words in camelCase: `parseUrl`, `defineTable`, `readJson`, `customerId`.
- Use `.js` extensions in relative imports. Do not use extensionless or `.ts` relative imports.
- Export symbols at their declarations. Reserve `export { ... } from ...` for barrel files.
- In React/TSX, prefer named function components with explicit props parameters over `React.FC`/`FunctionComponent`; only type component values when you are storing them in a registry or passing them as data.
- Prefer factory functions over classes. Let closure position communicate private vs public API.
- Use descriptive generic names with a `T` prefix, such as `TSchema`, `TDefs`, and `TKey`.
- Destructure options in the function signature when the object is a configuration bag. Keep a named value only when it is the domain object being transformed or forwarded.
- Let TypeScript infer private and inner return types. Annotate exported APIs only when useful for clarity or to break circular inference.
- If an exported type is exactly the object returned by a `create*`, `attach*`, `open*`, or similar factory, derive it from the implementation with `ReturnType<typeof createThing>`. Put the exported output alias immediately after the factory. Keep input, config, data, protocol, and multi-implementation contract types above the factory.
- Move consumer-facing JSDoc onto the returned object members. Add concrete member annotations inside the returned object when they preserve IntelliSense, narrow an implementation detail, or keep a public method/property surface stable.
- For curried factories, derive from the inner return, such as `ReturnType<ReturnType<typeof createThing>>`. For generic factories, instantiate `typeof` when needed, such as `ReturnType<typeof openThing<TActions>>`.
- Preserve intentional readonly public surfaces with getters when deriving from an object literal. Do not expose writable internal state just because the concrete implementation happens to store it that way.
- Use a `Symbol` brand when identity means a specific factory output, not a coincidental shape probe.
- Avoid `as any`. Use `unknown`, validation, brands, or narrower helpers instead.
- Prefer optional chaining over `in` checks or truthiness when checking optional properties.
- Use `is`, `has`, or `can` prefixes for booleans that answer a question.
- Prefer `switch` over `if/else` for repeated equality comparisons against the same value. Use `default: value satisfies never` for exhaustiveness when needed.
- Prefer `Record` lookup tables over nested ternaries for finite value mappings.
- Compose typed errors bottom-up. Do not filter a broad upstream error union at the boundary.
- Question silent fallbacks that hide invalid state. Preserve round-trip invariants when parsing and serializing.

## Go-to-Definition Awareness

When organizing types and exports, always consider Go-to-Definition. A developer pressing Go-to-Def from a call site should land as close as possible to the actual source of truth. If a design choice forces an extra navigation hop, the choice has to earn it elsewhere (e.g., a real validation boundary, a published contract, or a multi-implementation port).

Concrete regressions to watch for:

- **Destructure-re-export of a module-level object**: `const stub = { fn, gn } satisfies T; export const { fn, gn } = stub;` lands Go-to-Def on the destructuring line, not the real definition. Prefer per-export `satisfies` or a direct `export const fn = ... satisfies T['fn']`.
- **`typeof Real` annotation over `satisfies`**: `export const fn: typeof Real = unreachable` hides the underlying value's identity from navigation. `export const fn = unreachable satisfies typeof Real` keeps the value as the source of truth.
- **`: T` annotation over `satisfies` for a multi-impl port**: the complement of the rule above. When an interface `T` has several impls (a `#platform/*` or browser/tauri split) and one impl is deliberately narrower than `T` (e.g. ignores a param the contract declares), `export const x = {...} satisfies T` leaks that narrow concrete type, so a caller's view of the method changes by platform. Annotate `export const x: T = {...}` to publish the wide contract, and the narrower impl still type-checks. Reference: whispering's `ManualRecorderLive: RecorderService<...>` (unary CPAL impl behind a binary contract).
- **Re-export chains in non-barrel files**: `export { X } from './alias'` outside `index.ts` costs an extra hop with nothing to show for it. Reserve `export { ... } from ...` for barrels; export at the declaration everywhere else.
- **Adapter / proxy / wrapper with no behavior change**: a `fromX` translator or thin passthrough makes Go-to-Def land on the wrapper. Widen the underlying factory's return shape instead (see `factory-function-composition` "collapsed adapter" rule).
- **Manual return type annotation duplicating zone 4**: annotating a factory with a hand-written interface diverts Go-to-Def to the alias. Let the factory return its concrete object, then put the exported alias directly after it as `export type Thing = ReturnType<typeof createThing>`. This keeps navigation on the returned members and lets their JSDoc own the public documentation. See `method-shorthand-jsdoc`.
- **Noisy `satisfies` generic lists**: if a return object should prove it extends a generic contract but `satisfies Contract<A, B, C> & Extras` forces callers to restate inferred table, action, or runtime types, prefer a constrained identity helper owned by the contract module. Example: `return defineWorkspace({ ...workspace, ...runtime })` where the helper accepts `TWorkspace extends Workspace<...>` and returns `TWorkspace`. This keeps the call site readable, preserves the exact inferred return type, and leaves Go-to-Def on the real object members.
- **When not to add `defineX`**: do not wrap a simple `satisfies` check just to give it a helper name. If the contract has no required type arguments, or its generics have defaults that make `satisfies Contract` readable, prefer `satisfies`. The helper only earns the extra name when it removes generic noise the reader would otherwise have to carry.

For broader public-shape decisions that affect navigation across packages, see `rethink`.

## Reference Map

- [Project conventions](references/project-conventions.md): detailed examples for derived types, local shape copies, imports, barrels, factories, generics, destructuring, and factory return types.
- [Type safety and control flow](references/type-safety-and-control-flow.md): identity brands, casts, optional properties, boolean naming, switches, record lookups, error composition, fallback smells, and round-trip invariants.
- [Type organization](references/type-organization.md): `types.ts` location, co-location rules, inline-vs-extract hop test, options and ID naming.
- [Factory patterns](references/factory-patterns.md): factory-focused refactors, parameter destructuring, and coupled state extraction.
- [Runtime schema patterns](references/runtime-schema-patterns.md): arktype, branded IDs, optional property syntax, and workspace table IDs.
- [Testing patterns](references/testing-patterns.md): inline single-use setup and source-shadowing tests.
- [Advanced TypeScript features](references/advanced-typescript-features.md): iterator helpers and const generic array inference.
