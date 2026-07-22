# TypeScript Type Safety And Control Flow

Detailed TypeScript guidance for identity checks, brands, casts, boolean naming, control flow, error composition, fallback smells, and round-trip invariants.

## Identity Checks: Brand, Don't Probe

When `isFoo(x)` is asking "is this the specific thing my factory returned," use a `Symbol` brand stamped at the factory, not a coincidental-property probe. Shape probes collide with look-alikes and rot as the type grows; the brand is unforgeable and survives normal object spreads.

```typescript
// Smell: three coincidental properties stand in for identity.
// Any object that happens to have ydoc + id + Symbol.dispose passes.
function isWorkspaceHandle(value: unknown): value is WorkspaceHandle {
	if (value == null || typeof value !== 'object') return false;
	const record = value as Record<string | symbol, unknown>;
	return (
		'ydoc' in record &&
		'id' in record &&
		typeof record[Symbol.dispose] === 'function'
	);
}

// Better: brand stamped by the factory, one check carries the intent.
// Use `Symbol.for('<namespace>.<thing>')`, not `Symbol(...)`, so the brand
// survives module duplication (see "Cross-package brands" below).
export const WORKSPACE_HANDLE = Symbol.for('epicenter.workspace-handle');

function isWorkspaceHandle(value: unknown): value is WorkspaceHandle {
	return (
		value != null &&
		typeof value === 'object' &&
		WORKSPACE_HANDLE in value
	);
}
```

### Cross-package brands: `Symbol.for`, never `Symbol`

Any brand that has to be recognized across a module boundary, such as a CLI
walking user bundles or a server adapter recognizing a library handle, must use
the global symbol registry. Plain `Symbol('name')` creates a fresh reference per
module evaluation; duplicate package instances then stamp and check different
symbols, so the identity test silently fails.

`Symbol.for('epicenter.action')` talks to a process-global registry keyed by the string. Every call anywhere returns the same reference. The brand survives duplication.

```ts
// Wrong: local reference; fails under module duplication
export const ACTION_BRAND = Symbol('epicenter.action');

// Right: registry-resolved; always the same reference
export const ACTION_BRAND = Symbol.for('epicenter.action');
```

Convention: namespace the key (`epicenter.action`, `epicenter.document-handle`), and centralize cross-package brand keys in one `brands.ts` per package so the duplication-safe identity set is visible and reviewable. The brand constant itself is an implementation detail: consumers import the `isX` guard, never the raw symbol.

**When the brand can be local**: if the factory and the check both live in the same file and the type never crosses a package boundary, plain `Symbol()` is fine. The `Symbol.for` rule is specifically for cross-package identity.

**This rule is narrow. It does NOT apply to:**

- **Union narrowing via presence**: `'data' in result` / `'error' in result` on a wellcrafted `Result`, or `'error' in response` on an OAuth response union. The union *is* the contract; the presence check discriminates it.
- **Discriminated union tags**: `switch (change.type)`. The tag is already a brand.
- **Protocol / feature detection**: `Symbol.dispose in x`, `Symbol.asyncIterator in x`, `typeof x.then === 'function'`. These check *capability*, not identity.
- **Single-or-function config**: `typeof baseURL === 'function'` to distinguish a value from a getter. A config API pattern, not a broken contract.
- **Node error inspection**: `'code' in error` on `NodeJS.ErrnoException`. Upstream type genuinely requires it.

**When a shape probe IS the smell, the fix is usually upstream.** If you're about to write `isFoo(x)` that shape-probes an internal factory's output, the factory should stamp a brand. If you're about to shape-probe user input or `JSON.parse` output, validate with arktype/typebox at the boundary: the probe accepts any object that happens to match; the schema rejects anything off-contract.

### Factory output: flat objects, not prototype delegation

When a factory returns a "bag of data + a few lifecycle methods," spread the data and add the methods as own enumerable properties. Don't use `Object.create(bundle)` to inherit the data, and don't hide methods with non-enumerable `Object.defineProperties`.

```ts
// Smell: data lives on the prototype, methods are non-enumerable.
// Object.keys(handle) returns []; {...handle} spreads nothing;
// callers reach through Object.getPrototypeOf(handle) to iterate.
const handle = Object.create(bundle);
Object.defineProperties(handle, {
	dispose:          { value: () => {...} },
	[Symbol.dispose]: { value: () => {...} },
});

// Better: flat, own, enumerable. Spreads, Object.keys, and debuggers all work.
return {
	...bundle,
	dispose: () => {...},
	[Symbol.dispose]: () => {...},
	[DOCUMENT_HANDLE]: true,
};
```

If you're reaching for `Object.create` to get class-like delegation, either write a `class` or flatten: don't simulate one with the other. The only legitimate `Object.defineProperty` in this repo patches a Node-owned getter (`process.stdout.isTTY`) in a test; normal assignment doesn't work there.

### Casts: never `as any`, rarely `as unknown as T`

`as any` in production code is a red flag: either the callee is over-narrow (fix the signature) or the caller is passing the wrong type (fix the call). `as unknown as T` double-casts that mask a real type error are the same smell in disguise: e.g., `generateId() as unknown as BrandedId` should be `as string as BrandedId`, or better, fix `generateId`'s return type.

Legitimate cast exceptions:

- **Generics ceremony in typed builders**: `Object.assign(handler, {...}) as unknown as Query<T, U>` when `Object.assign` erases the generic overload inference. Acceptable when the overload signature is the real contract; keep the cast at the innermost scope.
- **Test fixtures casting mocks**: acceptable in `*.test.ts`, never leaked out of a test file.

### Optional properties: `?.` over `in` or truthiness

When a property is optional in the type (`foo?: () => void`, including symbol keys like `[Symbol.asyncDispose]?: () => Promise<void>`), access it with optional chaining. Don't `in`-check, don't cast, don't truthiness-check. The type already proves the call is safe; runtime probes are redundant and invite casts.

```ts
// Bad: runtime `in` check + cast
if (Symbol.asyncDispose in sink) {
  await (sink as AsyncDisposable)[Symbol.asyncDispose]();
}

// Bad: truthiness check before call
if (handler.onError) handler.onError(err);

// Good: optional chaining handles it
await sink[Symbol.asyncDispose]?.();
handler.onError?.(err);
```

`Partial<AsyncDisposable>` and optional-function property types compose cleanly with `?.()`: no casts needed, and it works identically for string, symbol, and computed keys. Real example from the workspace-logger:

```ts
type LogSink = ((event: LogEvent) => void) & Partial<AsyncDisposable>;

for (const sink of sinks) await sink[Symbol.asyncDispose]?.();
// consoleSink has no dispose -> no-op; stateful sinks (file, network) get awaited
```

## Boolean Naming: `is`/`has`/`can` Prefix

Boolean properties, variables, and parameters MUST use a predicate prefix that reads as a yes/no question:

- `is`: state or identity: `isEncrypted`, `isLoading`, `isVisible`, `isActive`
- `has`: possession or presence: `hasToken`, `hasChildren`, `hasError`
- `can`: capability or permission: `canWrite`, `canDelete`, `canUndo`

```typescript
// Good: reads as a question
type Config = {
	isEncrypted: boolean;
	isReadOnly: boolean;
	hasCustomTheme: boolean;
	canExport: boolean;
};

get isEncrypted() { return currentKey !== undefined; }
const isVisible = element.offsetParent !== null;
if (hasToken) { ... }

// Bad: ambiguous, doesn't read as yes/no
type Config = {
	encrypted: boolean;    // adjective without 'is'
	readOnly: boolean;     // could be a noun
	state: boolean;        // what state?
	mode: boolean;         // what mode?
};
```

This applies to:
- Object/type properties (`isActive: boolean`)
- Getter methods (`get isEncrypted()`)
- Local variables (`const isValid = ...`)
- Function parameters (`function toggle(isEnabled: boolean)`)
- Function return values when the function is a predicate (`function isExpired(): boolean`)

Exception: Match upstream library types exactly (e.g., `tab.pinned`, `window.focused` from APIs where the type is externally defined).

## Switch Over If/Else for Value Comparison

When multiple `if`/`else if` branches compare the same variable against string literals (or other constant values), always use a `switch` statement instead. This applies to action types, status fields, file types, strategy names, or any discriminated value.

```typescript
// Bad - if/else chain comparing the same variable
if (change.action === 'add') {
	handleAdd(change);
} else if (change.action === 'update') {
	handleUpdate(change);
} else if (change.action === 'delete') {
	handleDelete(change);
}

// Good - switch statement
switch (change.action) {
	case 'add':
		handleAdd(change);
		break;
	case 'update':
		handleUpdate(change);
		break;
	case 'delete':
		handleDelete(change);
		break;
}
```

Use fall-through for cases that share logic:

```typescript
switch (change.action) {
	case 'add':
	case 'update': {
		applyChange(change);
		break;
	}
	case 'delete': {
		removeChange(change);
		break;
	}
}
```

Use block scoping (`{ }`) when a case declares variables with `let` or `const`.

When NOT to use switch: early returns for type narrowing are fine as sequential `if` statements. If each branch returns immediately and the checks are narrowing a union type for subsequent code, keep them as `if` guards.

### Exhaustiveness via `default: x satisfies never`

When switching over a **closed type**: a discriminated union, a defineErrors variant, a literal-string enum, a migration version: guard the switch with an exhaustiveness check so adding a new variant breaks the build until every site handles it.

```typescript
// Good: adding a new RpcError variant fails the build here
switch (error.name) {
	case 'ActionNotFound':
		handleNotFound(error.action);
		return;
	case 'Timeout':
		handleTimeout(error.ms);
		return;
	case 'PeerOffline':
	case 'PeerLeft':
		handleDisconnect();
		return;
	case 'ActionFailed':
		handleFailure(error.cause);
		return;
	case 'Disconnected':
		handleDisconnect();
		return;
	default:
		error satisfies never;
}
```

Why `satisfies never` and not `const _exhaustive: never = error; void _exhaustive;`? Same compile-time guarantee, less emit, no unused-variable suppression dance.

```typescript
// satisfies: type-level only, strips to the bare expression
default: error satisfies never;
// emits: default: error;

// const form: declares a real binding, needs `void` to silence unused-var
default: {
	const _exhaustive: never = error;
	void _exhaustive;
}
// emits: default: { const _exhaustive = error; void _exhaustive; }
```

`satisfies` (TS 4.9+) is the blessed idiom for "assert conformance without producing a value."

**When NOT to add an exhaustive check:**

- Switches over **open input**: wire bytes (`messageType` from a binary protocol), HTTP status codes, file extensions from user paths, error names from external libraries you don't control. These need real `default:` handling (`throw`, `return null`, etc.) because unknown values are reachable at runtime.
- Switches whose `default:` is doing intentional fallback (e.g., "anything else gets the noop").

The rule of thumb: if the type checker proves the input is one of N closed values AND adding an N+1th value should require updating this site, add `satisfies never`. Otherwise, leave the switch alone.

See `docs/articles/switch-over-if-else-for-value-comparison.md` for rationale.

## Record Lookup Over Nested Ternaries

When an expression maps a finite set of known values to outputs, use a `satisfies Record` lookup instead of nested ternaries. This is the expression-level counterpart to "Switch Over If/Else": switch handles statements with side effects, record lookup handles value mappings.

```typescript
// Bad - nested ternary
const tooltip = status === 'connected'
	? 'Connected'
	: status === 'connecting'
		? 'Connecting...'
		: 'Offline';

// Good - record lookup with exhaustive type checking
const tooltip = ({
	connected: 'Connected',
	connecting: 'Connecting...',
	offline: 'Offline',
} satisfies Record<SyncStatus, string>)[status];
```

`satisfies Record<SyncStatus, string>` gives you compile-time exhaustiveness: if `SyncStatus` gains a fourth value, TypeScript errors because the record is missing a key. Nested ternaries silently fall through to the else branch.

`as const` is unnecessary here. `satisfies` already validates the shape and value types. `as const` would narrow values to literal types (`'Connected'` instead of `string`), which adds no value when the output is just rendered or passed as a string.

When the record is used once, inline it. When it's shared or has 5+ entries, extract to a named constant.

See `docs/articles/record-lookup-over-nested-ternaries.md` for rationale.

## Compose Errors Bottom-Up, Don't Filter Top-Down

`Extract<MyUnion, { name: 'X' }>` on a union you defined is a code smell. It says the union was composed too wide; the method that needs the narrow type is patching the over-typing at its signature instead of fixing the source.

```typescript
// Smell: one wide union, methods filter it back down
export const TransportError = defineErrors({
	RequestFailed:             ({ cause }) => ({...}),
	DeviceCodeExpired:         () => ({...}),
	DeviceAccessDenied:        () => ({...}),
	DeviceAuthorizationFailed: ({ code, description }) => ({...}),
});

return {
	async requestDeviceCode(): Promise<
		Result<DeviceCodeResponse, Extract<TransportError, { name: 'RequestFailed' }>>
	> { ... },
};
```

The fix is bottom-up: define error types per fault domain, infer per-method return types from the bodies, let the union appear at the boundary that actually needs it.

```typescript
// Better: fault domains as their own unions, no extract anywhere
export const RequestError = defineErrors({
	RequestFailed: ({ cause }) => ({...}),
});
export const DeviceTokenError = defineErrors({
	DeviceCodeExpired:         () => ({...}),
	DeviceAccessDenied:        () => ({...}),
	DeviceAuthorizationFailed: ({ code, description }) => ({...}),
});

return {
	async requestDeviceCode() {
		// body only constructs RequestError.RequestFailed
		// -> infers Result<DeviceCodeResponse, RequestError>
	},
	async pollDeviceToken() {
		// body constructs RequestError AND DeviceTokenError variants
		// -> infers Result<DevicePollOutcome, RequestError | DeviceTokenError>
	},
};
```

The narrow types weren't extracted from a wide one. They were composed bottom-up; the wide one stopped existing. Callers that need the wide union get it where the pieces meet (e.g., a coordinator that calls all four methods naturally lands on the union of every error its callees can produce).

`Extract<>` is the right tool when the union is upstream and you can't redefine it: `Extract<keyof JSX.IntrinsicElements, 'div' | 'section'>`, `Extract<NodeJS.ErrnoException['code'], 'ENOENT' | 'EACCES'>`. The smell is when *you* defined the union and *you* are filtering it back down: that's a sign you owned the composition and composed it wrong.

The test: do I own this union? If yes, split it. If no, `Extract<>` is fine.

See `docs/articles/20260504T100000-extract-is-the-tell-you-composed-top-down.md` for rationale.

## Silent Fallback Smell

Not all `??` expressions are safe defaults. When the fallback creates **state that other systems depend on**, the nullish coalescing hides a broken invariant.

```typescript
// Safe default: divergence doesn't matter
const timeout = options.timeout ?? 5000;

// SMELL: fallback creates divergent identity
// Two machines importing the same data silently get different IDs
const id = parsedId ?? generateId();
```

The test: **does the fallback create state that must be consistent across systems?** If yes, the `??` is masking a problem. Fix it by:

- **Self-healing**: generate the value and write it back to the source, so the fallback never fires again
- **Throwing**: make the invariant explicit: if the value should exist, its absence is an error
- **Warning**: at minimum, make the fallback visible so silent divergence doesn't go unnoticed

## Round-Trip Invariant

If you serialize and then deserialize, identity properties must survive:

```typescript
// This must hold for any entity with stable identity:
const exported = serialize(entity);
const reimported = deserialize(exported);
assert(reimported.id === entity.id);
```

If an ID doesn't survive a full cycle, every system that references it by ID is broken: document handles, foreign keys, cache entries. The round-trip test is: "If I export to disk and import on a fresh machine, does everything still match?"

When designing parse/serialize pairs, decide which fields are **identity** (must survive round-trips) vs **derived** (can be recomputed). Persist identity fields explicitly: don't rely on matching by secondary keys to recover them.
