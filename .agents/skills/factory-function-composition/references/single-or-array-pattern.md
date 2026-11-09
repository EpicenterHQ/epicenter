# Single-or-Array Pattern

Accept both single items and arrays, normalize at the top, process uniformly.

## Quick Reference

```typescript
function create(itemOrItems: T | T[]): Promise<Result<void, E>> {
	const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
	// ... implementation works on items array
}
```

## The Structure

1. **Accept `T | T[]`** as the parameter type
2. **Normalize** with `Array.isArray()` at the top of the function
3. **All logic** works against the array : one code path

```typescript
function createServer(clientOrClients: Client | Client[], options?: Options) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];

	// All real logic here, working with the array
	for (const client of clients) {
		// ...
	}
}
```

## Naming Conventions

| Parameter               | Normalized Variable |
| ----------------------- | ------------------- |
| `recordingOrRecordings` | `recordings`        |
| `clientOrClients`       | `clients`           |
| `itemOrItems`           | `items`             |
| `paramsOrParamsArray`   | `paramsArray`       |

## When to Use

**Good fit:**

- CRUD operations (create, update, delete)
- Batch processing APIs
- Factory functions accepting dependencies
- Any "do this to one or many" scenario

**Skip when:**

- Single vs batch have different semantics
- Return types vary significantly
- Array version needs different options

## Codebase Examples

### Service Method

```typescript
delete: async (recordingOrRecordings) => {
  const recordings = Array.isArray(recordingOrRecordings)
    ? recordingOrRecordings
    : [recordingOrRecordings];
  const ids = recordings.map((r) => r.id);
  return tryAsync({
    try: () => store.bulkDelete(ids),
    catch: (error) => RecordingStoreError.MutationFailed({ cause: error }),
  });
},
```

### RPC Mutation

```typescript
export const recordingKeys = defineKeys({
	delete: ['recordings', 'delete'],
});

type DeleteRecordingsInput = Recording | Recording[];

export const recordings = {
	delete: defineMutation({
		mutationKey: recordingKeys.delete,
		mutationFn: async (recordings: DeleteRecordingsInput) => {
			const recordingsArray = Array.isArray(recordings)
				? recordings
				: [recordings];

			for (const recording of recordingsArray) {
				services.blobs.audio.revokePlaybackUrl(recording.id);
			}

			const { error } = await services.recordings.delete(recordingsArray);
			if (error) return Err(error);
			return Ok(undefined);
		},
	}),
};
```

## Anti-Patterns

### Don't: Separate functions for single vs array

```typescript
// Harder to maintain, users must remember two APIs
function createRecording(recording: Recording): Promise<...>;
function createRecordings(recordings: Recording[]): Promise<...>;
```

### Don't: Force arrays everywhere

```typescript
// Awkward for single items
createRecordings([recording]); // Ugly
```

### Don't: Duplicate logic in overloads

```typescript
// BAD: Logic duplicated
function create(item: T) {
	return db.insert(item); // Duplicated
}
function create(items: T[]) {
	return db.bulkInsert(items); // Different code path
}

// GOOD: Single implementation
function create(itemOrItems: T | T[]) {
	const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
	return db.bulkInsert(items); // One code path
}
```

## References

- [Full article](../../../../docs/articles/single-or-array-overload-pattern.md) : detailed explanation with more examples
