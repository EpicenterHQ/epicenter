---
name: factory-function-composition
description: Factory function patterns to compose clients and services. Use when wrapping resources with domain methods, refactoring mixed client/service/method options, or documenting returned factory methods.
metadata:
  author: epicenter
  version: '1.0'
---

# Factory Function Composition

This skill helps you apply factory function patterns for clean dependency injection and function composition in TypeScript.

> **Related Skills**: See `refactoring` for caller counting and inlining single-use extractions.

## The Universal Signature

**Every factory function follows this signature:**

```typescript
function createSomething(dependencies, options?) {
	return {
		/* methods */
	};
}
```

- **First argument**: Always the resource(s). Either a single client or a destructured object of multiple dependencies.
- **Second argument**: Optional configuration specific to this factory. Never client config; that belongs at client creation.

Two arguments max. First is resources, second is config. No exceptions.

## The Core Pattern

```typescript
// Single dependency
function createService(client, options = {}) {
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
const service = createService(client, serviceOptions);
service.method(methodOptions);
```

## Key Principles

1. **Client configuration belongs at client creation time**: don't pipe clientOptions through your factory
2. **Each layer has its own options**: client, service, and method options stay separate
3. **Dependencies come first**: factory functions take dependencies as the first argument
4. **Return objects with methods**: not standalone functions that need the resource passed in

## Recognizing the Anti-Patterns

### Anti-Pattern 1: Function takes client as first argument

```typescript
// Bad
function doSomething(client, options) { ... }
doSomething(client, options);

// Good
const service = createService(client);
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
const service = createService(client);
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
const service = createService(client);
service.doSomething({ endpoint: '/users', payload: data });
```

### Anti-Pattern 4: Multiple layers hidden

```typescript
// Bad
function doSomething(clientOptions, serviceOptions, methodOptions) {
	const client = createClient(clientOptions);
	const service = createService(client, serviceOptions);
	return service.method(methodOptions);
}

// Good: each layer visible and configurable
const client = createClient(clientOptions);
const service = createService(client, serviceOptions);
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

The previous sections cover the external signature: `(deps, options?) → return { methods }`. This section covers what goes *inside* the function body. Every factory function follows a four-zone ordering:

```typescript
// Option A: destructure in the signature (preferred for small dep lists)
function createSomething({ db, cache }: Deps, options?) {
	const maxRetries = options?.maxRetries ?? 3;
	// ...
}

// Option B: destructure in zone 1 (fine when you also need the deps object itself)
function createSomething(deps: Deps, options?) {
	const { db, cache } = deps;
	const maxRetries = options?.maxRetries ?? 3;
	// ...
}
```

Both are valid. The point is that by the time you reach zone 2, all dependencies and config are bound to `const` names. The four zones:

```typescript
function createSomething({ db, cache }, options?) {
	// Zone 1: Immutable state (const from deps/options)
	const maxRetries = options?.maxRetries ?? 3;

	// Zone 2: Mutable state (let declarations)
	let connectionCount = 0;
	let lastError: Error | null = null;

	// Zone 3: Private helpers
	function resetState() {
		connectionCount = 0;
		lastError = null;
	}

	// Zone 4: Public API (always last)
	return {
		connect() { ... },
		disconnect() { ... },
		get errorCount() { return connectionCount; },
	};
}
```

Zones 1 and 2 can merge when there's little state. Zone 3 is empty for small factories. But the return object is always last: it's the complete public API.

### Public Return Types Derive From Zone 4

When the exported type is just the handle returned by one factory, derive the type from the factory instead of annotating the factory with the type.

```typescript
export type RemoteClient = ReturnType<typeof createRemoteClient>;

export function createRemoteClient(options: RemoteClientOptions) {
	return {
		actions<T>(peerId: string): RemoteActionProxy<T> {
			// ...
		},
		describe(peerId: string): Promise<ActionManifest> {
			// ...
		},
	};
}
```

Zone 4 is already the public API. Duplicating it in a manual return type creates a second source of truth and changes editor navigation: Go to Definition tends to jump to the alias instead of the returned member. Keep method parameter and return annotations inside zone 4 when they make the public surface clearer.

This is one face of a broader principle: when organizing types and exports, always consider Go-to-Definition. Adapter / proxy / wrapper factories with no behavior change are another regression in the same family: Go-to-Def lands on the wrapper instead of the source of truth. The "collapsed adapter" rule below is its concrete remedy. See `typescript` "Go-to-Definition Awareness" for the full set of regressions to watch for.

Do not use this for shared service contracts that several factories implement. Those contracts are vocabulary. Use `satisfies` at the return object when a factory needs to prove it matches an external contract while preserving the concrete returned shape.

### The `this` Decision Rule

Inside the return object, public methods sometimes need to call other public methods. Use `this.method()` when the method is called on the returned object; method shorthand receives that object as its `this`. If callers extract the method, it loses that receiver. See [method documentation and sibling calls](references/method-documentation-and-sibling-calls.md) for the documentation and extraction tradeoffs.

If a function is called both by return-object methods *and* by pre-return initialization logic, it belongs in zone 3 (private helpers). Call it directly by name; no `this` needed.

| Where the function lives | How to call it |
|---|---|
| Return object (zone 4) | `this.method()` from sibling methods |
| Private helper (zone 3) | Direct call by name: `helperFn()` |
| Both zones need it | Keep in zone 3, call by name everywhere |

See [Closures Are Better Privacy Than Keywords](../../../docs/articles/closures-are-better-privacy-than-keywords.md) for the full rationale and real codebase examples.

## Structural Contracts: Factories That Satisfy External Interfaces

A factory's return object can be designed to **structurally satisfy** an external contract, so it can be passed directly to a platform-agnostic core without an adapter.

The canonical example is `createPersistedState` / `createStorageState`, whose return shape structurally satisfies the `SessionStore` contract that `@epicenter/auth`'s `createAuth` consumes:

```ts
// The contract (in a platform-agnostic core):
type SessionStore = {
  get(): T | null;
  set(value: T | null): void;
  watch(fn: (next: T | null) => void): () => void;
};

// The factory exposes BOTH a reactive accessor AND the contract methods:
function createPersistedState(opts) {
  let value = $state(readFromStorage());
  // ...
  return {
    get current() { return value },         // reactive read for templates
    set current(v) { setAndPersist(v) },
    get(): T { return value },              // contract: sync read
    set: setAndPersist,                     // contract: fire-and-forget write
    watch(fn) { /* ... */ },                // contract: change notification
  };
}

// Consumer: pass the factory result directly, no adapter:
const session = createPersistedState({ key, schema, defaultValue });
const auth = createAuth({ baseURL, session });
```

### The "collapsed adapter" rule

If you find yourself writing a `fromX` translator that only renames or re-projects fields, **delete it and widen the factory's return shape instead**. The adapter is pure ceremony; the factory already holds the state, so just expose both surfaces.

Signs an adapter should be collapsed:

- It's one-to-one with the factory (every caller wraps the factory result).
- It only renames methods or adds a thin passthrough.
- The factory and the contract disagree on shape but not on semantics (`.current` vs `.get()`: same value, different API).

Signs an adapter should stay:

- It does real work at the seam (e.g., sync-read-vs-async-get reconciliation, local-write fan-out because the underlying `watch` only fires on external change).
- Multiple consumers with different contracts wrap the same factory.

When in doubt: start without the adapter. Add one only when the seam actually earns its keep.

### Why this works

TypeScript's structural typing means the factory doesn't have to `implements SessionStore` or import the contract type. As long as the return shape matches, it's assignable. This keeps the factory package free of the consumer's dependencies: `createPersistedState` lives in `@epicenter/svelte` and has zero knowledge of `@epicenter/auth`.

## The Mental Model

Think of it as a chain where each link:

- Receives a resource from the previous link
- Adds its own configuration
- Produces something for the next link

```
createClient(...)  →  createService(client, ...)  →  service.method(...)
     ↑                       ↑                            ↑
 clientOptions          serviceOptions              methodOptions
```

## Benefits

- **Testability**: Inject mock clients easily
- **Reusability**: Share clients across multiple services
- **Flexibility**: Configure each layer independently
- **Clarity**: Clear ownership of configuration at each level

## References

See the full articles for more details:

- [The Universal Factory Function Signature](../../../docs/articles/universal-factory-signature.md): signature explained in depth
- [Stop Passing Clients as Arguments](../../../docs/articles/stop-passing-clients-as-arguments.md): practical guide
- [The Factory Function Pattern](../../../docs/articles/factory-function-pattern.md): detailed explanation
- [Factory Method Patterns](../../../docs/articles/factory-method-patterns.md): separating options and method patterns
- [Closures Are Better Privacy Than Keywords](../../../docs/articles/closures-are-better-privacy-than-keywords.md): internal anatomy and why closures beat class keywords

Load on demand:

- [references/single-or-array-pattern.md](references/single-or-array-pattern.md): when a factory or CRUD entry point should accept either a single item or an array.
- [references/sync-construction-render-gate.md](references/sync-construction-render-gate.md): when a client's synchronous methods depend on async-initialized state and the UI must gate render on readiness.
- [references/method-documentation-and-sibling-calls.md](references/method-documentation-and-sibling-calls.md): where JSDoc belongs on returned methods, and when `this` is safe for sibling calls.
