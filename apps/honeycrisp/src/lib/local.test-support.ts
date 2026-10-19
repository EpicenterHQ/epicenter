/**
 * Test helper: Honeycrisp's notes state over this browser's local folder,
 * `openFolder({ tables: honeycrispTables })`, on an in-memory IndexedDB.
 *
 * Each fixture is a fresh browser profile. Nothing here wraps the folder or
 * the notes state: another tab is a second handle of the same profile, whose
 * saves reach the app on the folder's change channel as in a browser, and a
 * full disk is IndexedDB refusing to store (`failSaves`), where the folder
 * writes. The stand-in is not a browser: it shows what the app does with
 * each outcome, not a browser's timing or durability.
 *
 * Load this with `import()` after `fake-indexeddb/auto` and the Svelte
 * runes support, since the notes state is a runes module.
 */
import { openFolder } from '@epicenter/folder/browser';
import { createFolderContext } from '@epicenter/svelte/folder';
import { QueryObserver } from '@tanstack/query-core';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispTables, NOTES, type NoteRow } from './data.js';
import { createNotes, type Notes } from './notes.svelte.js';

const decoder = new TextDecoder();

/**
 * A fresh profile, its folder, the notes state over it, and the queries
 * the open screens observe. `saveAfterMs` is long by default, so a draft
 * saves only when a test sends it.
 */
export async function openNotes({ saveAfterMs = 60_000 } = {}) {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables: honeycrispTables }));
	/** This handle's committed saves, by path. */
	const saved: string[] = [];
	folder.onChange((change) => {
		if (change.origin === 'this-handle') saved.push(...(change.paths ?? []));
	});
	const local = createFolderContext(folder, { saveAfterMs });
	const notes = createNotes(local);
	const others: { close(): Promise<void> }[] = [];
	const stops: (() => void)[] = [];
	const put = IDBObjectStore.prototype.put;

	async function otherTab() {
		const tab = expectOk(await openFolder({ tables: honeycrispTables }));
		others.push(tab);
		return tab;
	}
	let reader: Awaited<ReturnType<typeof otherTab>> | undefined;

	return {
		folder,
		local,
		notes,
		/** Another tab of this profile. Its saves reach the app on the change channel. */
		otherTab,
		/** Save a file as another tab does. */
		async write(path: string, text: string) {
			reader ??= await otherTab();
			const current = expectOk(await reader.files.read(path));
			const from = current
				? new Uint8Array(await current.content.arrayBuffer())
				: null;
			expectOk(await reader.files.write(path, from, text));
		},
		/** The file's text in storage now, or undefined when it is gone. */
		async text(path: string): Promise<string | undefined> {
			reader ??= await otherTab();
			const read = expectOk(await reader.files.read(path));
			return read && decoder.decode(await read.content.arrayBuffer());
		},
		/** The saves this page committed at `path`. */
		saves: (path: string) => saved.filter((at) => at === path).length,
		/** IndexedDB refuses every store from now on, as a full disk does; `false` ends it. */
		failSaves(on = true) {
			IDBObjectStore.prototype.put = on
				? () => {
						throw new DOMException('Disk is full', 'QuotaExceededError');
					}
				: put;
		},
		/**
		 * Observe the queries the open screens show: the note and folder rows,
		 * the file listing, and the text of each path given.
		 */
		observe(...paths: string[]) {
			const observers = [
				new QueryObserver(notes.queryClient, notes.rowsQuery(NOTES)),
				new QueryObserver(notes.queryClient, notes.rowsQuery('folders')),
				new QueryObserver(notes.queryClient, notes.filesQuery()),
				...paths.map(
					(path) => new QueryObserver(notes.queryClient, notes.textQuery(path)),
				),
			];
			for (const observer of observers) stops.push(observer.subscribe(() => {}));
		},
		/** Close the notes as the page does, then every other tab. */
		async close() {
			IDBObjectStore.prototype.put = put;
			for (const stop of stops.splice(0)) stop();
			notes.stop();
			await local.close();
			for (const tab of others.splice(0)) await tab.close();
		},
	};
}

export type NotesFixture = Awaited<ReturnType<typeof openNotes>>;

/** Wait until `check` holds, or fail naming `what`. */
export async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		if (check()) return;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** Wait until nothing is saving or fetching. */
export async function quiet(notes: Notes) {
	const idle = () => !notes.busy && notes.queryClient.isFetching() === 0;
	for (let tries = 0; tries < 1000; tries++) {
		if (idle()) {
			await Bun.sleep(0);
			if (idle()) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The notes did not settle');
}

/** The note rows the cache holds now. */
export function rows(notes: Notes): NoteRow[] {
	const data = notes.queryClient.getQueryData<NoteRow[]>(
		notes.rowsQuery(NOTES).queryKey,
	);
	if (data === undefined) throw new Error('The note rows are not loaded');
	return data;
}

/** The note the cache holds for `id`, which must read as one. */
export function cached(notes: Notes, id: string) {
	const row = rows(notes).find((candidate) => candidate.id === id);
	if (row === undefined || row.issues !== null)
		throw new Error(`No valid note ${id} in the cache`);
	return row;
}

/** A note's text in Honeycrisp's form, with a key Honeycrisp does not name. */
export function noteText({
	title = 'A',
	body = 'Body.\n',
	extra = 'owner:\n  name: one\n  tags: [two]\n',
	folderId = 'null',
}: {
	title?: string;
	body?: string;
	extra?: string;
	folderId?: string;
} = {}) {
	return [
		'---',
		`folderId: ${folderId}`,
		`title: ${JSON.stringify(title)}`,
		'pinned: false',
		'createdAt: "2026-10-01T00:00:00.000Z"',
		'deletedAt: null',
		`${extra}---`,
		body,
	].join('\n');
}

/** A folder's text in Honeycrisp's form. */
export const folderText = (name: string) =>
	`---\nname: ${JSON.stringify(name)}\nicon: null\n---\n`;
