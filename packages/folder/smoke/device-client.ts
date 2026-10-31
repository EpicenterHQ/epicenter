/**
 * The page side of `smoke/device.ts`: `openDevice` from the real
 * `@epicenter/folder/browser` entry, driven from Playwright through
 * `globalThis.deviceSmoke`. Each step returns plain data the runner checks.
 */
import { defineContract, type Version } from '@epicenter/definition/contract';
import { unwrap } from 'wellcrafted/result';
import { deviceFiles, openDevice } from '../src/browser.js';

const recorder = defineContract({
	name: 'recorder',
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

const device = unwrap(await openDevice(recorder));

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

/** The text at `path` in OPFS, read on this thread without the device. */
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
		device.recordings.subscribe(() => heard++);
	},
	heard: () => heard,
	/** Start hearing the audio change, from this tab or another. */
	listenAudio() {
		device.audio.subscribe(() => heardAudio++);
	},
	heardAudio: () => heardAudio,
	/**
	 * Append `count` pieces of 64 KB to a new file, as a recording does,
	 * reading it over and over meanwhile: every read must answer. Then a
	 * second create is `stale`, an empty announcing append lands, and the
	 * file reads back as every piece in order.
	 */
	async appendPieces(id: string, count: number) {
		const files = deviceFiles(device);
		const path = `recordings/${id}.webm`;
		const pieces = Array.from({ length: count }, (_, index) =>
			payload(64 * 1024, index + 1),
		);
		let done = false;
		const appending = (async () => {
			for (const [index, piece] of pieces.entries()) {
				const appended = await files.append(path, piece, {
					create: index === 0,
					announce: false,
				});
				if (appended.error !== null) return appended.error.message;
				if (appended.data !== 'landed')
					return `piece ${index}: ${appended.data}`;
			}
			return null;
		})().finally(() => {
			done = true;
		});
		const readFailures: string[] = [];
		let reads = 0;
		while (!done) {
			const read = await device.audio.get({ id, ext: 'webm' });
			reads++;
			if (read.error !== null && read.error.name !== 'NotFound')
				readFailures.push(read.error.message);
		}
		const problem = await appending;
		const again = await files.append(path, pieces[0]!, {
			create: true,
			announce: false,
		});
		const announced = await files.append(path, new Uint8Array(), {
			create: false,
			announce: true,
		});
		const read = await device.audio.get({ id, ext: 'webm' });
		const whole = new Uint8Array(count * 64 * 1024);
		for (const [index, piece] of pieces.entries())
			whole.set(piece, index * 64 * 1024);
		return {
			problem,
			reads,
			readFailures,
			again: again.data,
			announced: announced.data,
			whole:
				read.error === null &&
				(await sha256(read.data.bytes)) === (await sha256(whole)),
		};
	},
	/** Create a note and 5 MB of audio, and read both back. */
	async seed(id: string) {
		const note = await device.recordings.create({
			id,
			durationMs: 1500,
			title: 'Standup',
			body: 'Notes.\n',
		});
		if (note.error !== null) return { error: note.error.message };
		const bytes = payload(5 * 1024 * 1024, 7);
		const audio = await device.audio.create({ id, ext: 'm4a', bytes });
		if (audio.error !== null) return { error: audio.error.message };
		const read = await device.audio.get({ id, ext: 'm4a' });
		if (read.error !== null) return { error: read.error.message };
		const occupied = await device.recordings.create({ id, title: 'Again' });
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
		const notes = await device.recordings.list();
		const files = await device.audio.list();
		const audio = await device.audio.get({ id, ext: 'm4a' });
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
		const updated = await device.recordings.update(
			{ id },
			{ title },
			{ over: over as Version },
		);
		return updated.error?.name ?? 'landed';
	},
	/** One writer's create, for two pages to race on one path. */
	async create(id: string, title: string) {
		const created = await device.recordings.create({ id, title });
		return created.error?.name ?? 'landed';
	},
	/**
	 * Delete `count` notes while listing over and over, as another tab may
	 * delete while this page lists: every listing must answer.
	 */
	async listDuringDeletes(count: number) {
		const made = [];
		for (let index = 0; index < count; index++) {
			const created = await device.recordings.create({
				id: `gone${index}`,
				title: 'Gone',
			});
			if (created.error !== null) return { error: created.error.message };
			made.push(created.data);
		}
		let done = false;
		const deletes = Promise.all(
			made.map(({ id, version }) =>
				device.recordings.delete({ id }, { over: version }),
			),
		).finally(() => {
			done = true;
		});
		const failures: string[] = [];
		let listings = 0;
		while (!done) {
			const listed = await Promise.all(
				[1, 2, 3].map(() => device.recordings.list()),
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
		const listed = await device.recordings.list();
		if (listed.error === null) return { name: null, cause: null };
		const cause = listed.error.cause as { name?: string } | undefined;
		return {
			name: listed.error.name,
			cause: listed.error.name === 'Unavailable' ? (cause?.name ?? null) : null,
		};
	},
	/** Files left in the device's staging directory: none after writes land. */
	async staged() {
		try {
			const root = await navigator.storage.getDirectory();
			const staging = await (
				await root.getDirectoryHandle('.epicenter')
			).getDirectoryHandle('staging');
			let count = 0;
			for await (const _ of (
				staging as FileSystemDirectoryHandle & {
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
