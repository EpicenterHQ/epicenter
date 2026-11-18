# Factory function composition

Read this when implementing a factory, binding its inputs, or exposing its
methods and public type. Use [services-layer](../../services-layer/SKILL.md)
when deciding which operations belong together or whether they need an instance.

## The universal factory signature

A factory takes its dependencies first, as a destructured object, followed
by a configuration object. Name dependencies even when there is only one.

```typescript
const service = createService({ client }, { retries: 3 });
```

Dependencies are the resources the factory works with. Configuration
controls the behavior of the object it creates. Inputs for individual
operations belong on its returned methods.

```typescript
service.search({ text: 'hello' }); // Input for this operation.
```

Omit any argument the factory does not need. With no dependencies,
configuration becomes the first argument. With neither dependencies nor
configuration, the factory takes no arguments.

```typescript
// Dependencies only.
createService({ client });

// Configuration only.
createBackoff({ maxRetries: 3 });

// Neither.
createCounter();
```

## Bind inputs at construction

Destructure dependency and configuration bags in the signature. Keep a domain
value named when it is being transformed or forwarded as a whole. Body
destructuring can be useful when setup validates or normalizes the whole
object, or needs to inspect whether a property was supplied.

Keep resource configuration where the resource is created. The next factory
receives the working resource and its own configuration. Per-call inputs
belong on the returned operations.

This complete in-memory example captures one map and one search default:

```typescript
type Message = { id: string; body: string };

export function createMailbox(
	{ messages }: { messages: Map<string, Message> },
	{ limit = 20 } = {},
) {
	return {
		get(id: string) {
			return messages.get(id);
		},
		search({ text }: { text: string }) {
			return [...messages.values()]
				.filter((message) => message.body.includes(text))
				.slice(0, limit);
		},
	};
}

export type Mailbox = ReturnType<typeof createMailbox>;

const messages = new Map([
	['m1', { id: 'm1', body: 'hello' }],
	['m2', { id: 'm2', body: 'goodbye' }],
]);
const mailbox = createMailbox({ messages }, { limit: 10 });
mailbox.get('m1'); // { id: 'm1', body: 'hello' }
mailbox.search({ text: 'hello' }); // the first message
```

The factory already has the map. Its methods use it directly. Avoid moving
their bodies into helpers that require the same dependencies passed again.
Extract a function when it names useful shared work or an independently
useful operation. Pure data transformations can remain standalone functions.
A useful function-valued dependency can stay a function:
`createSession({ signOut })` does not require a larger account object.

## The canonical internal shape

A factory initializes an instance, defines any internal functions it needs,
and returns its public API. Instance setup includes values computed during
construction and state retained between calls. Declare internal functions
as `const` arrow functions. Expose them through property shorthand when
they are public, and keep self-contained public methods inline.

Follow that reading order where practical, keeping related declarations
together and initializing dependencies before they are used. Omit any part
the factory does not need, and return the public API last.

Mutable state includes objects whose contents change, such as a `Map`,
even when their bindings use `const`.

```typescript
function createCounter({ initial = 0, step = 1 } = {}) {
	// Instance setup
	let count = initial;

	// Internal functions
	const increment = () => {
		count += step;
		return count;
	};

	// Public API
	return {
		value() {
			return count;
		},
		increment,
		incrementTwice() {
			increment();
			return increment();
		},
	};
}
```

An internal function can stay private or become public through property
shorthand, as `increment` does here. The return object decides whether
callers can reach it. The comments label the three parts for illustration;
ordinary factories do not need section labels.

## Derive public types from the return object

When an exported type is exactly the handle returned by one factory, derive
it from the implementation. Put the output alias immediately after the factory,
as the mailbox example does. Keep input, domain, and shared contract types above
it. TypeScript's [ReturnType and Awaited utilities](https://www.typescriptlang.org/docs/handbook/utility-types.html)
supply the derivation; this placement is our navigation convention.

| Factory shape | Output type |
| --- | --- |
| Ordinary | `ReturnType<typeof createThing>` |
| Generic | `ReturnType<typeof createThing<TActions>>` |
| Curried | `ReturnType<ReturnType<typeof createThing>>` |
| Asynchronous | `Awaited<ReturnType<typeof openThing>>` |

If the public type is a nested slice of a result, use a focused inference
helper rather than forcing the whole return shape into that name. Keep writable
internals private and expose read methods before deriving the public type.
Svelte reads through `reactive`, which retains those methods; existing getters
and upstream protocols remain contracts until an authorized redesign.

Keep explicit contract types for protocol vocabulary, several implementations,
or an intentionally narrower public API. Check with `satisfies` when callers
should retain the concrete inferred shape; annotate the exported value with the
shared contract when callers need the same surface across implementations.
See [editor experience](editor-experience.md) for this tradeoff and navigation.

## Compose operations through the closure

Declare internal operations as `const` arrow functions and call them by name.
Keep public methods inline when they can express their operation directly.
Return named operations by shorthand when they are public too.

New factory methods should work without `this`, so callers can destructure
them or pass them as callbacks. Extracting the counter's methods preserves
their shared state:

```typescript
const { value, incrementTwice } = createCounter({ step: 2 });
incrementTwice(); // 4
value(); // 4
```

Read [method documentation and sibling calls](method-documentation-and-sibling-calls.md)
for JSDoc behavior and receiver requirements in existing APIs. Read
[stateful factory examples](factory-patterns.md) when state management appears
to be a separate job with useful operations of its own.
