/**
 * The page side of `smoke/folder.ts`: `openFolder` at `home` from the real
 * `@epicenter/folder` web entry (this browser's storage), driven from
 * Playwright through `globalThis.deviceSmoke`. Each step returns plain data
 * the runner checks.
 */
import { defineContract, type Version } from '@epicenter/definition/contract';
import { home, openFolder } from '../src/home.js';

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

const folder = openFolder(
	recorder,
	home({ site: 'https://recorder.epicenter.so' }),
);

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

/** How many times this page's listener heard the recordings change. */
let heard = 0;
/** How many times this page's listener heard the audio change. */
let heardAudio = 0;

const smoke = {
	/** Start hearing the recordings change, from this tab or another. */
	listen() {
		folder.recordings.subscribe(() => heard++);
	},
	heard: () => heard,
	/** Start hearing the audio change, from this tab or another. */
	listenAudio() {
		folder.audio.subscribe(() => heardAudio++);
	},
	heardAudio: () => heardAudio,
	/**
	 * Append `count` pieces of 64 KB to a new file, as a recording does,
	 * reading it over and over meanwhile: every read must answer. Then a
	 * second create is `Occupied`, an empty announcing append lands, and the
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
				if (appended.error !== null)
					return `piece ${index}: ${appended.error.message}`;
			}
			return null;
		})().finally(() => {
			done = true;
		});
		const readFailures: string[] = [];
		let reads = 0;
		while (!done) {
			const read = await folder.audio.read({ id, ext: 'webm' });
			reads++;
			if (read.error !== null && read.error.name !== 'NotFound')
				readFailures.push(read.error.message);
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
		const read = await folder.audio.read({ id, ext: 'webm' });
		const whole = new Uint8Array(count * 64 * 1024);
		for (const [index, piece] of pieces.entries())
			whole.set(piece, index * 64 * 1024);
		return {
			problem,
			reads,
			readFailures,
			again: again.error?.name ?? 'landed',
			announced: announced.error?.name ?? 'landed',
			whole:
				read.error === null &&
				(await sha256(read.data.bytes)) === (await sha256(whole)),
		};
	},
	/** Create a note and 5 MB of audio, and read both back. */
	async seed(id: string) {
		const note = await folder.recordings.create({
			id,
			durationMs: 1500,
			title: 'Standup',
			body: 'Notes.\n',
		});
		if (note.error !== null) return { error: note.error.message };
		const bytes = payload(5 * 1024 * 1024, 7);
		const audio = await folder.audio.create({ id, ext: 'm4a', bytes });
		if (audio.error !== null) return { error: audio.error.message };
		const read = await folder.audio.read({ id, ext: 'm4a' });
		if (read.error !== null) return { error: read.error.message };
		const occupied = await folder.recordings.create({ id, title: 'Again' });
		return {
			noteText: await opfsText(`recordings/${id}.md`),
			noteVersion: note.data.version,
			audioVersion: audio.data.version,
			expectedAudioHash: await sha256(bytes),
			readHash: await sha256(read.data.bytes),
			readVersion: read.data.version,
			callerBytesIntact: bytes.byteLength === 5 * 1024 * 1024,
			occupied: occupied.error?.name ?? null,
		};
	},
	/** What the device lists now, as plain data. */
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
					: await sha256(audio.data.bytes),
		};
	},
	/** One writer's update over `over`, for two pages to race. */
	async update(id: string, title: string, over: string) {
		const updated = await folder.recordings.update(
			{ id },
			{ title },
			{ base: { version: over as Version } },
		);
		return updated.error?.name ?? 'landed';
	},
	/** One writer's create, for two pages to race on one path. */
	async create(id: string, title: string) {
		const created = await folder.recordings.create({ id, title });
		return created.error?.name ?? 'landed';
	},
	/**
	 * Two updates of `id` over one version, then two creates of one new
	 * path, each pair racing within this page: the Worker's per-path Web
	 * Lock lets exactly one of each land.
	 */
	async raceInOnePage(id: string) {
		const created = await folder.recordings.create({ id, title: 'Read' });
		if (created.error !== null) return { error: created.error.message };
		const over = created.data.version;
		const updates = await Promise.all(
			['A', 'B'].map(async (title) => {
				const updated = await folder.recordings.update(
					{ id },
					{ title },
					{ base: { version: over } },
				);
				return updated.error?.name ?? 'landed';
			}),
		);
		const creates = await Promise.all(
			['A', 'B'].map(async (title) => {
				const made = await folder.recordings.create({
					id: `${id}-new`,
					title,
				});
				return made.error?.name ?? 'landed';
			}),
		);
		return { updates, creates };
	},
	/**
	 * Delete `count` notes while listing over and over, as another tab may
	 * delete while this page lists: every listing must answer.
	 */
	async listDuringDeletes(count: number) {
		const made = [];
		for (let index = 0; index < count; index++) {
			const created = await folder.recordings.create({
				id: `gone${index}`,
				title: 'Gone',
			});
			if (created.error !== null) return { error: created.error.message };
			made.push(created.data);
		}
		let done = false;
		const deletes = Promise.all(
			made.map(({ id, version }) =>
				folder.recordings.delete({ id }, { over: version }),
			),
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
		const deleted = (await deletes).filter(({ error }) => error === null);
		return { listings, failures, deleted: deleted.length };
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
