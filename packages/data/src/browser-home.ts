import {
	captureBrowserRecordSnapshot,
	openBrowserRecordEpicenter,
} from './browser-record.js';
import type { LensDefinition } from './lens.js';

/** Open the trusted browser Home capability for inert inspection snapshots. */
export async function openBrowserSnapshotHome() {
	const epicenter = await openBrowserRecordEpicenter();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Browser snapshot Home is disposed');
	}

	async function dispose(): Promise<void> {
		if (isDisposed) return;
		isDisposed = true;
		await epicenter[Symbol.asyncDispose]();
	}

	return Object.freeze({
		async captureSnapshot({ lens }: { lens?: LensDefinition } = {}) {
			requireOpen();
			return captureBrowserRecordSnapshot(epicenter, {
				...(lens === undefined ? {} : { lens }),
			});
		},
		[Symbol.asyncDispose]: dispose,
	});
}

export type BrowserSnapshotHome = Awaited<
	ReturnType<typeof openBrowserSnapshotHome>
>;
