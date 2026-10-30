# TypeScript Project Conventions

Detailed examples for the baseline TypeScript rules used across Epicenter.

## Core Rules

- **Do not add a type until you have tried to derive or import it**: New named
  types are guilty until proven useful. Before declaring a type, check whether
  the shape already exists in an external library, an arktype/typebox schema, a
  factory return value, a runtime constant, or a function signature.

  ```typescript
  // Good: imported from the owner package
  import type { User } from 'better-auth';

  // Good: derived from a runtime schema
  export const AuthUser = type({ id: 'string', email: 'string' });
  export type AuthUser = typeof AuthUser.infer;

  // Good: derived from a function or factory
  type TokenOptions = Parameters<typeof verifyAccessToken>[1];
  export type AuthClient = ReturnType<typeof createAuthClient>;

  // Bad: hand-written copy of a shape owned elsewhere
  type OAuthPayload = { sub?: unknown };
  type AuthClient = { signOut(): Promise<void> };
  ```

  Keep explicit named types when they are the real contract: public package API,
  protocol vocabulary, discriminated result unions, capability ports, or shapes
  implemented by more than one runtime. Prefer `satisfies` when an
  implementation should be checked against a contract while keeping inference
  pointed at the concrete value.

- **Local shape copies are boundary smells**: A local type that exists only to
  imitate an upstream value should be suspicious before it becomes normal. The
  common tells are names ending in `Like`, casts to local `Like` types,
  `as Record<string, unknown>` inside already-typed internal code,
  `Pick<T, 'singleMethod'>` dependency seams, test-only
  `Parameters<typeof fn>[n]` gymnastics, and production casts whose only job is
  to make a test fake compile.

  ```typescript
  // Bad: local copy of a dependency shape
  type AuthClientLike = {
    signOut(): Promise<void>;
  };

  // Good: name the caller's actual capability
  type SignOut = () => Promise<void>;
  ```

  Prefer the owning runtime type, schema, factory return type, function
  signature, or a caller-owned capability function. Keep incomplete fake objects
  in tests, checked with `satisfies` when useful, instead of widening
  production code to accommodate them. See
  `docs/articles/copied-types-are-boundary-leaks.md` for the full review
  pattern.

- **Compose types upward from a named base**: When you author a type, reach for
  a base you can name and grow with `Base & Extra`, not a wider type you carve
  with `Omit<Base, 'k'> & { k: U }`. An `Omit<...> &` in your own type is the
  structural-typing form of overriding an inherited field: it is the tell that a
  smaller base wants a name. Repeating that carve across sibling types is
  copy-paste override.

  ```typescript
  // Bad: the same retype is subtracted and re-added in both types.
  type Connected =
    Omit<Workspace, 'tables'> & { tables: ConnectedTables };
  type ConnectedWithInfra =
    Omit<Workspace, 'tables'> & {
      tables: ConnectedTables;
      idb: Idb;
      wipe(): Promise<void>;
    };

  // Good: the retype happens once; the richer type is additive.
  type Connected =
    Omit<Workspace, 'tables'> & { tables: ConnectedTables };
  type ConnectedWithInfra = Connected & {
    idb: Idb;
    wipe(): Promise<void>;
  };
  ```

  The one surviving `Omit` sits where the field genuinely changes type; every
  richer shape intersects on top, so Go to Definition chains to a single source
  and a later change to the retype lands in one place.

  The same instinct narrows, not just extends. To expose a smaller surface (a
  read-only view of a writable record, a builder you may call only once), return
  the base type that never had the extra member, so dropping it is a type fact
  rather than a runtime hope. Return the base, never `Omit<Self, 'member'>`.

  ```typescript
  // Bad: the method returns its own type, so it chains forever and a second
  // call silently overwrites the first.
  type Builder = { step(x: Input): Builder };

  // Good: the method returns the base, which never had it. The capability is
  // spent after one call, so a second call is a compile error.
  type Base = { /* ...everything except step */ };
  type Builder = Base & { step(x: Input): Base };

  declare const builder: Builder;
  builder.step(a);          // ok
  builder.step(a).step(b);  // compile error: step is gone after the first call
  ```

- Always use `type` instead of `interface` in TypeScript.
- **`readonly` only for arrays and maps**: Never use `readonly` on primitive properties or object properties. The modifier is shallow and provides little protection for non-collection types. Use it only where mutation is a realistic footgun:

  ```typescript
  // Good - readonly only on the array
  type Config = {
	version: number;
	vendor: string;
	items: readonly string[];
  };

  // Bad - readonly everywhere is noise
  type Config = {
	readonly version: number;
	readonly vendor: string;
	readonly items: readonly string[];
  };
  ```

  Exception: Match upstream library types exactly (e.g., standard-schema interfaces). See `docs/articles/readonly-is-mostly-noise.md` for rationale.

- **Acronyms in camelCase**: Treat acronyms as single words, capitalizing only the first letter:

  ```typescript
  // Correct - acronyms as words
  parseUrl();
  defineTable();
  readJson();
  customerId;
  httpClient;

  // Incorrect - all-caps acronyms
  parseURL();
  defineKV();
  readJSON();
  customerID;
  HTTPClient;
  ```

  Exception: Match existing platform APIs (e.g., `XMLHttpRequest`). See `docs/articles/acronyms-in-camelcase.md` for rationale.

- TypeScript 5.5+ automatically infers type predicates in `.filter()` callbacks. Don't add manual type assertions:

  ```typescript
  // Good - TypeScript infers the narrowed type automatically
  const filtered = items.filter((x) => x !== undefined);

  // Bad - unnecessary type predicate
  const filtered = items.filter(
	(x): x is NonNullable<typeof x> => x !== undefined,
  );
  ```

- When moving components to new locations, always update relative imports to absolute imports (e.g., change `import Component from '../Component.svelte'` to `import Component from '$lib/components/Component.svelte'`)
- **Use `.js` extensions in relative imports**: The monorepo uses `"module": "preserve"` in tsconfig, which requires explicit file extensions. Always use `.js` (not `.ts`) in relative import paths. TypeScript resolves `.js` to the corresponding `.ts` file at compile time:

  ```typescript
  // Good: .js extension in relative imports
  import { parseSkill } from './parse.js';
  import type { Skill } from './types.js';

  // Bad: no extension (fails with module: preserve)
  import { parseSkill } from './parse';

  // Bad: .ts extension (non-standard, won't resolve correctly)
  import { parseSkill } from './parse.ts';
  ```

  This does NOT apply to package imports (`import { type } from 'arktype'`) or path aliases (`import Component from '$lib/components/Foo.svelte'`): only bare relative paths.
- **`export { }` is only for barrel files**: Every symbol is exported directly at its declaration (`export type`, `export const`, `export function`). The `export { Foo } from './bar'` re-export syntax is reserved for `index.ts` barrel files: that is their entire job. Don't add re-exports at the bottom of implementation files "for convenience"; they go unused, leave orphaned imports, and create a false second import path.

  ```typescript
  // Good: direct export at declaration
  export type TablesHelper<T> = { ... };
  export const EncryptionKey = type({ ... });
  export function createTables(...) { ... }

  // Good: barrel re-exports in index.ts
  export { createTables } from './create-tables.js';
  export type { TablesHelper } from './types.js';

  // Bad: re-export at bottom of create-tables.ts
  export type { TablesHelper, TableDefinitions };
  ```
- **Question single-method `Pick` dependencies**: `Pick<T, K>` is fine for data projection, but `Pick<Thing, 'method'>` in dependency injection is often a boundary smell. If the caller only needs one operation, prefer a named capability function in the caller's language. Keep the object shape only when the caller participates in that object's life cycle or needs the rest of the capability family. See `docs/articles/single-method-pick-is-a-boundary-leak.md`.
- When functions are only used in the return statement of a factory/creator function, use object method shorthand syntax instead of defining them separately. For example, instead of:
  ```typescript
  function myFunction() {
	const helper = () => {
		/* ... */
	};
	return { helper };
  }
  ```
  Use:
  ```typescript
  function myFunction() {
	return {
		helper() {
			/* ... */
		},
	};
  }
  ```
- **Prefer factory functions over classes**: Use `function createX() { return { ... } }` instead of `class X { ... }`. Closures provide structural privacy: everything above the return statement is private by position, everything inside it is the public API. Classes mix `private`/`protected`/public members in arbitrary order, forcing you to scan every member and check its modifier. See `docs/articles/closures-are-better-privacy-than-keywords.md` for rationale.
- **Generic type parameters use `T` prefix + descriptive name**: Never use single letters like `S`, `D`, `K`. Always prefix with `T` and use the full name:

  ```typescript
  // Good: descriptive with T prefix
  function validate<TSchema extends StandardSchemaV1>(schema: TSchema) { ... }
  type MapOptions<TDefs extends Record<string, Definition>> = { ... };
  function get<TKey extends string & keyof TDefs>(key: TKey) { ... }

  // Bad: single letters
  function validate<S extends StandardSchemaV1>(schema: S) { ... }
  type MapOptions<D extends Record<string, Definition>> = { ... };
  function get<K extends string & keyof D>(key: K) { ... }
  ```

- **Destructure options in function signature, not the first line of the body**:

  ```typescript
  // Good: destructure in the signature
  export function createThing<T>({
	name,
	value,
	onError,
  }: ThingOptions<T>) {
	// function body starts here
  }

  // Bad: intermediate `options` parameter, destructured on first line
  export function createThing<T>(options: ThingOptions<T>) {
	const { name, value, onError } = options;
	// ...
  }
  ```

  This includes the common half-fix where a function accepts `options`, then
  immediately does `const { foo } = options` or `const { foo } = options ?? {}`.
  Move that destructuring into the call signature instead:

  ```typescript
  // Good
  export function createThing({
    name,
    value = defaultValue,
  }: ThingOptions = {}) {
    // ...
  }

  // Bad
  export function createThing(options: ThingOptions = {}) {
    const { name, value = defaultValue } = options;
    // ...
  }
  ```

  Use judgment for real payload objects. Keep a named `options` parameter when
  the value is the domain object being transformed or forwarded as a whole,
  when the object is intentionally stateful, or when destructuring would make
  the signature harder to scan than the body. For configuration bags with
  defaults or a few plucked fields, destructure in the signature.

- **Don't annotate return types the compiler can infer**: Let TypeScript infer return types on inner/private functions. Only annotate return types on exported public API functions when the inferred type is too complex or when you need to break circular inference.

  ```typescript
  // Good: inner functions let TS infer
  function parseValue(raw: string | null) {
	if (raw === null) return defaultValue;
	return JSON.parse(raw);
  }

  // Bad: unnecessary return type annotation
  function parseValue(raw: string | null): SomeType {
	if (raw === null) return defaultValue;
	return JSON.parse(raw);
  }
  ```

- **Factory return types derive from the factory**: If a public type is exactly the return object from a `create*`, `attach*`, `open*`, or similar factory, export the type as `ReturnType<typeof createThing>` directly after the factory and let the function return its concrete object. If the public type is a nested slice of a factory result, use a focused inference helper like `InferSignedIn<typeof session>`. Put needed annotations and JSDoc on the returned methods and properties instead of on the factory itself. This keeps one source of truth and makes Go to Definition land on the returned object shape.

  ```typescript
  // Good: the factory owns the shape
  export function createBrowserDocCache<
    TId extends string,
    TDocument extends BrowserDocInstance,
  >(source: BrowserDocSource<TId, TDocument>) {
    return {
      open(id: TId): TDocument & Disposable {
        return source.create(id);
      },
    };
  }

  export type BrowserDocCache<
    TId extends string,
    TDocument extends BrowserDocInstance,
  > = ReturnType<typeof createBrowserDocCache<TId, TDocument>>;

  // Bad: the type and return object now describe the same shape twice
  export type BrowserDocCache<TId extends string, TDocument> = {
    open(id: TId): TDocument & Disposable;
  };

  export function createBrowserDocCache<TId extends string, TDocument>(
    source: BrowserDocSource<TId, TDocument>,
  ): BrowserDocCache<TId, TDocument> {
    return {
      open(id) {
        return source.create(id);
      },
    };
  }
  ```

  Use `ReturnType<ReturnType<typeof createThing>>` for curried factories. If the concrete object stores writable internals but the public API should be readonly, keep those internals private and expose read methods before deriving the type. Tracked getters belong in Svelte reactive adapters, following the [read API convention](../SKILL.md#core-rules).

  Keep explicit contract types when several implementations share the same surface, when the type is protocol vocabulary, or when you intentionally want to hide the concrete return shape. Use `satisfies` when the implementation should be checked against an external contract but the returned value should keep its own inferred shape.
