/**
 * What every store answers the same way (ADR-0778, ADR-0779), as checks any
 * runner calls: `bun test` over memory, a directory, the desktop shell's
 * commands over an emulated shell, a served directory, and the repository
 * on a real server (`remote.postgres.test.ts`). Each check throws when the
 * store does not hold, so it needs no test framework.
 *
 * - The four verbs: a create where nothing is, a put over the version
 *   read, `Moved` (carrying what is there) over any other, a removal, a
 *   listing below the paths asked for, and a read that says what is gone;
 *   a listing, a read and a put name one file's bytes by one version, its
 *   SHA-256, the same for every path (ADR-0824).
 * - Arming before listing: once `watch` answered, a write from outside is
 *   heard, and the listing after it shows it.
 * - A hint never precedes readable bytes: a read made the moment a path is
 *   heard answers the change.
 * - A write racing a read of one path: the read answers whole bytes of one
 *   side with their own version, and the read after the hint answers the
 *   write.
 */

import { CONTRACT_PATH } from '@epicenter/definition/contract';
import type { Result } from 'wellcrafted/result';
import { versionOf } from '../hash.js';
import type { FileRead, Store, Version } from './store.js';

/** A store under test, and the world outside it. */
export type StoreSubject = {
	store: Store;
	/** Write `bytes` at `path`, or remove it for null, as another program, tab or person would. */
	outside(path: string, bytes: Uint8Array | null): Promise<void>;
};

/**
 * How long a check waits for a change to be heard before it fails. A check
 * answers as soon as the store reports, so this only bounds a report that
 * never comes: generous, since a poll or a watcher on a loaded machine can
 * take seconds, and how fast a store hears is not what these checks hold.
 */
const HEARD_WITHIN_MS = 15_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text);

function check(holds: boolean, what: string): asserts holds {
	if (!holds) throw new Error(`The store does not hold: ${what}`);
}

/** The data of a store answer, or a thrown failure. */
function ok<T>(answer: Result<T, unknown>): T {
	if (answer.error !== null)
		throw new Error(
			`The store answered a failure: ${JSON.stringify(answer.error)}`,
		);
	return answer.data as T;
}

async function readOne(store: Store, path: string) {
	const [file] = ok(await store.read([path]));
	check(file !== undefined && file.path === path, `a read answers ${path}`);
	return file;
}

const textOf = (file: FileRead) =>
	'gone' in file ? null : decoder.decode(file.bytes);

/** Wait until `done()` or `ms` passed; answers whether it is done. */
async function until(done: () => boolean, ms: number) {
	const end = Date.now() + ms;
	while (!done() && Date.now() < end)
		await new Promise((resolve) => setTimeout(resolve, 10));
	return done();
}

/** A path no other check or run uses. */
const fresh = (name: string) =>
	`conformance/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}/${name}`;

/** Every check, by name, in the order they run. */
export const storeChecks: Record<
	string,
	(subject: StoreSubject) => Promise<void>
> = {
	async 'the contract is named by its bytes, as a note is'({ store }) {
		// `epicenter.json` is stored as it is, never as a Git LFS pointer, so a
		// listing must name it by the blob id of its bytes; named any other way
		// it looks changed here on every sync, and two computers overwrite each
		// other's title and contract.
		const [there] = ok(await store.read([CONTRACT_PATH]));
		const held = there === undefined || 'gone' in there ? null : there.version;
		const contract = bytes(`{"title":"${fresh('contract')}"}\n`);
		const landed = ok(await store.put(CONTRACT_PATH, contract, held));
		check(
			landed === (await versionOf(contract)),
			'the contract lands as the blob id of its bytes',
		);
		const listed = ok(await store.list([CONTRACT_PATH]));
		check(
			listed.length === 1 && listed[0]?.version === landed,
			'a listing names the contract by the blob id of its bytes',
		);
		ok(await store.put(CONTRACT_PATH, null, landed as Version));
	},

	async 'the four verbs'({ store }) {
		const note = fresh('a.md');
		const audio = note.replace(/a\.md$/, 'a.webm');
		const made = ok(await store.put(note, bytes('one'), null));
		check(
			made === (await versionOf(bytes('one'))),
			'a create lands as the blob id of its bytes',
		);
		const occupied = await store.put(note, bytes('two'), null);
		check(
			occupied.error?.name === 'Moved' && occupied.error.now === made,
			'a create where a file is has moved, to what is there',
		);
		const read = await readOne(store, note);
		check(
			textOf(read) === 'one' && !('gone' in read) && read.version === made,
			'a read names what landed',
		);
		const replaced = ok(await store.put(note, bytes('two'), made as Version));
		check(
			replaced === (await versionOf(bytes('two'))),
			'a put over the version read lands',
		);
		const stale = await store.put(note, bytes('three'), made as Version);
		check(
			stale.error?.name === 'Moved' && stale.error.now === replaced,
			'a put over a version no longer there has moved, to what is there',
		);
		const sound = ok(await store.put(audio, new Uint8Array([1, 2, 3]), null));
		check(
			sound === (await versionOf(new Uint8Array([1, 2, 3]))),
			'an attachment lands as the blob id of its Git LFS pointer',
		);
		const directory = note.slice(0, note.lastIndexOf('/'));
		const listed = ok(await store.list([directory]));
		const byPath = new Map(listed.map((file) => [file.path, file]));
		check(
			listed.length === 2,
			'a listing names only the files below the paths asked for',
		);
		check(
			byPath.get(note)?.version === replaced,
			'a listing and a put name a note alike',
		);
		check(
			byPath.get(audio)?.version === sound,
			'a listing and a put name an attachment alike',
		);
		const [again, attached] = ok(await store.read([note, audio]));
		check(
			again !== undefined &&
				!('gone' in again) &&
				again.version === byPath.get(note)?.version,
			'a listing and a read name a note alike',
		);
		check(
			attached !== undefined &&
				!('gone' in attached) &&
				attached.version === sound,
			'a listing and a read name an attachment alike',
		);
		check(
			ok(await store.list([note])).length === 1,
			'a file path lists that file',
		);
		check(
			ok(await store.put(audio, null, sound as Version)) === null,
			'a removal lands',
		);
		check(
			'gone' in (await readOne(store, audio)),
			'a read of a removed file is gone',
		);
		const gone = await store.put(audio, null, sound as Version);
		check(
			gone.error?.name === 'Moved' && gone.error.now === null,
			'a removal of what is no longer there has moved, to nothing',
		);
		check(
			ok(await store.put(note, null, replaced as Version)) === null,
			'a note is removed',
		);
		check(
			ok(await store.list([directory])).length === 0,
			'nothing is listed after',
		);
	},

	async 'arming before listing'({ store, outside }) {
		const path = fresh('heard.md');
		const heard: (readonly string[] | 'all')[] = [];
		const stop = ok(await store.watch((paths) => heard.push(paths)));
		try {
			await outside(path, bytes('from outside'));
			check(
				await until(
					() => heard.some((paths) => paths === 'all' || paths.includes(path)),
					HEARD_WITHIN_MS,
				),
				'a write from outside after watch answered is heard',
			);
			const listed = ok(await store.list([path]));
			check(listed.length === 1, 'the listing after it shows the write');
			check(
				textOf(await readOne(store, path)) === 'from outside',
				'and reads it new',
			);
		} finally {
			stop();
			await outside(path, null);
		}
	},

	async 'a hint never precedes readable bytes'({ store, outside }) {
		const path = fresh('hint.md');
		await outside(path, bytes('old'));
		/** What the read each hint started answered, in the order heard; undefined until it answers. */
		const answered: (string | null | undefined)[] = [];
		const stop = ok(
			await store.watch((paths) => {
				if (paths !== 'all' && !paths.includes(path)) return;
				const at = answered.push(undefined) - 1;
				void readOne(store, path).then((file) => {
					answered[at] = textOf(file);
				});
			}),
		);
		try {
			await outside(path, bytes('new'));
			// A hint for the write before the watch may still arrive first, and
			// its read rightly answers the old bytes; the change's own hint comes
			// after, however late, and a read the moment it is heard answers it.
			check(
				await until(() => answered.at(-1) === 'new', HEARD_WITHIN_MS),
				`a read the moment it was heard answers the change (${answered.join(', ')})`,
			);
		} finally {
			stop();
			await outside(path, null);
		}
	},

	async 'a write racing a read of one path'({ store, outside }) {
		const path = fresh('race.md');
		await outside(path, bytes('before '.repeat(4096)));
		const before = await readOne(store, path);
		check(!('gone' in before), 'the file is there');
		let heard = false;
		const stop = ok(
			await store.watch((paths) => {
				if (paths === 'all' || paths.includes(path)) heard = true;
			}),
		);
		try {
			const [raced] = await Promise.all([
				readOne(store, path),
				outside(path, bytes('after '.repeat(4096))),
			]);
			const text = textOf(raced);
			check(
				text === 'before '.repeat(4096) || text === 'after '.repeat(4096),
				'a read racing a write answers one side whole',
			);
			if (text === 'before '.repeat(4096) && !('gone' in raced))
				check(
					raced.version === before.version,
					'the old bytes keep their version',
				);
			check(await until(() => heard, HEARD_WITHIN_MS), 'the write is heard');
			const after = await readOne(store, path);
			check(
				textOf(after) === 'after '.repeat(4096),
				'the read after the hint answers the write',
			);
			check(
				!('gone' in after) && after.version !== before.version,
				'the new bytes have a new version',
			);
		} finally {
			stop();
			await outside(path, null);
		}
	},
};
