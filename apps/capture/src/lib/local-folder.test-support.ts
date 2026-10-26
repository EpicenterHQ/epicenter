/**
 * Capture mirror test harness.
 *
 * Opens the real folder mirror on a memory host with its Svelte wrapper.
 */
import { type CaptureRow, captureTables } from '@epicenter/capture';
import {
	createFolder,
	memoryHost,
	SaveError,
	until,
} from '@epicenter/folder/testing';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Captures } from './captures.svelte.js';

export async function openCaptures(
	files: Record<string, string | Uint8Array> = {},
) {
	const host = memoryHost(files);
	const raw = expectOk(
		await createFolder(host.storage, { tables: captureTables }),
	);
	const { svelteFolder } = await import('@epicenter/svelte/folder');
	const { createCaptures } = await import('./captures.svelte.ts');
	const folder = svelteFolder(raw);
	const captures: Captures = createCaptures(folder);
	return {
		raw,
		folder,
		host,
		captures,
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
			await Bun.sleep(1050);
			await until(() => !raw.saving(), { timeout: 2500 });
		},
		close: () => raw.close(),
	};
}
export type CapturesHarness = Awaited<ReturnType<typeof openCaptures>>;
