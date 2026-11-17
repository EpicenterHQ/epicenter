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

  // Good: the owned base contains the fields both shapes share.
  type WorkspaceBase = { id: string };
  type Workspace = WorkspaceBase & { tables: WorkspaceTables };
  type Connected = WorkspaceBase & { tables: ConnectedTables };
  type ConnectedWithInfra = Connected & {
    idb: Idb;
    wipe(): Promise<void>;
  };
  ```

  Both shapes extend the owned base. The richer connected shape extends
  Connected, so changing its table type happens in one place. When a shape
  needs a different field, reconsider the base rather than repeating an
  Omit-and-replace expression.

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
  defineKv();
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
- **Give relative imports an explicit extension, and match the package**: For example, `packages/app` re-exports `defineApp` from `./app.ts`, while `packages/account` re-exports `createBrowserOAuth` from `./browser-oauth.js`. TypeScript resolves the latter to the source `.ts` file.

  This does not apply to package imports (`import { type } from 'arktype'`) or path aliases (`import Component from '$lib/components/Foo.svelte'`): only bare relative paths.
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
- For factory signatures, internal arrow functions, and returned method placement, read [factory function composition](factory-function-composition.md). For public JSDoc and existing receiver-dependent APIs, read [method documentation and sibling calls](method-documentation-and-sibling-calls.md).
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

- Destructure dependency and configuration bags in the signature. See [parameter binding](factory-function-composition.md#bind-inputs-at-construction) for examples and when the whole input should stay named.

- **Keep useful return-type inference**: Let TypeScript infer private and inner return types. Annotate a public or recursive API when the annotation defines a real contract, makes the output clearer, or breaks circular inference. TypeScript documents [return-type inference](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#return-type-annotations); choosing which public shape to expose is a project design decision.

  ```typescript
  // The compiler infers number from both return paths.
  function parseCount(raw: string | null) {
	if (raw === null) return 0;
	return Number(raw);
  }
  ```

- For inferred factory output aliases, including curried, generic, and asynchronous factories, read [public factory types](factory-function-composition.md#derive-public-types-from-the-return-object). For shared contracts and their effect on inference and navigation, read [editor experience](editor-experience.md).
