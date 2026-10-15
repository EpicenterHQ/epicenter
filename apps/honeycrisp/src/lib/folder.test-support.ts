/**
 * Test helper: Honeycrisp's real browser folder over the folder package's
 * in-memory OPFS stand-in, for tests that need a write to wait, fail, or lose
 * its reply at an exact moment.
 *
 * Nothing here wraps the folder or its tables. A note's write is the
 * production `table.save`, and every fault acts where the folder writes:
 * the stand-in's file streams. A stream that is asked for can be held open
 * (`hold`), a write can fail before anything is published (`failWrites`,
 * `failNextWrite`),
 * and a close can publish and then throw, which the folder reports as
 * `Unconfirmed` (`loseReplies`). Another program's writes and removals go
 * below the API (`put`, `drop`): they take no lock and send no hint, so the
 * app sees them only when it reads again.
 *
 * The stand-in is not a browser: it shows what the app does with each
 * outcome, not a browser's timing or durability.
 */
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { honeycrispDefinition } from './data.js';
import { setUpFolder } from './platform/first-open.js';
import type { NotesHost } from './platform/types.js';

const ID = 'so.epicenter.honeycrisp.test';
/** A browser folder lives at the OPFS root under its ID. */
const ROOT = ID;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export async function openNotesFolder() {
	const storage = createTestStorage();
	const opfs = opfsOf(storage);
	const folder = expectOk(
		await openFolder({
			id: ID,
			definition: honeycrispDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				...browserStorage(storage),
			},
		}),
	);
	await setUpFolder(folder.files, Object.keys(honeycrispDefinition.tables));
	const key = (path: string) => `${ROOT}/${path}`;

	/** Streams held open, by folder path, in the order they were asked for. */
	const held: { path: string; release: () => void }[] = [];
	let holding = false;
	let failing = false;
	let losing = false;
	/** Write streams asked for, by folder path: one per write attempt. */
	const writes: string[] = [];
	/** A file of the folder's own, not its history. */
	const ours = (at: string) =>
		at.startsWith(`${ROOT}/`) && !at.startsWith(`${ROOT}/.git/`);
	opfs.faults.open = (at) => {
		if (ours(at)) writes.push(at.slice(ROOT.length + 1));
		if (!holding || !ours(at)) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		held.push({ path: at.slice(ROOT.length + 1), release: resolve });
		return promise;
	};
	/** Writes still to fail before failing stops on its own; `Infinity` until turned off. */
	let failures = 0;
	opfs.faults.write = (at) => {
		if (!failing || !ours(at)) return undefined;
		failures -= 1;
		if (failures <= 0) failing = false;
		return 'fail';
	};
	opfs.faults.close = (at) => (losing && ours(at) ? 'lost' : undefined);

	const host: NotesHost = {
		folder,
		terminal: undefined,
		location: 'This browser',
		reveal: undefined,
		history: undefined,
		close: () => folder.close(),
	};

	return {
		folder,
		host,
		/** Write a file as the app's own folder would, hinting the change. */
		async write(path: string, text: string) {
			expectOk(await folder.files.create(path, text));
		},
		/** Every file of the folder now, outside its history, sorted. */
		paths: () =>
			[...opfs.files(ROOT).keys()]
				.filter((path) => !path.startsWith('.git/'))
				.sort(),
		/** The file's text now, or undefined when it is gone. */
		text(path: string): string | undefined {
			const bytes = opfs.files(ROOT).get(path);
			return bytes === undefined ? undefined : decoder.decode(bytes);
		},
		/** Another program writes the file. Nothing hints the app. */
		put(path: string, text: string | Uint8Array) {
			opfs.put(
				key(path),
				typeof text === 'string' ? encoder.encode(text) : text,
			);
		},
		/** Another program removes the file. Nothing hints the app. */
		drop(path: string) {
			opfs.drop(key(path));
		},
		/** Every write attempt so far, by folder path. */
		writes: () => [...writes],
		/** Hold every write stream asked for from now on until it is released. */
		hold() {
			holding = true;
		},
		/** The writes waiting to open, oldest first. */
		held: () => held.map((item) => item.path),
		/** Let the oldest held write go on; with `all`, every one, and stop holding. */
		release({ all = false } = {}) {
			if (all) {
				holding = false;
				for (const item of held.splice(0)) item.release();
			} else held.shift()?.release();
		},
		/** Writes fail before anything is published: a full disk. */
		failWrites(on = true) {
			failing = on;
			failures = Number.POSITIVE_INFINITY;
		},
		/** The next write fails before anything is published, and later ones do not. */
		failNextWrite() {
			failing = true;
			failures = 1;
		},
		/** Writes publish, and their reply is lost. */
		loseReplies(on = true) {
			losing = on;
		},
		close: () => folder.close(),
	};
}

export type NotesFolderFixture = Awaited<ReturnType<typeof openNotesFolder>>;

/** Let queued storage replies, settlements, and rereads run. */
export async function settle(turns = 20) {
	for (let i = 0; i < turns; i += 1)
		await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait until `check` holds, or fail naming `what`. */
export async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 2000; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** A note's text in Honeycrisp's standard form, with an unknown nested key. */
export function noteText({
	title = 'A',
	body = 'Body.\n',
	extra = '"owner": {"name": "one", "tags": ["two"]}\n',
}: {
	title?: string;
	body?: string;
	extra?: string;
} = {}) {
	return [
		'---',
		'"folderId": null',
		`"title": ${JSON.stringify(title)}`,
		'"pinned": false',
		'"createdAt": "2026-10-01T00:00:00.000Z"',
		'"updatedAt": "2026-10-01T00:00:00.000Z"',
		'"deletedAt": null',
		`${extra}---`,
		body,
	].join('\n');
}
