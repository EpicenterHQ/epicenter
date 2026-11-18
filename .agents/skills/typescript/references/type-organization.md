# Type Organization Patterns

## When to Read This
Read this when deciding where types/constants live and how to name/derive option data structures.

# Where types belong

Keep a type beside what defines it. If a factory or schema defines the shape, derive the type there. If the type defines what several implementations promise to callers, give that contract a home named for what it describes.

Keep a component’s own props and state types in the component. Several files can import a type from its existing home. Question a `types.ts` file when it collects unrelated types or repeats shapes already defined by code.

## Shared contracts

The recorder package defines [`Recorder`](../../../../packages/recorder/src/recording.ts) in `recording.ts`. The [browser](../../../../packages/recorder/src/browser.ts) and [desktop](../../../../packages/recorder/src/tauri.ts) implementations both check their objects against it with `satisfies Recorder`. The [package entry point](../../../../packages/recorder/src/index.ts) exposes the same contract whichever recorder it selects:

```typescript
export const recorder: Recorder = isTauri() ? shellRecorder : pageRecorder;
```

## Factory Return Types Should Follow the Factory

When an exported type is the public handle returned by one `create*` factory, the factory return object is the source of truth.

Whispering names [`Library`](../../../../apps/whispering/src/lib/library.svelte.ts) immediately after `createLibrary`, in the same file:

```typescript
export type Library = ReturnType<typeof createLibrary>;
```

An explicit return annotation publishes its declared shape and can direct editor navigation to that declaration. The derived alias keeps the public name while letting Go to Definition walk into the actual returned member.

If the public type is a nested slice of a factory result, use a focused inference helper instead of forcing `ReturnType` to name the whole result. For example, an auxiliary signed-in-only session can expose the payload inside `session.current` without naming the whole object returned by `createSession`.

Use this pattern when:

- The type is exactly the return shape of one factory.
- The factory and type live together.
- The returned object is the easiest place to understand the API.
- The public documentation belongs on the returned getters, methods, and properties.

When a factory is curried, derive from the inner return with `ReturnType<ReturnType<typeof createThing>>`. When a factory is generic, instantiate the `typeof` expression as needed, such as `ReturnType<typeof createThing<TActions>>`.

If the concrete implementation has writable state but the public surface should be readonly, keep that state private and return read methods before deriving the alias. Svelte reads through `reactive`, which retains those methods, following the [read API convention](../SKILL.md#core-rules). Existing getters and upstream protocols remain contracts until an authorized redesign. The derived type should describe the public object, not leak accidental implementation mutability.

Do not use it when the type is a shared contract implemented by multiple factories, a protocol shape, or a deliberate abstraction boundary. In those cases, keep the contract as the source of truth and make implementations `satisfies` it when you want conformance without losing implementation navigation.

## Inline, name, or move to another file

Keep a value inline when seeing it in place makes the code easier to read. Give it a name when the name explains something useful or the value needs to be reused. Give it a separate file when that file is where a reader would look for the concept.

> **If a reader lands on the call site, do they get more out of seeing this inline, or out of jumping to another file?**

# Naming constants and collections

Use `SCREAMING_SNAKE_CASE` (all caps with underscores) for fixed limits, protocol values, and shared lookup tables when the casing helps readers recognize their role. Use `camelCase` for local values and objects that expose an API.

Name collections for what they contain. Include units where they matter. Use names like `options`, `ids`, or `labels` when they help distinguish related values.

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

### Pattern 3: Shared lookup table → local list

Derive related lists from the same source when they describe the same set of choices. Whispering’s [recording collection](../../../../apps/whispering/src/lib/recording-collection.ts) defines the labels for each status:

```typescript
export const STATUS_LABELS: Record<RecordingStatus, string> = {
	failed: 'Transcription failed',
	transcribing: 'Transcribing',
	untranscribed: 'Not transcribed',
	transcribed: 'Transcribed',
};
```

The [recording list](../../../../apps/whispering/src/routes/components/RecordingList.svelte) imports the table and derives the list it needs for sorting:

```typescript
const statusLabels = Object.values(STATUS_LABELS);
```

## Choosing a Pattern

| Scenario                                                          | Pattern                  |
| ----------------------------------------------------------------- | ------------------------ |
| Label = formatted value (e.g., "128 kbps")                        | Simple Values -> Derived |
| Label needs separate data (e.g., "16 kHz - Optimized for speech") | Values + Metadata        |
| A view needs an ordered list of labels from a shared table        | Lookup Table → Local List |
| Platform-specific or runtime-conditional content                  | Keep inline in component |

## Co-location

Options arrays should be co-located with their source array in the same file. Avoid creating options inline in Svelte components; import pre-defined options instead.

Exception: Keep options inline when they have platform-specific or runtime-conditional content that would require importing platform constants into the data module.
