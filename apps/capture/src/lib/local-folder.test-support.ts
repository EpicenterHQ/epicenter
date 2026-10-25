/**
 * Capture mirror test harness.
 *
 * Opens the real folder mirror on a memory host, with the same Svelte wrapper
 * and failure reporting used by OpenFolder.
 */
import { type CaptureRow, captureTables } from '@epicenter/capture';
import { createFolder, memoryHost } from '@epicenter/folder/next/testing';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { SaveError } from '../../../../packages/folder/src/shared/errors.js';
import type { Captures } from './captures.svelte.js';

export async function until(check: () => boolean, what = 'the check') {
	for (let tries = 0; tries < 400; tries++) {
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

export async function openCaptures(
	files: Record<string, string | Uint8Array> = {},
	{ throttleMs = 20 }: { throttleMs?: number } = {},
) {
	const host = memoryHost(files);
	const raw = expectOk(
		await createFolder(host.storage, { tables: captureTables, throttleMs }),
	);
	const { svelteFolder } = await import('@epicenter/svelte/folder-next');
	const { createCaptures } = await import('./captures.svelte.ts');
	const failures: { path: string; text: string | undefined }[] = [];
	const folder = svelteFolder(raw, {
		onFailed: ({ path, text }) => failures.push({ path, text }),
	});
	const captures: Captures = createCaptures(folder);
	return {
		raw,
		folder,
		host,
		captures,
		failures,
		rows: (): readonly CaptureRow[] => folder.tables.captures.rows,
		cached: (stem: string) => folder.tables.captures.row(stem),
		text: (path: string) => host.text(path),
		writeElsewhere(path: string, text: string) {
			host.outside(path, text);
		},
		deleteElsewhere(stem: string) {
			host.outside(`captures/${stem}.md`, null);
		},
		failSaves(path: string) {
			host.control.failPut.set(
				path,
				expectErr(SaveError.StorageFailed({ cause: 'the disk is full' })),
			);
			return () => host.control.failPut.delete(path);
		},
		async quiet() {
			await until(() => !raw.saving(), 'saves to land');
		},
		close: () => raw.close(),
	};
}
export type CapturesHarness = Awaited<ReturnType<typeof openCaptures>>;
