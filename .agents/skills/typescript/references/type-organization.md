# Type Organization Patterns

## When to Read This
Read this when deciding where types/constants live and how to name/derive option data structures.

# Type Co-location Principles

## Never Use Generic Type Buckets

Don't create generic type files like `$lib/types/models.ts`. This creates unclear dependencies and makes code harder to maintain.

### Bad Pattern

```typescript
// $lib/types/models.ts - Generic bucket for unrelated types
export type LocalModelConfig = { ... };
export type UserModel = { ... };
export type SessionModel = { ... };
```

### Good Pattern

```typescript
// $lib/services/transcription/local/types.ts - Co-located with service
export type LocalModelConfig = { ... };

// $lib/services/user/types.ts - Co-located with user service
export type UserModel = { ... };
```

## Co-location Rules

1. **Service-specific types**: Place in `[service-folder]/types.ts`
2. **Component-specific types**: Define directly in the component file
3. **Shared domain types**: Place in the domain folder's `types.ts`
4. **Cross-domain types**: Only if truly shared across multiple domains, place in `$lib/types/[specific-name].ts`

## `types.ts` Is A Code Smell (Prefer Computed Types Over Manual Declarations)

When a type can be derived from a runtime value, derive it. Don't declare it manually in a separate file.

```typescript
// Good: type is computed from the runtime definition
export const BROWSER_TABLES = { devices, tabs, windows };
export type Tab = InferTableRow<typeof BROWSER_TABLES.tabs>;

// Good: type is derived from schema
const userSchema = z.object({ id: z.string(), email: z.string() });
type User = z.infer<typeof userSchema>;

// Bad: manually declaring what already exists as a runtime value
// types.ts
export type Tab = { id: string; nodeId: string /* ... */ };
```

If every type in a `types.ts` can be derived with `typeof`, `z.infer`, `InferTableRow`, `ReturnType`, etc., the file is redundant. Put each type next to the runtime value it's computed from.

## Factory Return Types Should Follow the Factory

When an exported type is the public handle returned by one `create*` factory, the factory return object is the source of truth.

```typescript
export function createDisposableCache<
	TId extends string | number,
	TValue extends Disposable,
>(build: (id: TId) => TValue) {
	return {
		open(id: TId): TValue & Disposable {
			// ...
		},
		has(id: TId): boolean {
			// ...
		},
	};
}

export type DisposableCache<
	TId extends string | number,
	TValue extends Disposable,
> = ReturnType<typeof createDisposableCache<TId, TValue>>;
```

This is different from annotating the factory as `: DisposableCache<TId, TValue>`. The annotation checks the shape, but it also makes editor navigation prefer the named type. The derived alias keeps the public name while letting Go to Definition walk into the actual returned member.

If the public type is a nested slice of a factory result, use a focused inference helper instead of forcing `ReturnType` to name the whole result. For example, an auxiliary signed-in-only session can expose the payload inside `session.current` without naming the whole object returned by `createSession`.

Use this pattern when:

- The type is exactly the return shape of one factory.
- The factory and type live together.
- The returned object is the easiest place to understand the API.
- The public documentation belongs on the returned getters, methods, and properties.

When a factory is curried, derive from the inner return with `ReturnType<ReturnType<typeof createThing>>`. When a factory is generic, instantiate the `typeof` expression as needed, such as `ReturnType<typeof createThing<TActions>>`.

If the concrete implementation has writable state but the public surface should be readonly, keep that state private and return read methods before deriving the alias. Svelte reactive adapters may expose tracked getters, following the [read API convention](../SKILL.md#core-rules). The derived type should describe the public object, not leak accidental implementation mutability.

Do not use it when the type is a shared contract implemented by multiple factories, a protocol shape, or a deliberate abstraction boundary. In those cases, keep the contract as the source of truth and make implementations `satisfies` it when you want conformance without losing implementation navigation.

## Inline vs Extract: The Hop Test

The classic question, "is this used in multiple places?", only answers *whether* you could extract. It doesn't answer *whether you should*. The better question:

> **If a reader lands on the call site, do they get more out of seeing this inline, or out of jumping to another file?**

Extraction has a cost: every reader pays attention tax to context-switch into the extracted file, then back. For non-trivial things that's worth it: you get a named concept with its own responsibility. For trivial things (a 3-line type alias, a single template function, one const string), the hop costs more than the dupe.

### Decision table

| Situation | Action |
|---|---|
| Used in exactly 1 place | **Inline.** No DRY benefit exists. |
| Used in many places, ≤5 lines, no independent name worth giving it | **Probably inline.** Hop > dupe. |
| Used in many places, ≥10 lines OR has its own name/contract/tests | **Extract.** |
| Public API surface, documented contract, or package boundary | **Always extract, even if trivial.** It *is* the contract. |
| Sits in a multi-purpose bucket file (`types.ts`, `utils.ts`, `helpers.ts`) | **Extract OUT of the bucket.** Co-locate with consumer or promote to its own named file. |

### Concrete examples from this codebase

- `DocumentHandle` / `DocumentFactory`: previously in their own `create-document-factory.types.ts` file that existed only to keep them out of a bucket. Used only by `create-document-factory.ts`. **Inlined** back into `create-document-factory.ts`: zero reader benefit to the separation, and the separate file's own docstring admitted it was a workaround.
- `ContentHandle` / `ContentStrategy`: declared, exported, zero importers. **Deleted** (dead extraction).
- `KV_KEY = 'kv'` / `TableKey(name)`: one-line constant plus one-line function, but they're the reserved-prefix contract documented in public READMEs. **Extracted**: the contract is the value, not the size.
- `BaseRow`, `Table<TRow>`, `TableDefinition<TVersions>`: many definitions describing what `createTable` returns. **Co-located** inside `table.ts` (moving them out of a bucket into their natural home).

### The bucket trap

The worst outcome isn't "inline vs extract": it's "extracted into a generic bucket." A `types.ts` or `utils.ts` with unrelated members gets all the extraction cost (hop overhead, import bloat) with none of the naming benefit. Either:

1. Move each member to its natural home (the file that owns the concept), or
2. Rename the bucket to the single concern it actually covers (`row-results.ts`, not `types.ts`).

If neither is possible, the members probably don't belong together and some are dead.

# Constant Array Naming Conventions

## Pattern Summary

| Pattern                         | Suffix                 | Description             | Example                                  |
| ------------------------------- | ---------------------- | ----------------------- | ---------------------------------------- |
| Simple values (source of truth) | Plural noun with unit  | Raw values array        | `BITRATES_KBPS`, `SAMPLE_RATES`          |
| Rich array (source of truth)    | Plural noun            | Contains all metadata   | `PROVIDERS`, `RECORDING_MODE_OPTIONS`    |
| IDs only (for validation)       | `_IDS`                 | Derived from rich array | `PROVIDER_IDS`                           |
| UI options `{value, label}`     | `_OPTIONS`             | For dropdowns/selects   | `BITRATE_OPTIONS`, `SAMPLE_RATE_OPTIONS` |
| Label map                       | `_TO_LABEL` (singular) | `Record<Id, string>`    | `LANGUAGES_TO_LABEL`                     |

## When to Use Each Pattern

### Pattern 1: Simple Values -> Derived Options

Use when the label can be computed from the value:

```typescript
// constants/audio/bitrate.ts
export const BITRATES_KBPS = ['16', '32', '64', '128'] as const;

export const BITRATE_OPTIONS = BITRATES_KBPS.map((bitrate) => ({
	value: bitrate,
	label: `${bitrate} kbps`,
}));
```

### Pattern 2: Simple Values + Metadata Object

Use when labels need richer information than the value alone:

```typescript
// constants/audio/sample-rate.ts
export const SAMPLE_RATES = ['16000', '44100', '48000'] as const;

const SAMPLE_RATE_METADATA: Record<
	SampleRate,
	{ shortLabel: string; description: string }
> = {
	'16000': { shortLabel: '16 kHz', description: 'Optimized for speech' },
	'44100': { shortLabel: '44.1 kHz', description: 'CD quality' },
	'48000': { shortLabel: '48 kHz', description: 'Studio quality' },
};

export const SAMPLE_RATE_OPTIONS = SAMPLE_RATES.map((rate) => ({
	value: rate,
	label: `${SAMPLE_RATE_METADATA[rate].shortLabel} - ${SAMPLE_RATE_METADATA[rate].description}`,
}));
```

### Pattern 3: Rich Array as Source of Truth

Use when options have extra fields beyond `value`/`label` (e.g., `icon`, `desktopOnly`):

```typescript
// constants/audio/recording-modes.ts
export const RECORDING_MODES = ['manual', 'vad', 'upload'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const RECORDING_MODE_OPTIONS = [
	{ label: 'Manual', value: 'manual', icon: 'mic', desktopOnly: false },
	{
		label: 'Voice Activated',
		value: 'vad',
		icon: 'mic-voice',
		desktopOnly: false,
	},
	{ label: 'Upload File', value: 'upload', icon: 'upload', desktopOnly: false },
] as const satisfies {
	label: string;
	value: RecordingMode;
	icon: string;
	desktopOnly: boolean;
}[];

// Derive IDs for validation if needed
export const RECORDING_MODE_IDS = RECORDING_MODE_OPTIONS.map((o) => o.value);
```

## Choosing a Pattern

| Scenario                                                          | Pattern                  |
| ----------------------------------------------------------------- | ------------------------ |
| Label = formatted value (e.g., "128 kbps")                        | Simple Values -> Derived |
| Label needs separate data (e.g., "16 kHz - Optimized for speech") | Values + Metadata        |
| Options have extra UI fields (icon, description, disabled)        | Rich Array               |
| Platform-specific or runtime-conditional content                  | Keep inline in component |

## Naming Rules

### Source Arrays

- Use **plural noun**: `PROVIDERS`, `MODES`, `LANGUAGES`
- Add unit suffix when relevant: `BITRATES_KBPS`, `SAMPLE_RATES`
- Avoid redundant `_VALUES` suffix

### Derived/Options Arrays

- Use **plural noun** + `_OPTIONS` suffix: `BITRATE_OPTIONS`, `SAMPLE_RATE_OPTIONS`
- For IDs: **plural noun** + `_IDS` suffix: `PROVIDER_IDS`

### Label Maps

- Use **singular** `_TO_LABEL` suffix: `LANGUAGES_TO_LABEL`
- Describes the operation (id -> label), not the container
- Reads naturally: `LANGUAGES_TO_LABEL[lang]` = "get the label for this language"

### Constant Casing

- Always use `SCREAMING_SNAKE_CASE` for exported constants
- Never use `camelCase` for constant objects/arrays

## Co-location

Options arrays should be co-located with their source array in the same file. Avoid creating options inline in Svelte components; import pre-defined options instead.

Exception: Keep options inline when they have platform-specific or runtime-conditional content that would require importing platform constants into the data module.
