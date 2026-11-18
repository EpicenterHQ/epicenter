# Editor experience

Read this when an annotation, alias, wrapper, or contract changes what callers
see in autocomplete, hover, compiler errors, or Go to Definition.

## Preserve information callers can use

TypeScript [infers function return types from their returned values](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#return-type-annotations).
Our convention is to keep that inference when the implementation owns the shape.
Name a contract when it has a meaning independent of one implementation.

The [satisfies operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
checks compatibility while retaining the expression's specific members. An
export annotated with a shared type instead publishes that contract to callers.
Choose which view the API needs; check the actual consumer when contextual
inference or several implementations are involved.

For example, this complete factory owns its returned shape and public docs:

```typescript
export function createCounter({ initial = 0 } = {}) {
	let count = initial;
	/** Increase the count and return its new value. */
	const increment = () => ++count;
	return {
		increment,
		value() {
			return count;
		},
	};
}

export type Counter = ReturnType<typeof createCounter>;

const counter: Counter = createCounter();
counter.increment();
```

On the last call, hover should show the numeric result and the operation's
JSDoc. Go to Definition should reach the implementation. Adding a duplicate
handwritten Counter type would create another declaration to maintain and
can redirect navigation. TypeScript 5.9.3's language service was checked for
this example; editor commands can differ, so inspect the consumer when the
shape crosses an annotation, wrapper, or re-export.

A shared port is different. If browser and desktop implementations must expose
the same API, publish the shared contract even when one implementation accepts
fewer arguments. Keep the concrete implementation private when callers should
not depend on its narrower shape.

## Navigation regressions

Concrete regressions to watch for:

- **Destructure-re-export of a module-level object**: `const stub = { fn, gn } satisfies T; export const { fn, gn } = stub;` lands Go-to-Def on the destructuring line, not the real definition. Prefer per-export `satisfies` or a direct `export const fn = ... satisfies T['fn']`.
- **`typeof Real` annotation over `satisfies`**: `export const fn: typeof Real = unreachable` hides the underlying value's identity from navigation. `export const fn = unreachable satisfies typeof Real` keeps the value as the source of truth.
- **`: T` annotation over `satisfies` for a multi-impl port**: the complement of the rule above. When an interface `T` has several impls (such as a browser and desktop recorder) and one impl is deliberately narrower than `T` (e.g. ignores a param the contract declares), `export const x = {...} satisfies T` leaks that narrow concrete type, so a caller's view of the method changes by platform. Annotate `export const x: T = {...}` to publish the wide contract, and the narrower impl still type-checks. The [recorder package](../../../../packages/recorder/src/index.ts) exports `recorder: Recorder` for both implementations.
- **Re-export chains in non-barrel files**: `export { X } from './alias'` outside `index.ts` costs an extra hop with nothing to show for it. Reserve `export { ... } from ...` for barrels; export at the declaration everywhere else.
- **Adapter / proxy / wrapper with no behavior change**: a `fromX` translator or thin passthrough makes Go-to-Def land on the wrapper.
- **Manual return type annotation duplicating the return object**: annotating a factory with a hand-written interface diverts Go-to-Def to the alias. Let the factory return its concrete object, then put the exported alias directly after it as `export type Thing = ReturnType<typeof createThing>`. This keeps navigation on the returned members and lets their JSDoc own the public documentation. See [factory method documentation](method-documentation-and-sibling-calls.md) when hover or navigation is in question.
- **Noisy `satisfies` generic lists**: if a return object should prove it extends a generic contract but `satisfies Contract<A, B, C> & Extras` forces callers to restate inferred table, action, or runtime types, prefer a constrained identity helper owned by the contract module. Have the helper accept and return the same constrained type parameter. This keeps the call site readable, preserves the exact inferred return type, and leaves Go-to-Def on the real object members.
- **When not to add `defineX`**: do not wrap a simple `satisfies` check just to give it a helper name. If the contract has no required type arguments, or its generics have defaults that make `satisfies Contract` readable, prefer `satisfies`. The helper only earns the extra name when it removes generic noise the reader would otherwise have to carry.

For factory output aliases, including curried, generic, and asynchronous
factories, see [factory function composition](factory-function-composition.md#derive-public-types-from-the-return-object).
For JSDoc propagation and existing receiver-dependent APIs, see
[method documentation and sibling calls](method-documentation-and-sibling-calls.md).
