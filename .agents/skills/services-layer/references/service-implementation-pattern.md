# Service Implementation Patterns

This reference covers the plain-object default and the cases where a factory
earns its boundary.

## Plain object

Use a plain object, or a plain function, for a stateless implementation with
no construction inputs. Adapt a throwing call where it enters the service
(an illustration, not a module in the repository):

```typescript
export const download = {
	blob: ({ name, blob }: { name: string; blob: Blob }) =>
		trySync({
			try: () => {
				const url = URL.createObjectURL(new File([blob], name, { type: blob.type }));
				const anchor = Object.assign(document.createElement('a'), { href: url, download: name });
				anchor.click();
				URL.revokeObjectURL(url);
			},
			catch: (cause) => DownloadError.Failed({ cause }),
		}),
};
```

The shared contract carries the public Result type. The implementation
imports no app settings or reporting.

## Factory with inputs or a lifecycle

Use a factory when it owns construction inputs or state whose lifetime
matters. Whispering passes `folder.audio` and the platform recorder to
[`createMicrophoneDevice`](../../../../apps/whispering/src/lib/microphone.ts). Each successful `start` returns a session whose `stop` closes over that recording. If the platform recorder supports recovering a take after a quit or crash, the device also exposes `recover`.

The complete `start` method shows the lifetime boundary. The factory's other members are omitted:

```typescript
async start({ id, input, signal }) {
	const { data: recording, error } = await recorder.start({
		files,
		path: `${DIRECTORY}/${id}`,
		input,
		signal,
	});
	if (error !== null) return Err(error);
	const startedAt = performance.now();
	return Ok({
		startedAt,
		onEnded: recording.onEnded,
		async stop() {
			const { data, error: stopError } = await recording.stop();
			if (stopError !== null) return Err(stopError);
			return Ok({ durationMs: data.durationMs });
		},
	});
},
```

`files` and `recorder` belong to the device instance. Each call to `start`
captures a different `recording`, and the returned session's `stop` method
closes over that recording.

## Decision

Keep a factory when at least one is true:

- callers provide construction dependencies or configuration (the store);
- each instance owns independent mutable state;
- creation acquires a resource that teardown must release;
- tests need several isolated instances of that lifecycle.

Otherwise export a plain object. Do not create a factory only to call it once
at module load.

## Result boundary

- Adapt a throwing platform or library call where it enters the service.
- Return an existing Result unchanged when the lower layer already modeled
  it; forward an error by returning the narrowed result itself.
- Keep infallible state changes and cleanup as plain values or `void`.
- Never add a Result merely for signature uniformity.
