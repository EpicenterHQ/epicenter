/**
 * The page side of `smoke/device.ts`: `openFolder` at `home` from the real
 * `@epicenter/folder` web entry (this browser's storage), driven from
 * Playwright through `globalThis.deviceSmoke`. Each step returns plain data
 * the runner checks.
 *
 * The folder's writes never fail and carry no version (ADR-0774,
 * ADR-0775), so the steps that race writes over one version, or where
 * nothing was expected, go below it: the contract's collections over a
 * second store of the same place (`createDeviceClient`), whose write
 * answers `'stale'` when the path no longer holds what it was made over.
 * That store has its own Worker, so its writes reach this page's folder as
 * another writer's do.
 */
import { defineContract } from '@epicenter/definition/contract';
import {
	type CollectionFiles,
	createDeviceClient,
} from '../src/device/client.js';
import { opfsStore } from '../src/device/opfs-store.js';
import { storeChecks } from '../src/device/store.conformance.js';
import type { Version } from '../src/device/store.js';
import { home, openFolder } from '../src/home.js';
import { openingOf } from '../src/place.js';

const recorder = defineContract({
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				durationMs: { type: 'number' },
			},
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
});

const place = home({ site: 'https://recorder.epicenter.so' });
const folder = openFolder(recorder, place);

/** The collections below the folder, over a store of their own, opened once. */
let below:
	| Promise<{ recordings: CollectionFiles; audio: CollectionFiles }>
	| undefined;
function belowFolder() {
	below ??= openingOf(place, recorder)
		.open()
		.then(({ data, error }) => {
			if (error !== null) throw new Error(error.message);
			const { collections } = createDeviceClient(recorder, data);
			return {
				recordings: collections.get('recordings') as CollectionFiles,
				audio: collections.get('audio') as CollectionFiles,
			};
		});
	return below;
}

const encoder = new TextEncoder();
/** A recording note's bytes, in house style. */
const noteBytes = (title: string) =>
	encoder.encode(`---\ntitle: ${title}\n---\n`);

/** What a write below the folder answered, by name. */
const outcome = (
	written: Awaited<ReturnType<CollectionFiles['write']>>,
): string =>
	written.error !== null
		? written.error.name
		: written.data === 'stale'
			? 'stale'
			: 'landed';

/** Deterministic bytes, so both engines and both pages agree on a hash. */
function payload(size: number, seed: number) {
	const bytes = new Uint8Array(size);
	let state = seed >>> 0 || 1;
	for (let index = 0; index < size; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & 0xff;
	}
	return bytes;
}

async function sha256(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** The text at `path` in OPFS, read on this thread without the folder. */
async function opfsText(path: string) {
	let directory = await navigator.storage.getDirectory();
	const segments = path.split('/');
	const name = segments.pop()!;
	for (const segment of segments)
		directory = await directory.getDirectoryHandle(segment);
	const file = await (await directory.getFileHandle(name)).getFile();
	return file.text();
}

/**
 * Wait until a new listener's first listing answered and was heard (`count`
 * is what the listener heard), so what is heard after is a change. A page
 * that listed before is no longer loading, yet its new listener still
 * hears the listing that starts it; up to a second for it.
 */
async function listed(loading: () => boolean, count: () => number) {
	for (let turn = 0; turn < 200 && (loading() || count() === 0); turn++)
		await new Promise((resolve) => setTimeout(resolve, 5));
}

/** An append's answer, by name: `false` is a file that was not as `create` said. */
const appendOutcome = (
	appended: Awaited<ReturnType<typeof folder.audio.append>>,
) =>
	appended.error !== null
		? appended.error.name
		: appended.data
			? 'landed'
			: 'stale';

/** How many times this page's listener heard the recordings change. */
let heard = 0;
/** How many times this page's listener heard the audio change. */
let heardAudio = 0;

const smoke = {
	/**
	 * The store conformance checks over this browser's private files: the
	 * store under test, and a second store with its own Worker writing as
	 * another tab would. Answers each check's failure, or `ok`.
	 */
	async conformance() {
		const answers: Record<string, string> = {};
		for (const [name, run] of Object.entries(storeChecks)) {
			const store = opfsStore();
			const other = opfsStore();
			try {
				await run({
					store,
					async outside(path, bytes) {
						const read = await other.read([path]);
						if (read.error !== null) throw new Error(read.error.message);
						const [there] = read.data;
						const over =
							there === undefined || 'gone' in there ? 'absent' : there.version;
						if (bytes === null && over === 'absent') return;
						const written = await other.write(path, bytes, over);
						if (written.error !== null || written.data === 'stale')
							throw new Error(`the other tab's write did not land`);
					},
					hearingMs: 2000,
				});
				answers[name] = 'ok';
			} catch (cause) {
				answers[name] = String(cause);
			} finally {
				store.close();
				other.close();
			}
		}
		return answers;
	},
	/** Start hearing the recordings change, from this tab or another, once they are listed. */
	async listen() {
		folder.recordings.subscribe(() => heard++);
		await listed(
			() => folder.recordings.loading(),
			() => heard,
		);
		heard = 0;
	},
	heard: () => heard,
	/** Start hearing the audio change, from this tab or another, once it is listed. */
	async listenAudio() {
		folder.audio.subscribe(() => heardAudio++);
		await listed(
			() => folder.audio.loading(),
			() => heardAudio,
		);
		heardAudio = 0;
	},
	heardAudio: () => heardAudio,
	/**
	 * Append `count` pieces of 64 KB to a new file, as a recording does,
	 * reading it over and over meanwhile: every read must answer. Then a
	 * second create is `'stale'`, an empty announcing append lands, and the
	 * file reads back as every piece in order.
	 */
	async appendPieces(id: string, count: number) {
		const at = { id, ext: 'webm' };
		const pieces = Array.from({ length: count }, (_, index) =>
			payload(64 * 1024, index + 1),
		);
		let done = false;
		const appending = (async () => {
			for (const [index, piece] of pieces.entries()) {
				const appended = await folder.audio.append(at, piece, {
					create: index === 0,
					announce: false,
				});
				if (appendOutcome(appended) !== 'landed')
					return `piece ${index}: ${appendOutcome(appended)}`;
			}
			return null;
		})().finally(() => {
			done = true;
		});
		const readFailures: string[] = [];
		let reads = 0;
		while (!done) {
			const read = await folder.audio.read(at);
			reads++;
			if (read.error !== null) readFailures.push(read.error.message);
		}
		const problem = await appending;
		const again = await folder.audio.append(at, pieces[0]!, {
			create: true,
			announce: false,
		});
		const announced = await folder.audio.append(at, new Uint8Array(), {
			create: false,
			announce: true,
		});
		const read = await folder.audio.read(at);
		const whole = new Uint8Array(count * 64 * 1024);
		for (const [index, piece] of pieces.entries())
			whole.set(piece, index * 64 * 1024);
		return {
			problem,
			reads,
			readFailures,
			again: appendOutcome(again),
			announced: appendOutcome(announced),
			whole:
				read.error === null &&
				read.data !== null &&
				(await sha256(read.data.bytes)) === (await sha256(whole)),
		};
	},
	/**
	 * Write a note and 5 MB of audio through the folder, read both back with
	 * their versions, and write where the note is as if nothing were there.
	 */
	async seed(id: string) {
		await folder.recordings.set(
			{ id },
			{ durationMs: 1500, title: 'Standup', body: 'Notes.\n' },
		);
		const bytes = payload(5 * 1024 * 1024, 7);
		await folder.audio.set({ id, ext: 'm4a' }, bytes);
		const read = await folder.audio.read({ id, ext: 'm4a' });
		if (read.error !== null) return { error: read.error.message };
		if (read.data === null) return { error: 'the audio is missing' };
		const files = await belowFolder();
		const note = await files.recordings.read(`recordings/${id}.md`);
		if (note.error !== null) return { error: note.error.message };
		if (note.data === null) return { error: 'the note is missing' };
		const audio = await files.audio.read(`recordings/${id}.m4a`);
		if (audio.error !== null) return { error: audio.error.message };
		if (audio.data === null) return { error: 'the audio is missing' };
		const occupied = await files.recordings.write(
			`recordings/${id}.md`,
			noteBytes('Again'),
			null,
		);
		return {
			noteText: await opfsText(`recordings/${id}.md`),
			noteVersion: note.data.version,
			audioVersion: audio.data.version,
			expectedAudioHash: await sha256(bytes),
			readHash: await sha256(read.data.bytes),
			readVersion: audio.data.version,
			callerBytesIntact: bytes.byteLength === 5 * 1024 * 1024,
			occupied: outcome(occupied),
		};
	},
	/** What the folder lists now, as plain data. */
	async read(id: string) {
		const notes = await folder.recordings.list();
		const files = await folder.audio.list();
		const audio = await folder.audio.read({ id, ext: 'm4a' });
		return {
			notes:
				notes.error !== null
					? notes.error.name
					: notes.data.items.map(({ id, title }) => ({ id, title })),
			files: files.error !== null ? files.error.name : files.data.items,
			audioHash:
				audio.error !== null
					? audio.error.name
					: audio.data === null
						? 'missing'
						: await sha256(audio.data.bytes),
		};
	},
	/** Write the note as the folder does, for a write this page's listeners hear before it answers. */
	async set(id: string, title: string) {
		await folder.recordings.set({ id }, { title });
	},
	/** One writer's write over `over`, below the folder, for two pages to race. */
	async update(id: string, title: string, over: string) {
		const { recordings } = await belowFolder();
		return outcome(
			await recordings.write(
				`recordings/${id}.md`,
				noteBytes(title),
				over as Version,
			),
		);
	},
	/** One writer's write where nothing is, below the folder, for two pages to race on one path. */
	async create(id: string, title: string) {
		const { recordings } = await belowFolder();
		return outcome(
			await recordings.write(`recordings/${id}.md`, noteBytes(title), null),
		);
	},
	/**
	 * Two writes of `id` over one version, then two writes where nothing is
	 * at one new path, each pair racing within this page through one store:
	 * the Worker's per-path Web Lock lets exactly one of each land.
	 */
	async raceInOnePage(id: string) {
		const { recordings } = await belowFolder();
		const created = await recordings.write(
			`recordings/${id}.md`,
			noteBytes('Read'),
			null,
		);
		if (created.error !== null) return { error: created.error.message };
		if (created.data === null || created.data === 'stale')
			return { error: `the first write answered ${created.data}` };
		const over = created.data.version;
		const updates = await Promise.all(
			['A', 'B'].map(async (title) =>
				outcome(
					await recordings.write(`recordings/${id}.md`, noteBytes(title), over),
				),
			),
		);
		const creates = await Promise.all(
			['A', 'B'].map(async (title) =>
				outcome(
					await recordings.write(
						`recordings/${id}-new.md`,
						noteBytes(title),
						null,
					),
				),
			),
		);
		return { updates, creates };
	},
	/**
	 * Delete `count` notes while listing over and over, as another tab may
	 * delete while this page lists: every listing must answer.
	 */
	async listDuringDeletes(count: number) {
		const ids = Array.from({ length: count }, (_, index) => `gone${index}`);
		for (const id of ids)
			await folder.recordings.set({ id }, { title: 'Gone' });
		let done = false;
		const deletes = Promise.all(
			ids.map((id) => folder.recordings.delete({ id })),
		).finally(() => {
			done = true;
		});
		const failures: string[] = [];
		let listings = 0;
		while (!done) {
			const listed = await Promise.all(
				[1, 2, 3].map(() => folder.recordings.list()),
			);
			for (const { error } of listed) {
				listings++;
				if (error !== null) failures.push(error.message);
			}
		}
		await deletes;
		const after = await folder.recordings.list();
		if (after.error !== null) return { error: after.error.message };
		const left = new Set(after.data.items.map(({ id }) => id));
		const deleted = ids.filter((id) => !left.has(id)).length;
		return { listings, failures, deleted };
	},
	/** What a call answers where the browser refuses private storage. */
	async refusal() {
		const listed = await folder.recordings.list();
		if (listed.error === null) return { name: null, cause: null };
		const { error } = listed;
		if (error.name !== 'Unavailable') return { name: error.name, cause: null };
		const cause = error.cause as { name?: string } | undefined;
		return { name: error.name, cause: cause?.name ?? null };
	},
	/** Files left in the folder's `.epicenter/saves`: none after writes land. */
	async staged() {
		try {
			const root = await navigator.storage.getDirectory();
			const saves = await (
				await root.getDirectoryHandle('.epicenter')
			).getDirectoryHandle('saves');
			let count = 0;
			for await (const _ of (
				saves as FileSystemDirectoryHandle & {
					keys(): AsyncIterable<string>;
				}
			).keys())
				count++;
			return count;
		} catch {
			return 0;
		}
	},
};

declare global {
	var deviceSmoke: typeof smoke;
}
globalThis.deviceSmoke = smoke;
