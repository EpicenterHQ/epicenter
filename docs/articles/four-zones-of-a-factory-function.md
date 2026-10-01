# Every Factory Function Has Four Zones

Open any factory function in this codebase and you'll find the same internal layout: immutable state, mutable state, private helpers, return object. The ordering isn't accidental. It mirrors how the function actually executes and makes the public API trivially easy to find.

```
function createSomething({ db, cache }, options?) {
	// Zone 1: Immutable state
	// Zone 2: Mutable state
	// Zone 3: Private helpers
	// Zone 4: return { public API }
}
```

## Zone 1: Immutable State

Constants derived from dependencies and options. Everything the function needs that won't change after creation.

```typescript
function createSyncProvider({ doc, url, getToken }: SyncProviderConfig) {
	const ownsAwareness = !config.awareness;
	const awareness = config.awareness ?? new Awareness(doc);
	// ...
}
```

Dependencies can be destructured in the signature or in the body. Both work. Signature destructuring is shorter for small dep lists. Body destructuring makes sense when you also need to pass the deps object around or the list is long.

```typescript
// Signature destructuring
function createService({ db, cache }: Deps) {
	const maxRetries = 3;
	// ...
}

// Body destructuring
function createService(deps: Deps) {
	const { db, cache, logger, metrics } = deps;
	// ...
}
```

The point is that by the time you hit zone 2, all dependencies and config are bound to `const` names.

## Zone 2: Mutable State

`let` declarations for anything that changes during the lifetime of the returned object. This is the factory function's equivalent of instance variables, except they're invisible to consumers.

```typescript
function createSyncProvider(config: SyncProviderConfig) {
	// Zone 1
	const { doc, url, getToken } = config;
	const awareness = config.awareness ?? new Awareness(doc);

	// Zone 2
	let desired: 'online' | 'offline' = 'offline';
	let runId = 0;
	let connectRun: Promise<void> | null = null;
	let websocket: WebSocket | null = null;

	const backoff = createBackoff();
	// ...
}
```

From `packages/sync-client/src/provider.ts`. Four `let` variables and one sub-factory (`createBackoff`) that encapsulates its own mutable state. All of it private by position. None of it appears in the return object.

When two or more `let` variables are always read, written, and reset together, they're a single concept. Extract them into a sub-factory:

```typescript
// Before: coupled let statements
let retries = 0;
let sleeper: Sleeper | null = null;

// After: one concept, one factory
const backoff = createBackoff();
backoff.sleep();
backoff.wake();
backoff.reset();
```

## Zone 3: Private Helpers

Functions that support the public API but aren't exposed. They close over zones 1 and 2, so they can read config and mutate state without parameter drilling.

```typescript
function createSyncProvider(config: SyncProviderConfig) {
	// Zones 1-2...
	let websocket: WebSocket | null = null;

	// Zone 3
	function send(message: Uint8Array) {
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send(message);
		}
	}

	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (origin === SYNC_ORIGIN) return;
		send(encodeSyncUpdate({ update }));
	}

	function handleOnline() {
		backoff.wake();
	}

	async function runLoop(myRunId: number) { /* ... */ }
	async function attemptConnection(token, myRunId) { /* ... */ }

	// Zone 4...
	return { connect() { ... }, disconnect() { ... } };
}
```

Seven private functions, none exposed. The consumer calls `connect()` and `disconnect()` without knowing about `send`, `handleDocUpdate`, `runLoop`, or any of the internal machinery.

Zone 3 is empty for small factories. `createBackoff()` has three `let` variables and three public methods with no private helpers in between. Zones 2 and 4 sit right next to each other.

## Zone 4: The Return Object

The complete public API. Method shorthand, getters for state, and nothing else.

```typescript
return {
	get status() { return status.get(); },
	get awareness() { return awareness; },

	connect() {
		desired = 'online';
		if (connectRun) return;
		manageWindowListeners('add');
		const myRunId = runId;
		connectRun = runLoop(myRunId);
	},

	disconnect() {
		desired = 'offline';
		runId++;
		backoff.wake();
		manageWindowListeners('remove');
		if (websocket) websocket.close();
		status.set('offline');
	},

	onStatusChange: status.subscribe,

	destroy() {
		this.disconnect();
		doc.off('updateV2', handleDocUpdate);
		awareness.off('update', handleAwarenessUpdate);
		if (ownsAwareness) {
			removeAwarenessStates(awareness, [doc.clientID], 'window unload');
		}
		status.clear();
	},
};
```

Six public members. The return object starts on line ~386 of a 560-line function; you scroll to the bottom and you're looking at the entire API. No scanning for `private` keywords, no checking member order.

`destroy()` calls `this.disconnect()` when invoked through the returned object, which supplies `this`; extracting `destroy` loses that receiver. Meanwhile, `disconnect()` calls `backoff.wake()` and `manageWindowListeners()` directly because those are zone 3 helpers accessed through closure.

## The Decision Rule

| Where does the function live? | How do you call it? |
|---|---|
| Zone 4 (return object) | `this.method()` from sibling methods |
| Zone 3 (private helper) | Direct call by name: `helperFn()` |
| Needed by both zone 3 and zone 4 | Keep in zone 3, call by name everywhere |

If a method in the return object needs to call another public method, use `this`. If it needs something that also runs during initialization, that function belongs in zone 3.

## Why This Ordering Works

The zones follow the function's execution order. Zone 1 runs first (binding constants), zone 2 sets up initial mutable state, zone 3 defines the helpers that zones 2 and 4 reference, and zone 4 assembles the public API from everything above it.

Reading the function top-down gives you setup context before implementation; reading bottom-up gives you the API before the internals. Both directions are useful, and neither requires keyword-scanning to figure out what's public.

## Related

- [Closures Are Better Privacy Than Keywords](./closures-are-better-privacy-than-keywords.md): why this beats class keywords
- [The Factory Function Pattern](./factory-function-pattern.md): the external signature and dependency injection
- [Documenting Returned Factory Methods](./method-shorthand-jsdoc-preservation.md): where to put public JSDoc and when sibling calls need a receiver
