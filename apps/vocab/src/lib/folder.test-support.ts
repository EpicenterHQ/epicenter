/**
 * Test helper: Vocab's real local folder, `openFolder({ tables: vocabTables })`,
 * over an in-memory IndexedDB.
 *
 * `createBrowser` is one browser profile: every `open` is a reload or another
 * tab of it, and two handles see each other's saves through the folder's
 * change channel. A gated table is the real table with one refusal or delay
 * put in front of it, the way a full or slow browser store answers.
 *
 * Import this before anything that creates a DOM: once a `window` exists,
 * `fake-indexeddb/auto` installs IndexedDB on it rather than on the global
 * the folder reads. Vocab does not depend on `fake-indexeddb` itself; it is
 * loaded from `@epicenter/svelte`'s install, which tests the same folder.
 */
import '../../../../packages/svelte/node_modules/fake-indexeddb/auto/index.mjs';
import type { ReadError, SaveError } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { Err } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { type VocabFolder, type VocabTables, vocabTables } from './data.js';

/** Let the folder answer until `done` holds. */
export async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (done()) return;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Wait until a conversation has nothing in flight. There is no turn budget:
 * a conversation that never settles fails on the test timeout.
 */
export async function settle(conversation: {
	snapshot(): { isGenerating: boolean; isSaving: boolean };
}) {
	while (
		conversation.snapshot().isGenerating ||
		conversation.snapshot().isSaving
	)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * One browser profile with an empty IndexedDB, and every folder handle
 * opened over it. Disposing it closes them all.
 */
export function createBrowser() {
	const indexedDB = new IDBFactory();
	const opened: VocabFolder[] = [];
	return {
		/**
		 * Open Vocab's folder in this browser: a first visit, a reload, or
		 * another tab. Typing saves `saveAfterMs` after the last keystroke.
		 */
		async open({ saveAfterMs = 20 } = {}): Promise<VocabFolder> {
			globalThis.indexedDB = indexedDB;
			const folder = expectOk(
				await openFolder({ tables: vocabTables, saveAfterMs }),
			);
			opened.push(folder);
			return folder;
		},
		async [Symbol.asyncDispose]() {
			for (const folder of opened.splice(0)) await folder.close();
		},
	};
}

/** The exact text of a saved file, or `undefined` when there is none. */
export async function fileText(
	folder: VocabFolder,
	path: string,
): Promise<string | undefined> {
	const file = expectOk(await folder.files.read(path));
	return file === undefined ? undefined : file.content.text();
}

/** The paths of every file in one table's directory, sorted. */
export async function tableFiles(
	folder: VocabFolder,
	table: keyof VocabTables,
): Promise<string[]> {
	return expectOk(await folder.files.list(`${table}/`));
}

/** Save `text` at `path` whatever is there, as another program would. */
export async function put(folder: VocabFolder, path: string, text: string) {
	const current = expectOk(await folder.files.read(path));
	expectOk(
		await folder.files.write(
			path,
			current === undefined ? null : await current.content.text(),
			text,
		),
	);
}

const storageRefused = (operation: string) =>
	Err({
		name: 'StorageFailed',
		message: `Repository ${operation} failed: storage refused`,
		cause: new Error('storage refused'),
	} as const) as Err<SaveError & ReadError>;

/** What a gate does to the operations put behind it. */
export type Gate = {
	/** `set` and every read answer a storage failure and change nothing. */
	failing: boolean;
	/** The next `set` really lands, and its answer is lost as a refusal. */
	losingReceipt: boolean;
	/** A `set` waits for this before it runs. */
	heldSet: Promise<void> | undefined;
	/** A listing waits for this before it is read. */
	heldList: Promise<void> | undefined;
	/** A listing is read at once and delivered only after this resolves. */
	heldListing: Promise<void> | undefined;
	/** Settles once a held listing has been read, before it is delivered. */
	listingRead: PromiseWithResolvers<void>;
	sets: number;
	lists: number;
};

function createGate(): Gate {
	return {
		failing: false,
		losingReceipt: false,
		heldSet: undefined,
		heldList: undefined,
		heldListing: undefined,
		listingRead: Promise.withResolvers<void>(),
		sets: 0,
		lists: 0,
	};
}

/** Run a listing through `gate`. */
async function listThrough<T>(gate: Gate, list: () => Promise<T>) {
	// Read when the listing is asked for, so a test can hold one listing.
	const { heldListing } = gate;
	gate.lists++;
	await gate.heldList;
	if (gate.failing) return storageRefused('read');
	const listed = await list();
	if (heldListing) gate.listingRead.resolve();
	await heldListing;
	return listed;
}

/** The real table behind a gate. */
export function gated<TName extends keyof VocabTables>(
	table: VocabFolder['tables'][TName],
) {
	const gate = createGate();
	const wrapped = {
		...table,
		async set(...args: Parameters<typeof table.set>) {
			await gate.heldSet;
			gate.sets++;
			if (gate.failing) return storageRefused('save');
			const saved = await table.set(...args);
			if (!gate.losingReceipt) return saved;
			gate.losingReceipt = false;
			return storageRefused('save');
		},
		list: () => listThrough(gate, () => table.list()),
	} as VocabFolder['tables'][TName];
	return { gate, table: wrapped };
}

/**
 * The folder with its `messages` table behind a gate, and its file listing
 * through the same gate: a chat's read lists its message files, so
 * `heldList`, `heldListing`, and `failing` hold or refuse it as they do a
 * table listing.
 */
export function gatedMessages(folder: VocabFolder) {
	const { gate, table } = gated<'messages'>(folder.tables.messages);
	const files: VocabFolder['files'] = {
		...folder.files,
		list: (prefix) =>
			listThrough(gate, () => folder.files.list(prefix)) as ReturnType<
				VocabFolder['files']['list']
			>,
	};
	return {
		gate,
		folder: { tables: { ...folder.tables, messages: table }, files },
	};
}
