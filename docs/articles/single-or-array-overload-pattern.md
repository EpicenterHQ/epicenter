# The Single-or-Array Pattern

Accept both single items and arrays, normalize internally, process uniformly.

## The Pattern

```typescript
function deleteRecordings(recordings: Recording | Recording[]) {
	const recordingsArray = Array.isArray(recordings) ? recordings : [recordings];

	// Core logic works on array
	const ids = recordingsArray.map((r) => r.id);
	return db.recordings.bulkDelete(ids);
}
```

Callers get flexibility:

```typescript
deleteRecordings(singleRecording); // Works
deleteRecordings([rec1, rec2, rec3]); // Also works
```

## How It Works

Normalize at the top of the function, then write all logic against the array. One function, one code path.

```typescript
function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];

	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	// ... rest of implementation
}
```

The union type `AnyWorkspaceClient | AnyWorkspaceClient[]` is self-documenting. No overloads needed when both forms return the same type.

## A caller that receives one build or several

The [first-load scanner](../../packages/vite-config/scripts/first-load.ts) receives Vite’s build result. It needs the chunks from every output, whether Vite returned one result or an array. The scanner normalizes the value once before collecting chunks:

```typescript
const chunks = new Map(
	(Array.isArray(result) ? result : [result])
		.flatMap((built) => ('output' in built ? built.output : []))
		.flatMap((output) => (output.type === 'chunk' ? [output] : []))
		.map((chunk) => [chunk.fileName, chunk]),
);
```

## Naming Conventions

| Parameter               | Normalized Variable |
| ----------------------- | ------------------- |
| `recordingOrRecordings` | `recordings`        |
| `clientOrClients`       | `clients`           |
| `runOrRuns`             | `runs`              |

## When to Use

**Good fit:** CRUD operations, batch processing, factory functions accepting dependencies.

**Skip when:** Single vs batch have fundamentally different semantics, or you rarely need both forms.

## When Overloads Are Actually Useful

Overloads earn their keep when different inputs produce different output types:

```typescript
function process(input: string): string;
function process(input: number): number;
function process(input: string | number): string | number {
	// ...
}
```

If both overloads return the same type, skip them. The union parameter is clearer.
