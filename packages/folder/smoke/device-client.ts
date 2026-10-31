/**
 * The page side of `smoke/device.ts`: `openDevice` from the real
 * `@epicenter/folder/browser` entry, driven from Playwright through
 * `globalThis.deviceSmoke`. Each step returns plain data the runner checks.
 */
import { defineContract, type Version } from '@epicenter/definition/contract';
import { openDevice, outboxOf } from '../src/browser.js';

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

const device = openDevice(recorder);

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

const smoke = {
	/** Start hearing the recordings change, from this tab or another. */
	listen() {
		device.recordings.subscribe(() => heard++);
	},
	heard: () => heard,
	/** Create a note and 5 MB of audio, read both back, and record a capture. */
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
		const captured = await outboxOf(device).add({
			id,
			files: [
				{ collection: 'recordings', ...note.data },
				{ collection: 'audio', ...audio.data },
			],
		});
		return {
			noteText: await opfsText(`recordings/${id}.md`),
			noteVersion: note.data.version,
			audioVersion: audio.data.version,
			expectedAudioHash: await sha256(bytes),
			readHash: await sha256(read.data.bytes),
			readVersion: read.data.version,
			callerBytesIntact: bytes.byteLength === 5 * 1024 * 1024,
			occupied: occupied.error?.name ?? null,
			capture:
				captured.error !== null ? captured.error.name : captured.data.state,
		};
	},
	/** What the device lists now, as plain data. */
	async read(id: string) {
		const notes = await device.recordings.list();
		const files = await device.audio.list();
		const captures = await outboxOf(device).list();
		const audio = await device.audio.get({ id, ext: 'm4a' });
		return {
			notes:
				notes.error !== null
					? notes.error.name
					: notes.data.items.map(({ id, title }) => ({ id, title })),
			files: files.error !== null ? files.error.name : files.data.items,
			captures:
				captures.error !== null
					? captures.error.name
					: captures.data.items.map(({ id, state }) => ({ id, state })),
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
