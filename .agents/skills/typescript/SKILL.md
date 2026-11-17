---
name: typescript
description: Write idiomatic TypeScript that preserves useful inference, makes APIs clear to callers, and keeps editor navigation close to the source of truth. Use when editing TypeScript, designing function and factory APIs, documenting returned methods, or reviewing types, inference, and editor behavior, including constraints that need to identify an invalid literal in a compiler error.
metadata:
  author: epicenter
  version: '2.0'
---

# TypeScript

Keep inputs, outputs, and dependencies easy to follow. Derive types from
the values, functions, and schemas that own them when possible. Introduce
explicit types for meaningful contracts and concepts.

Judge an API from its call sites as well as its implementation: what does
autocomplete offer, what does hover explain, and where does Go to Definition
lead?

Use [services-layer](../services-layer/SKILL.md) when deciding which operations
belong together and what their callers should supply. Use
[query-layer](../query-layer/SKILL.md) when adapting those operations for caching
and observable execution state. Schema libraries and tests have their own
skills: [arktype](../arktype/SKILL.md), [typebox](../typebox/SKILL.md), and
[testing](../testing/SKILL.md).

## Core rules

### Types and contracts

- Try to derive or import a type before declaring a new named type. New named types must earn their place as a real contract, protocol vocabulary, discriminated result union, capability port, or multi-implementation shape.
- Treat local shape copies as boundary smells. Prefer the owning runtime type, schema inference, factory return type, function signature, or a caller-owned capability function.
- Compose types upward from a named base: extend with `Base & Extra`, never subtract-and-replace with `Omit<Base, 'k'> & { k: U }`. An `Omit<...> &` in a type you author is structural override; it is the tell that a smaller base wants a name. To narrow a surface, return that base rather than `Omit`-ing a member away. See [project conventions](references/project-conventions.md).
- Use `type`, not `interface`.
- Use `readonly` only for arrays and maps, unless matching an upstream type exactly.
- Use descriptive generic names with a `T` prefix, such as `TSchema`, `TDefs`, and `TKey`.
- Let TypeScript infer private and inner return types. Annotate exported APIs only when useful for clarity or to break circular inference.
- If an exported type is exactly the object returned by a `create*`, `attach*`, `open*`, or similar factory, derive it from the implementation with `ReturnType<typeof createThing>`. Put the exported output alias immediately after the factory. Keep input, config, data, protocol, and multi-implementation contract types above the factory.
- Use a `Symbol` brand when identity means a specific factory output, not a coincidental shape probe.

### Functions and objects

- Prefer factory functions over classes. Let closure position communicate private vs public API.
- Pass injected dependencies through a destructured object in the function signature, even for one dependency: `createMailbox({ db })`, never `createMailbox(db)`. Function-valued dependencies follow the same convention: `createSession({ signOut })`.
- Destructure options in the function signature when the object is a configuration bag or dependency object. Keep a named value only when it is the domain object being transformed or forwarded.
- For new or deliberately redesigned APIs, prefer explicit read methods for live or computed values, named for what they answer: `items()`, `state()`, `isLocked()`. Ordinary data stays in properties. The methods hold in Svelte too: `reactive` from `@epicenter/svelte/reactive` keeps a capability's methods and makes them track ([svelte](../svelte/SKILL.md)), so there is no getter facade. A capability's actions answer promises, even an instant one (ADR-0769). Existing getters and upstream-required shapes are current contracts; keep them unless the API is being redesigned, and do not add wrappers or duplicate spellings just for this convention. Keep writable internal state private rather than exposing it because the implementation happens to store it that way.

### Modules and names

- Treat acronyms as normal words in camelCase: `parseUrl`, `defineKv`, `readJson`, `customerId`.
- Give relative imports an explicit extension, the one the package already uses: for example, `.ts` in `packages/app` and `.js` in `packages/account`.
- Export symbols at their declarations. Reserve `export { ... } from ...` for barrel files.
- In React/TSX, prefer named function components with explicit props parameters over `React.FC`/`FunctionComponent`; only type component values when you are storing them in a registry or passing them as data.
- Use `is`, `has`, or `can` prefixes for booleans that answer a question.

### Control flow and values

- Avoid `as any`. Use `unknown`, validation, brands, or narrower helpers instead.
- Make required values required, and keep values optional when their absence is meaningful. Put defaults where they belong, usually in the function that defines the behavior, rather than repeating them across callers. Use optional chaining and `??` when they express an intentional choice.
- When different cases require different data, model them as a discriminated union. Checking the discriminator should make the corresponding data available.
- For Wellcrafted Results, check `error !== null` for failure.
- Prefer `switch` over `if/else` for repeated equality comparisons against the same value. Use `default: value satisfies never` for exhaustiveness when needed.
- Prefer `Record` lookup tables over nested ternaries for finite value mappings.
- Compose typed errors bottom-up. Do not filter a broad upstream error union at the boundary. See `error-handling` for Result propagation, recovery, and presentation.
- Question silent fallbacks that hide invalid state. Preserve round-trip invariants when parsing and serializing.

## Factory function composition

> When you see two functions that share the same first argument, it is usually a sign that the functions want to be grouped. Pass that shared argument into a service or factory function once, then return methods that only take the values that change per call. If the methods need lifecycle or cached state, put that mutable state in the closure between the factory declaration and the returned object.

Implement behavior directly in the returned methods; avoid forwarding to helpers
that merely take the same dependencies again. See
[factory function composition](references/factory-function-composition.md) for
signatures, parameter binding, instance setup, inferred return types, and
closure-based methods. Read [stateful factory examples](references/factory-patterns.md)
when repeated state management suggests a separate responsibility.

## Go-to-definition awareness

When organizing types and exports, always consider Go-to-Definition. A developer pressing Go-to-Def from a call site should land as close as possible to the actual source of truth. If a design choice forces an extra navigation hop, the choice has to earn it elsewhere (e.g., a real validation boundary, a published contract, or a multi-implementation port).

- Keep consumer-facing JSDoc on the implementation a caller reaches: an inline returned method, or a named function exposed through property shorthand. Add concrete member annotations inside the returned object when they preserve IntelliSense, narrow an implementation detail, or keep a public method/property surface stable.

Check the consumer's autocomplete, hover documentation, inferred data and error
types, and navigation. Add an annotation or boundary when it supplies information
callers need. Keep an inferred shape when another declaration would repeat it
or hide useful details. The [editor experience reference](references/editor-experience.md)
shows the navigation regressions and the tradeoff between an inferred object
and a shared contract. Read
[method documentation and sibling calls](references/method-documentation-and-sibling-calls.md)
when documenting returned operations or working with receiver-dependent APIs.

For broader public-shape decisions that affect navigation across packages, see
[rethink](../rethink/SKILL.md).

## Reference map

- [Factory function composition](references/factory-function-composition.md): dependency and configuration inputs, parameter binding, instance setup, returned methods, and inferred public types.
- [Stateful factory examples](references/factory-patterns.md): deciding whether shared state and repeated work deserve an internal factory.
- [Editor experience](references/editor-experience.md): inference, explicit contracts, autocomplete, hover, and Go to Definition.
- [Method documentation and sibling calls](references/method-documentation-and-sibling-calls.md): documentation on returned operations and receiver requirements in existing APIs.
- [Project conventions](references/project-conventions.md): examples for derived types, local shape copies, imports, barrels, generics, and inference.
- [Type safety and control flow](references/type-safety-and-control-flow.md): identity brands, casts, optional properties, boolean naming, switches, record lookups, error composition, and invariants.
- [Type organization](references/type-organization.md): type ownership, co-location, factory output aliases, and the cost of extraction.
- [Runtime schema patterns](references/runtime-schema-patterns.md): arktype, branded IDs, optional property syntax, and record ids.
- [Testing patterns](references/testing-patterns.md): inline single-use setup and source-shadowing tests.
- [Advanced TypeScript features](references/advanced-typescript-features.md): iterator helpers and const generic array inference.
- [Readable constraint errors](references/readable-constraint-errors.md): identifying an invalid literal key or string in a compiler diagnostic.
