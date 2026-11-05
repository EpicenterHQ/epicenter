/**
 * The page side of `smoke/device.ts`: `openFolder` at `home` from the real
 * `@epicenter/folder` web entry (this browser's storage), driven from
 * Playwright through `globalThis.deviceSmoke`. Each step returns plain data
 * the runner checks.
 *
 * The folder's writes never fail and carry no version (ADR-0774,
 * ADR-0775), so the steps that race writes over one version, or where
 * nothing was expected, go below it: a second store of the same place,
 * whose write answers `'stale'` when the path no longer holds what it was
 * made over. That store names its own writes on the broadcast
 * channel, so they reach this page's folder as another writer's do.
 */
import { defineContract } from '@epicenter/definition/contract';
import { opfsStore } from '../src/device/opfs-store.js';
import { storeChecks } from '../src/device/store.conformance.js';
import type { Store, Version } from '../src/device/store.js';
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

/** A store of the same place below the folder, opened once. */
let below: Promise<Store> | undefined;
function belowFolder() {
	below ??= openingOf(place, recorder)
		.open()
		.then(({ data, error }) => {
			if (error !== null) throw new Error(error.message);
			return data;
		});
	return below;
}

/** The version at `path` below the folder, or why there is none. */
async function versionBelow(
	path: string,
): Promise<{ error: string } | { version: Version }> {
	const read = await (await belowFolder()).read([path]);
	if (read.error !== null) return { error: read.error.message };
	const [file] = read.data;
	if (file === undefined || 'gone' in file) return { error: `${path} is missing` };
	return { version: file.version };
}

const encoder = new TextEncoder();
/** A recording note's bytes, in house style. */
const noteBytes = (title: string) =>
	encoder.encode(`---\ntitle: ${title}\n---\n`);

/** What a write below the folder answered, by name. */
const outcome = (written: Awaited<ReturnType<Store['write']>>): string =>
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

/** Wait until the folder connected, so what is heard after is a change. */
async function connected() {
	for (let turn = 0; turn < 400 && folder.state().status !== 'open'; turn++)
		await new Promise((resolve) => setTimeout(resolve, 5));
}

/** How many times this page's listener heard the recordings change. */
let heard = 0;
/** How many times this page's listener heard the audio change. */
let heardAudio = 0;

const smoke = {
	/**
	 * The store conformance checks over this browser's private files: the
	 * store under test, and a second store writing as another tab would. Answers each check's failure, or `ok`.
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
		await connected();
		folder.recordings.subscribe(() => heard++);
		heard = 0;
	},
	heard: () => heard,
	/** Start hearing the audio change, from this tab or another, once it is listed. */
	async listenAudio() {
		await connected();
		folder.audio.subscribe(() => heardAudio++);
		heardAudio = 0;
	},
	heardAudio: () => heardAudio,
	/**
	 * Write a take of `count` pieces of 64 KB once, whole, as the browser
	 * recorder does at Stop (ADR-0779), and read it back.
	 */
	async writeTake(id: string, count: number) {
		const at = { id, ext: 'webm' };
		const whole = new Uint8Array(count * 64 * 1024);
		for (let index = 0; index < count; index++)
			whole.set(payload(64 * 1024, index + 1), index * 64 * 1024);
		await folder.audio.set(at, whole);
		const read = await folder.audio.read(at);
		return (
			read.error === null &&
			read.data !== null &&
			(await sha256(read.data.bytes)) === (await sha256(whole))
		);
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
		const note = await versionBelow(`recordings/${id}.md`);
		if ('error' in note) return note;
		const audio = await versionBelow(`recordings/${id}.m4a`);
		if ('error' in audio) return audio;
		const listed = await (await belowFolder()).list([`recordings/${id}.m4a`]);
		const occupied = await (await belowFolder()).write(
			`recordings/${id}.md`,
			noteBytes('Again'),
			'absent',
		);
		return {
			noteText: await opfsText(`recordings/${id}.md`),
			noteVersion: note.version,
			audioVersion: audio.version,
			expectedAudioHash: await sha256(bytes),
			readHash: await sha256(read.data.bytes),
			readVersion: listed.error === null ? listed.data[0]?.version : null,
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
		return outcome(
			await (await belowFolder()).write(
				`recordings/${id}.md`,
				noteBytes(title),
				over as Version,
			),
		);
	},
	/** One writer's write where nothing is, below the folder, for two pages to race on one path. */
	async create(id: string, title: string) {
		return outcome(
			await (await belowFolder()).write(
				`recordings/${id}.md`,
				noteBytes(title),
				'absent',
			),
		);
	},
	/**
	 * Two writes of `id` over one version, then two writes where nothing is
	 * at one new path, each pair racing within this page through one store:
	 * the store's per-path Web Lock lets exactly one of each land.
	 */
	async raceInOnePage(id: string) {
		const store = await belowFolder();
		const created = await store.write(
			`recordings/${id}.md`,
			noteBytes('Read'),
			'absent',
		);
		if (created.error !== null) return { error: created.error.message };
		if (created.data === null || created.data === 'stale')
			return { error: `the first write answered ${created.data}` };
		const over = created.data;
		const updates = await Promise.all(
			['A', 'B'].map(async (title) =>
				outcome(
					await store.write(`recordings/${id}.md`, noteBytes(title), over),
				),
			),
		);
		const creates = await Promise.all(
			['A', 'B'].map(async (title) =>
				outcome(
					await store.write(
						`recordings/${id}-new.md`,
						noteBytes(title),
						'absent',
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
		const cause = ('cause' in error ? error.cause : undefined) as
			| { name?: string }
			| undefined;
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
