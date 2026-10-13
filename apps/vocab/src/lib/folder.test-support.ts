/**
 * Test helper: Vocab's real browser folder over the in-memory OPFS stand-in.
 *
 * `open` opens the folder the way the page does, under `VOCAB_FOLDER_ID`, so
 * opening again in the same browser is a reload or another tab. A
 * gated table is the real table with one refusal or delay put in front of it,
 * the way a full or slow browser store answers.
 */
import { FileError, type FolderFiles } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { type VocabFolder, type VocabTables, vocabFolder } from './data.js';
import { VOCAB_FOLDER_ID } from './folder.js';

/** Let the folder answer until `done` holds. */
export async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (done()) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Wait until a conversation has nothing in flight.
 *
 * The folder hashes files with `crypto.subtle`, which answers from a worker
 * thread, so how many turns a write takes depends on machine load. There is
 * no turn budget: a conversation that never settles fails on the test timeout.
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

/** What the words list is given from an open folder, as the page gives it. */
export const entriesOf = (folder: VocabFolder) => ({
	table: folder.tables.entries,
	files: folder.files,
});

/**
 * One browser's storage, and every folder handle opened over it. `opfs` is
 * the stand-in tree itself: its `faults` hold or fail the next write, and
 * `put` and `drop` change a file the way another program would, with no
 * change hint.
 */
export function createBrowser() {
	const tree = createTestStorage();
	const storage = browserStorage(tree);
	const opened: VocabFolder[] = [];
	const opfs = opfsOf(tree);
	/** The stand-in's path for a folder path. */
	const located = (path: string) => {
		const found = [...opfs.files().keys()].find(
			(key) => key.endsWith(`/${path}`) && !key.includes('/.git/'),
		);
		if (found === undefined) throw new Error(`No file at ${path}`);
		return found;
	};
	return {
		opfs,
		/** Write `bytes` at a folder path as another program would. */
		put(path: string, content: string | Uint8Array) {
			opfs.put(
				located(path),
				typeof content === 'string'
					? new TextEncoder().encode(content)
					: content,
			);
		},
		/** Remove a folder path as another program would. */
		drop(path: string) {
			opfs.drop(located(path));
		},
		/** Open Vocab's folder in this browser: a first visit, a reload, or another tab. */
		async open(): Promise<VocabFolder> {
			const folder = expectOk(
				await openFolder({
					id: VOCAB_FOLDER_ID,
					definition: vocabFolder,
					browser: { ...storage },
				}),
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
	const { data: file, error: readError } = await folder.files.read(path);
	return readError === null ? new TextDecoder().decode(file.bytes) : undefined;
}

/** The paths of every file in one table's directory, sorted. */
export async function tableFiles(
	folder: VocabFolder,
	table: keyof VocabTables,
): Promise<string[]> {
	const listed = expectOk(await folder.files.list());
	return listed.files
		.map((file) => file.path)
		.filter((path) => path.startsWith(`${table}/`))
		.sort();
}

/**
 * The real table behind a gate. While `failing`, `create` and `list` answer
 * with a storage failure and write or read nothing. A held operation waits
 * for its promise, then runs for real. A lost receipt and a held listing run
 * for real first: the file is written, or the listing read, before the answer
 * is refused or delayed.
 */
export function gated<TTable extends VocabTables[keyof VocabTables]>(
	table: TTable,
) {
	const gate = {
		failing: false,
		/** The next create really lands, and its answer is lost as a refusal. */
		losingReceipt: false,
		heldCreate: undefined as Promise<void> | undefined,
		heldList: undefined as Promise<void> | undefined,
		/** A listing is read at once and delivered only after this resolves. */
		heldListing: undefined as Promise<void> | undefined,
		/** Settles once a held listing has been read, before it is delivered. */
		listingRead: Promise.withResolvers<void>(),
		creates: 0,
		lists: 0,
	};
	const refused = (operation: string) =>
		FileError.Io({
			path: table.name,
			operation,
			cause: new Error('storage refused'),
		});
	return {
		gate,
		table: {
			...table,
			async create(
				row: Parameters<TTable['create']>[0],
				options?: Parameters<TTable['create']>[1],
			) {
				await gate.heldCreate;
				gate.creates++;
				if (gate.failing) return refused('write');
				const created = await table.create(row as never, options);
				if (!gate.losingReceipt) return created;
				gate.losingReceipt = false;
				return refused('confirm the write of');
			},
			async list() {
				// Read when the listing is asked for, so a test can hold one listing.
				const { heldListing } = gate;
				gate.lists++;
				await gate.heldList;
				if (gate.failing) return refused('list');
				const listed = await table.list();
				if (heldListing) gate.listingRead.resolve();
				await heldListing;
				return listed;
			},
		} as TTable,
	};
}

/**
 * The folder with its `messages` table behind a gate, and `messages/` listed
 * through the same gate: a chat's read lists that directory, so `heldList`,
 * `heldListing`, and `failing` hold or refuse it as they do a table listing.
 */
export function gatedMessages(folder: VocabFolder) {
	const { gate, table } = gated(folder.tables.messages);
	const files: FolderFiles = {
		...folder.files,
		async children(directory) {
			const { heldListing } = gate;
			gate.lists++;
			await gate.heldList;
			if (gate.failing)
				return FileError.Io({
					path: directory,
					operation: 'list',
					cause: new Error('storage refused'),
				});
			const listed = await folder.files.children(directory);
			if (heldListing) gate.listingRead.resolve();
			await heldListing;
			return listed;
		},
	};
	return {
		gate,
		folder: { tables: { ...folder.tables, messages: table }, files },
	};
}
