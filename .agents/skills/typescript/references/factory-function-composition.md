# Factory Function Composition

This skill helps you apply factory function patterns for clean dependency injection and function composition in TypeScript.

> **Related Skills**: See [refactoring methods](../../collapse-pass/references/refactoring-methods.md) for caller counting and inlining single-use extractions.

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

## The Core Pattern

```typescript
// Single dependency
function createService({ client }, options = {}) {
	return {
		method(methodOptions) {
			// Uses client, options, and methodOptions
		},
	};
}

// Multiple dependencies
function createService({ db, cache }, options = {}) {
	return {
		method(methodOptions) {
			// Uses db, cache, options, and methodOptions
		},
	};
}

// Usage
const client = createClient(clientOptions);
const service = createService({ client }, serviceOptions);
service.method(methodOptions);
```

## Key Principles

1. **Client configuration belongs at client creation time**: don't pipe clientOptions through your factory
2. **Each layer has its own options**: client, service, and method options stay separate
3. **Name injected dependencies**: pass them through a destructured object, even when there is only one
4. **Return objects with methods**: not standalone functions that need the resource passed in

## Recognizing the Anti-Patterns

### Anti-Pattern 1: Function takes client as first argument

```typescript
// Bad
function doSomething(client, options) { ... }
doSomething(client, options);

// Good
const service = createService({ client });
service.doSomething(options);
```

### Anti-Pattern 2: Client creation hidden inside

```typescript
// Bad
function doSomething(clientOptions, methodOptions) {
	const client = createClient(clientOptions); // Hidden!
	// ...
}

// Good
const client = createClient(clientOptions);
const service = createService({ client });
service.doSomething(methodOptions);
```

### Anti-Pattern 3: Mixed options blob

```typescript
// Bad
doSomething({
	timeout: 5000, // Client option
	retries: 3, // Client option
	endpoint: '/users', // Method option
	payload: data, // Method option
});

// Good
const client = createClient({ timeout: 5000, retries: 3 });
const service = createService({ client });
service.doSomething({ endpoint: '/users', payload: data });
```

### Anti-Pattern 4: Multiple layers hidden

```typescript
// Bad
function doSomething(clientOptions, serviceOptions, methodOptions) {
	const client = createClient(clientOptions);
	const service = createService({ client }, serviceOptions);
	return service.method(methodOptions);
}

// Good: each layer visible and configurable
const client = createClient(clientOptions);
const service = createService({ client }, serviceOptions);
service.method(methodOptions);
```

## Multiple Dependencies

When your service needs multiple clients:

```typescript
function createService(
	{ db, cache, http }, // Dependencies as destructured object
	options = {}, // Service options
) {
	return {
		method(methodOptions) {
			// Uses db, cache, http
		},
	};
}

// Usage
const db = createDbConnection(dbOptions);
const cache = createCacheClient(cacheOptions);
const http = createHttpClient(httpOptions);

const service = createService({ db, cache, http }, serviceOptions);
service.method(methodOptions);
```

## The Canonical Internal Shape

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

### Derive public types from the return object

When the exported type is just the handle returned by one factory, derive the type from the factory instead of annotating the factory with the type.

[Whispering’s factory](../../../../apps/whispering/src/lib/whispering.svelte.ts) gives callers a name for the handle it returns.

```typescript
export type Whispering = ReturnType<typeof createWhispering>;
```

The return object already defines the public API. Duplicating it in a manual return type creates a second source of truth and changes editor navigation: Go to Definition tends to jump to the alias instead of the returned member. Keep method parameter and return annotations on the returned operations when they make the public surface clearer.

This is one face of a broader principle: when organizing types and exports, always consider Go-to-Definition. See [TypeScript guidance](../SKILL.md#go-to-definition-awareness) for the broader navigation rule.

Do not use this for shared service contracts that several factories implement. Those contracts are vocabulary. Use `satisfies` at the return object when a factory needs to prove it matches an external contract while preserving the concrete returned shape.

### Compose operations through the closure

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

See [method documentation and sibling calls](method-documentation-and-sibling-calls.md)
for documentation behavior and receiver requirements in existing APIs.

## The Mental Model

Think of it as a chain where each link:

- Receives a resource from the previous link
- Adds its own configuration
- Produces something for the next link

```
createClient(...)  →  createService({ client }, ...)  →  service.method(...)
     ↑                            ↑                           ↑
 clientOptions               serviceOptions              methodOptions
```

## Benefits

- **Testability**: Inject mock clients easily
- **Reusability**: Share clients across multiple services
- **Flexibility**: Configure each layer independently
- **Clarity**: Clear ownership of configuration at each level

## References

Read [method documentation and sibling calls](method-documentation-and-sibling-calls.md)
when documenting returned operations or working with receiver-dependent
methods in existing APIs.
