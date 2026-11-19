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
matters. Whispering's desktop `Files` is
[`tauriFiles`](../../../../apps/whispering/src/lib/files/tauri.ts): it takes
the folder, or a function that finds it, and the shell's `invoke`, which a
test replaces. The folder is asked for once, on the first operation, and every
method after that reuses the answer.

The construction and one method show the lifetime boundary. The factory's
other members are omitted:

```typescript
export function tauriFiles(
	dir: string | (() => Promise<string>),
	invoke: Invoke = tauriInvoke,
): Files {
	let root: Promise<string> | undefined;
	const folder = () =>
		(root ??= typeof dir === 'string' ? Promise.resolve(dir) : dir());

	return {
		async read(path) {
			const checked = checkPath(path);
			if (checked.error !== null) return checked;
			const answer = await call<unknown>('files_read', {
				folder: await folder(),
				path,
			});
			if (answer.error?.name === 'NotFound') return Ok(null);
			if (answer.error !== null) return answer;
			return Ok(bytesOf(answer.data));
		},
		// ...
	};
}
```

`dir`, `invoke` and `root` belong to the instance. Two instances over two
folders never share an answer, and a test makes as many as it needs.

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
