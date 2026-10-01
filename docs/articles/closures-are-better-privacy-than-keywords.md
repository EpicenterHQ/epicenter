# Closures Are Better Privacy Than Keywords

Factory functions give you structural privacy. The return object is the public API; everything above it is private by position. Classes give you keyword privacy: `private`, `protected`, or nothing (meaning public), scattered in whatever order the author felt like writing. One approach lets you see the API at a glance. The other forces you to scan every member and check its modifier.

## The Anatomy of a Factory Function

Every factory function in this codebase follows the same internal shape:

```typescript
function createBackoff() {
	// Zone 1: Mutable state
	let retries = 0;
	let sleeper: { promise: Promise<void>; wake(): void } | null = null;

	// Zone 2: (Private helpers would go here)

	// Zone 3: Public API
	return {
		async sleep() {
			const delay = Math.min(500 * 2 ** retries, 30_000);
			const ms = delay * (0.5 + Math.random() * 0.5);
			retries += 1;

			const { promise, resolve } = Promise.withResolvers<void>();
			const handle = setTimeout(resolve, ms);
			sleeper = { promise, wake() { clearTimeout(handle); resolve(); } };
			await promise;
			sleeper = null;
		},

		wake() {
			sleeper?.wake();
		},

		reset() {
			retries = 0;
		},
	};
}
```

From `packages/sync-client/src/provider.ts`. Three methods, two `let` variables, zero ambiguity about what's public. The return object is four lines from the bottom; scroll there and you're done.

## The Same Thing as a Class

```typescript
class Backoff {
	private retries = 0;
	private sleeper: { promise: Promise<void>; wake(): void } | null = null;

	async sleep() {
		const delay = Math.min(500 * 2 ** this.retries, 30_000);
		const ms = delay * (0.5 + Math.random() * 0.5);
		this.retries += 1;

		const { promise, resolve } = Promise.withResolvers<void>();
		const handle = setTimeout(resolve, ms);
		this.sleeper = { promise, wake() { clearTimeout(handle); resolve(); } };
		await promise;
		this.sleeper = null;
	}

	wake() {
		this.sleeper?.wake();
	}

	reset() {
		this.retries = 0;
	}
}
```

Same logic. But now `private retries` sits right next to `async sleep()`, and nothing in the layout tells you which methods are public. You have to read every member and look for `private`: or more likely, look for the *absence* of `private`, since public is the default. The API surface is implicit: everything that isn't marked private.

## How the Zones Scale

Small factories like `createBackoff` don't need zone 2 (private helpers). Larger ones use all four zones. Here's the shape of `createSyncProvider`: 560 lines, same anatomy:

```
function createSyncProvider(config) {
	// Zone 1: Immutable state (derived from config)
	const { doc, url, getToken } = config;
	const awareness = config.awareness ?? new Awareness(doc);

	// Zone 2: Mutable state
	let desired: 'online' | 'offline' = 'offline';
	let runId = 0;
	let connectRun: Promise<void> | null = null;
	let websocket: WebSocket | null = null;

	const backoff = createBackoff();

	// Zone 3: Private helpers
	function send(message: Uint8Array) { ... }
	function handleDocUpdate(update: Uint8Array, origin: unknown) { ... }
	function handleAwarenessUpdate({ added, updated, removed }) { ... }
	function handleOnline() { ... }
	function handleOffline() { ... }
	async function runLoop(myRunId: number) { ... }
	async function attemptConnection(token, myRunId) { ... }

	// Zone 4: Public API
	return {
		get status() { return status.get(); },
		get awareness() { return awareness; },
		connect() { ... },
		disconnect() { ... },
		onStatusChange: status.subscribe,
		destroy() { ... },
	};
}
```

Six public methods, seven private helpers, four mutable variables. The return object sits at the bottom. You can read the public API without scrolling past any implementation. In a class, those 13 members would be interleaved in whatever order they were written, each tagged with `private` or left unmarked.

## The Decision Rule for `this`

Inside the return object, methods sometimes need to call other public methods. Use `this.method()` for that:

```typescript
return {
	getEpoch(): number {
		let max = 0;
		for (const value of epochsMap.values()) {
			max = Math.max(max, value);
		}
		return max;
	},

	bumpEpoch(): number {
		const next = this.getEpoch() + 1;
		epochsMap.set(ydoc.clientID.toString(), next);
		return next;
	},
};
```

`bumpEpoch` calls `this.getEpoch()` when invoked through the returned object, which supplies `this`. Extracting `bumpEpoch` loses that receiver. An arrow property does not receive the returned object as `this`.

If a function is called both by return-object methods *and* by pre-return initialization logic, it belongs in zone 3 (private helpers). Call it directly by name. No `this` needed, because it's a closure variable.

```typescript
function createSyncProvider(config) {
	// Zone 3: Private helper (used during init AND by public methods)
	function send(message: Uint8Array) {
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send(message);
		}
	}

	// Used during initialization
	doc.on('updateV2', (update, origin) => {
		if (origin === SYNC_ORIGIN) return;
		send(encodeSyncUpdate({ update }));
	});

	// Zone 4: Public API (also uses send via closure)
	return {
		connect() { ... },
		disconnect() { ... },
	};
}
```

## Why Keywords Don't Help

JavaScript gives you three ways to mark class members as private: `private` (TypeScript keyword), `#` (runtime private field), and `protected`. None of them improve readability.

| Modifier | What it means | The problem |
|---|---|---|
| `private` | TypeScript-only, no runtime enforcement | Erased at compile time; a lie at runtime |
| `#field` | True runtime privacy | Ugly syntax, no access from subclasses, poor debugging |
| `protected` | Accessible to subclasses | Leaks implementation across inheritance boundaries |
| *(nothing)* | Public | The default is the most permissive. Easy to forget the modifier |

All four modifiers live on the same level in the class body. You have to read every single member and check its access level. There's no structural separation. The layout doesn't tell you anything about the API surface.

Closures invert this. Private members exist *above* the return statement. Public members exist *inside* it. The structure itself communicates the contract.

## The Four Zones

Every factory function follows this ordering:

```
function createSomething(deps, options?) {
	// Zone 1: Immutable state (const from deps/options)
	// Zone 2: Mutable state (let declarations)
	// Zone 3: Private helpers (functions used by the return object)
	// Zone 4: return { public API }
}
```

Zone 1 and 2 can merge when there's little state. Zone 3 is empty for small factories. But the return object is always last, and it's always the complete public API. No scanning, no keywords, no ambiguity.

## Related

- [The Factory Function Pattern](./factory-function-pattern.md): the external signature and dependency injection
- [The Universal Factory Function Signature](./universal-factory-signature.md): why every factory takes `(deps, options?)`
- [Documenting Returned Factory Methods](./method-shorthand-jsdoc-preservation.md): where to put public JSDoc and when sibling calls need a receiver
