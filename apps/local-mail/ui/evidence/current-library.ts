import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';

/** Echo a new library's seed in the production download format; no remote sync. */
export async function currentLibraryResponse(request: Request) {
	if (
		request.method !== 'POST' ||
		!/^\/api\/libraries\/[^/]+\/(personal|shared)\/data\/[^/]+\/current$/.test(
			new URL(request.url).pathname,
		)
	)
		throw new Error(
			`Unexpected fixture request: ${request.method} ${request.url}`,
		);
	return createCurrentDownloadResponse({
		generation: 1,
		head: 1,
		snapshot: {
			position: 1,
			bytes: new Uint8Array(await request.arrayBuffer()),
		},
		tail: [],
	});
}
