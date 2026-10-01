# Documenting Returned Factory Methods

A factory's returned object is its public API. Put consumer-facing JSDoc where a reader can find the operation, and choose the call style that matches how consumers use the object. Method shorthand is useful for both, but TypeScript does not require it to preserve JSDoc.

## What TypeScript shows

TypeScript 5.9.3 shows the helper's JSDoc on `counter.current()` even when the returned object uses property shorthand:

```ts
function createCounter() {
	let count = 0;

	/** Return the current count. */
	function current() {
		return count;
	}

	return { current };
}

type Counter = ReturnType<typeof createCounter>;
declare const counter: Counter;
counter.current();
```

If the public wording differs from the helper's purpose, put that documentation on a returned method:

```ts
return {
	/** Return the current count. */
	current() { return readCount(); },
};
```

In TypeScript 5.9.3, JSDoc on an aliasing property did not replace the helper's own JSDoc in the consumer hover.

When an operation belongs only to the public object, method shorthand puts its implementation and documentation at that surface:

```ts
function createCounter() {
	let count = 0;

	return {
		/** Return the current count. */
		current() {
			return count;
		},
	};
}
```

Keep a separate helper when initialization or private code also calls it. `ReturnType<typeof createCounter>` retains the inferred members and their documentation. A separate return interface, wrapper, or re-export can change where Go to Definition lands, so inspect the actual call site when navigation matters.

## Calling a sibling method

A method shorthand member receives the returned object as `this` when called through that object:

```ts
return {
	current() { return count; },
	bump() { return this.current() + 1; },
};
```

That call follows a replacement of `current`, but extracting `bump` loses its receiver. An arrow property does not acquire the returned object as `this`. If extraction must work, or the helper also runs during initialization, call a closure directly:

```ts
function current() { return count; }
return {
	current,
	bump() { return current() + 1; },
};
```

This direct call keeps using the closure's `current` even if a consumer replaces the public property. Decide which behavior the factory promises before moving a helper into the return object. For the concise decision rule, see the [factory composition reference](../../.agents/skills/factory-function-composition/references/method-documentation-and-sibling-calls.md).
