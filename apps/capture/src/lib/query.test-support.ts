/**
 * Test helper: TanStack Query for tests that drive the Capture store without
 * mounting components.
 *
 * The app imports the query client from `@tanstack/svelte-query`, whose
 * entry also loads `.svelte` components; Bun's server-runtime tests cannot
 * load those. This imports `@tanstack/query-core`, which `svelte-query`
 * re-exports. The catalog pins it to the exact version `svelte-query`
 * depends on, so the install holds one copy and a mounted test that mixes
 * the two shares every class and manager. Change the two pins together.
 */
import type { CaptureFields } from '@epicenter/capture';
import type { StoredRow } from '@epicenter/folder';
import { QueryObserver } from '@tanstack/query-core';
import type { CaptureListing, Captures } from './captures.svelte.js';

export { QueryObserver };

/**
 * Observe the queries the open screens show, so invalidation reads them
 * again as it does in the app. Returns the function that stops observing.
 */
export function observe(captures: Captures, ...paths: string[]) {
	const observers = [
		new QueryObserver(captures.queryClient, captures.rowsQuery()),
		...paths.map(
			(path) =>
				new QueryObserver(
					captures.queryClient,
					captures.queries.files.text.queryOptions(path),
				),
		),
	];
	const stops = observers.map((observer) => observer.subscribe(() => {}));
	return () => {
		for (const stop of stops) stop();
	};
}

/** Wait until nothing is mutating or fetching. */
export async function quiet(captures: Captures) {
	const client = captures.queryClient;
	for (let tries = 0; tries < 400; tries++) {
		if (client.isMutating() === 0 && client.isFetching() === 0) {
			await Bun.sleep(0);
			if (client.isMutating() === 0 && client.isFetching() === 0) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}

/** The capture listing the cache holds now. */
export function listing(captures: Captures): CaptureListing {
	const data = captures.queryClient.getQueryData<CaptureListing>(
		captures.queries.captures.list.queryKey(),
	);
	if (data === undefined) throw new Error('The capture listing is not loaded');
	return data;
}

/** The row the cache holds for `stem`, which must read as a row. */
export function cached(
	captures: Captures,
	stem: string,
): StoredRow<CaptureFields> {
	const result = listing(captures).find((entry) => entry.stem === stem)?.result;
	if (result?.error !== null || result === undefined)
		throw new Error(`No valid row for ${stem} in the cache`);
	return result.data;
}

/** The text the cache holds for `path`, which must be open as text. */
export function cachedText(captures: Captures, path: string): string {
	const file = captures.queryClient.getQueryData<{
		kind: string;
		text?: string;
	}>(captures.queries.files.text.queryKey(path));
	if (file?.kind !== 'text' || file.text === undefined)
		throw new Error(`No text for ${path} in the cache`);
	return file.text;
}
