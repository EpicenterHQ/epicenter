import type { NonconformingRowError } from '@epicenter/data/runtime';
import {
	deleteHoneycrispFolder,
	type Folder,
	type FolderId,
	type HoneycrispData,
} from '@epicenter/honeycrisp';
import { searchParams } from './search-params.svelte.js';

export function createFolders({
	honeycrisp,
	refreshNotes,
}: {
	honeycrisp: HoneycrispData;
	refreshNotes(): Promise<void>;
}) {
	let rows = $state.raw<Folder[]>([]);
	let nonconforming = $state.raw<NonconformingRowError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let refreshGeneration = 0;

	async function refresh(): Promise<void> {
		const generation = ++refreshGeneration;
		try {
			const { rows: nextRows, nonconforming: nextNonconforming } =
				await honeycrisp.folders.scan();
			if (generation !== refreshGeneration) return;
			rows = nextRows;
			nonconforming = nextNonconforming;
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			throw cause;
		}
	}

	return {
		refresh,
		get(id: FolderId) {
			return rows.find((folder) => folder.id === id);
		},
		get all() {
			return rows;
		},
		get nonconforming() {
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},

		async create(): Promise<{ id: FolderId }> {
			const folder = await honeycrisp.folders.create({
				name: 'New Folder',
				sortOrder: rows.length,
			});
			await refresh();
			return { id: folder.id };
		},

		async rename(folderId: FolderId, name: string): Promise<void> {
			const result = await honeycrisp.folders.record(folderId).update({ name });
			if (result.error !== null) throw result.error;
			await refresh();
		},

		async delete(folderId: FolderId): Promise<void> {
			await deleteHoneycrispFolder(honeycrisp, folderId);
			await Promise.all([refresh(), refreshNotes()]);
			if (searchParams.folder === folderId) {
				searchParams.update({ folder: null, note: null });
			}
		},
	};
}
