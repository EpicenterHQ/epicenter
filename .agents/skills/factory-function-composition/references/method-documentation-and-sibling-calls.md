# Method documentation and sibling calls

Use this reference when a factory exposes a documented operation, when a public method calls another method, or when a consumer's hover or Go to Definition lands in the wrong place.

## Put public documentation at the public surface

An inferred return object can carry JSDoc from a separately declared function assigned through property shorthand. Method shorthand is not required for hover documentation. In TypeScript 5.9.3, the language service shows `Return the current count.` for `counter.current()` in this shape:

```ts
function createCounter() {
	/** Return the current count. */
	function current() {
		return 0;
	}

	return { current };
}

type Counter = ReturnType<typeof createCounter>;
declare const counter: Counter;
counter.current();
```

Prefer a documented method or getter in the return object when that is the clearest definition of the public API. A method used only through the public object can live there directly:

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

Keep a helper in the private zone when initialization or other private code calls it, or when it implements shared internal behavior. If the public contract needs different wording, put it on a returned method that calls the helper. In TypeScript 5.9.3, JSDoc on an aliasing property such as `/** Public wording. */ current: readCount` did not replace `readCount`'s own JSDoc in the consumer hover. Check the actual hover and navigation when an explicit return type, wrapper, or re-export intervenes. `ReturnType<typeof createCounter>` preserves the inferred members; a separate interface can redirect navigation to the interface.

## Choose sibling calls by receiver requirements

Use `this.current()` from a method shorthand member when calling through the returned object is part of the contract. This lets an override of `current` affect the sibling call, but it requires the receiver: `counter.bump()` works and an extracted `const { bump } = counter; bump()` may not. Arrow properties capture lexical `this`, so `this.current()` inside an arrow does not refer to the returned object.

An epoch counter shows the complete public-method shape. Both documented operations belong on the returned object; `bumpEpoch` calls `getEpoch` through that object:

```ts
function createEpochCounter(epochs: Map<string, number>, clientId: string) {
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

Use a direct closure call when the operation must work after extraction or when the called function also runs during initialization:

```ts
function createCounter() {
	let count = 0;
	/** Return the current count. */
	function current() {
		return count;
	}

	return {
		current,
		bump() {
			count = current() + 1;
			return count;
		},
	};
}
```

The direct call always invokes the closure's `current`, even if a consumer replaces `counter.current`. Choose that behavior deliberately. The [four-zone factory anatomy](../SKILL.md#the-canonical-internal-shape) explains the private helper and public return-object positions.
