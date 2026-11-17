# Method documentation and sibling calls

Use this reference when a factory exposes a documented operation, when a public method calls another method, or when a consumer's hover or Go to Definition lands in the wrong place.

## Put public documentation at the public surface

An inferred return object can carry JSDoc from a `const` arrow function exposed through property shorthand. Method shorthand is not required for hover documentation. In TypeScript 5.9.3, the language service shows `Return the current count.` for `counter.current()` in this shape:

```ts
function createCounter() {
	/** Return the current count. */
	const current = () => {
		return 0;
	};

	return { current };
}

type Counter = ReturnType<typeof createCounter>;
declare const counter: Counter;
counter.current();
```

Keep a documented method in the return object when it can express its operation directly. Methods that use closed-over state without `this` also work after extraction. Follow the [read API convention](../SKILL.md#core-rules) for live and computed reads:

```ts
function createCounter() {
	let count = 0;

	return {
		/** Return the current count. */
		current() {
			return count;
		},
		bump() {
			return ++count;
		},
	};
}
```

Declare operations shared by initialization or other methods as `const` arrow functions inside the factory. Expose a public operation through property shorthand; its implementation and JSDoc stay together. If the public contract needs different wording, put it on a returned method that calls the internal function. In TypeScript 5.9.3, JSDoc on an aliasing property such as `/** Public wording. */ current: readCount` did not replace `readCount`'s own JSDoc in the consumer hover. Check the actual hover and navigation when an explicit return type, wrapper, or re-export intervenes. `ReturnType<typeof createCounter>` preserves the inferred members; a separate interface can redirect navigation to the interface.

## Call shared operations through the closure

Prefer public methods that work without a receiver. When one method needs another operation, call a named arrow function in the closure. The operation can also be returned as a public method:

```ts
function createCounter() {
	let count = 0;
	/** Return the current count. */
	const current = () => count;
	const increment = () => ++count;

	return {
		current,
		increment,
		incrementTwice() {
			increment();
			return increment();
		},
	};
}

const { current, incrementTwice } = createCounter();
incrementTwice(); // 2
current(); // 2
```

The extracted functions still share the same `count`. `const` keeps each arrow function's binding fixed; the function can change the captured `let` state. Initialize the arrow functions before calling them during construction. An internal function may stay private or be exposed through the return object; the [three-part factory structure](factory-function-composition.md#the-canonical-internal-shape) distinguishes its declaration from its exposure.

A closure call always invokes the original function, even if a consumer replaces the corresponding method on the returned object.

## Use receiver dispatch when replacement is part of the contract

Use `this.current()` when replacing or wrapping the returned object's `current` method is intended to affect its siblings. A call through the object, such as `counter.bump()`, supplies the receiver. An extracted call or callback needs a bound function or a wrapper such as `() => counter.bump()`.

This epoch counter deliberately calls the object's current `getEpoch` method, so a replacement of `getEpoch` changes how `bumpEpoch` computes its next value:

```ts
function createEpochCounter({
	epochs,
	clientId,
}: {
	epochs: Map<string, number>;
	clientId: string;
}) {
	return {
		/** Return the highest proposed epoch, or zero if there are none. */
		getEpoch(): number {
			return Math.max(0, ...epochs.values());
		},

		/** Record this client's next proposed epoch. */
		bumpEpoch(): number {
			const next = this.getEpoch() + 1;
			epochs.set(clientId, next);
			return next;
		},
	};
}
```

An arrow member can carry JSDoc, but `bumpEpoch: () => this.getEpoch() + 1` would read the surrounding lexical `this` instead of this returned object.
