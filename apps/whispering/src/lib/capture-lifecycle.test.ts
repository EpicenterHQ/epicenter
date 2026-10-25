/**
 * Capture Stop, interruption, and departure keep the microphone, row, and
 * folder lifetimes aligned without the page finishing work as it goes.
 *
 * Key behaviors:
 * - Stop finalizes once; a Stop pressed again joins the first, which ends
 *   after the row's length is written
 * - An interruption finishes the captured audio once and keeps its row;
 *   a failed final save keeps the row and says why
 * - Closing waits for no Stop and starts none: a recording under way is
 *   neither stopped nor deleted by the page, gets no length, and an ending
 *   heard afterward finishes nothing
 * - A Stop that answers after closing began writes no length
 * - A recording that answers after closing writes no row
 * - A title saved while Stop writes the length lands beside it
 *
 * A row save that fails meets storage that refuses it below the folder, so
 * the folder fails it as it would on a real disk.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	RecorderError,
	type Recording,
	type RecordingEndedReason,
} from '@epicenter/recorder';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { toneWav } from './capture.js';
import { createMicrophoneDevice } from './microphone.js';
import {
	deferred,
	eventually,
	openMemoryTestFolder,
	openTestServices,
	settled,
} from './services.test-support.js';
import {
	closeTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A recording row file: a Markdown file directly in `recordings/`. */
const isRow = (path: string) =>
	path.startsWith('recordings/') && path.endsWith('.md');

async function open({
	stop,
	beforeStart,
	earlyEnding,
	memory = false,
	fixture = false,
}: {
	stop?: (path: string) => ReturnType<Recording['stop']>;
	beforeStart?: Promise<void>;
	earlyEnding?: RecordingEndedReason;
	/** Over memory, whose storage a test can hold or make refuse. */
	memory?: boolean;
	/** Record with the fixture device, which writes its audio through the folder at Stop. */
	fixture?: boolean;
} = {}) {
	const inMemory = memory ? await openMemoryTestFolder() : undefined;
	const test = await openTestServices({ folder: inMemory });
	let starts = 0;
	let stops = 0;
	const endings: Set<(reason: RecordingEndedReason) => void>[] = [];
	// Like the desktop microphone: the shell writes the audio, not the page.
	const microphone = createMicrophoneDevice({
		inputs: {
			list: async () => Ok({ devices: [] }),
			meter: async () => {
				throw new Error('No microphone test is requested');
			},
			onChange: () => () => {},
		},
		record: async ({ path }) => {
			starts++;
			await beforeStart;
			const listeners = new Set<(reason: RecordingEndedReason) => void>();
			endings.push(listeners);
			return Ok({
				path: `${path}.wav`,
				device: 'Test microphone',
				startedAt: Date.now(),
				onLevel: () => () => {},
				onEnded(listener) {
					if (earlyEnding !== undefined) listener(earlyEnding);
					else listeners.add(listener);
					return () => listeners.delete(listener);
				},
				stop: async () => {
					stops++;
					listeners.clear();
					if (stop !== undefined) return stop(`${path}.wav`);
					return Ok({ path: `${path}.wav`, durationMs: 1000 });
				},
			});
		},
	});
	const { whispering } = await openTestWhispering({
		folder: test.folder,
		services: {
			...test.services,
			capture: fixture ? test.services.capture : microphone,
		},
	});
	cleanups.push(async () => {
		closeTestWhispering({ whispering, folder: test.folder });
		await test.remove();
	});
	return {
		whispering,
		folder: test.folder,
		host: inMemory?.host,
		test,
		starts: () => starts,
		stops: () => stops,
		end: (reason: RecordingEndedReason, index = endings.length - 1) => {
			for (const listener of endings[index] ?? []) listener(reason);
		},
	};
}

/** The recording rows under `root`, by name. */
async function rows(root: string) {
	return (await readdir(join(root, 'recordings'))).filter((name) =>
		name.endsWith('.md'),
	);
}

/** Make storage refuse every recording row save from now on. */
function refuseRows(host: NonNullable<Awaited<ReturnType<typeof open>>['host']>) {
	host.control.beforePut = (path) => {
		if (isRow(path)) throw new Error('the disk refused the row');
	};
}

test('a row create that fails leaves the recording available to Stop and reports its failure', async () => {
	const { whispering, folder, host } = await open({
		memory: true,
		fixture: true,
	});
	refuseRows(host!);

	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	expect(whispering.recorderError).toContain('recording is running');
	expect(whispering.recorderError).toContain('file could not be written');

	await whispering.stopRecording();
	expect(whispering.recorder.phase).toBe('idle');
	expect(whispering.recorderError).toContain('audio is saved');
	const audio = folder.files.filter((file) => file.path.endsWith('.wav'));
	expect(audio).toHaveLength(1);
	expect(expectOk(await folder.read(audio[0]!.path))).toEqual(toneWav());
	expect(folder.tables.recordings.rows).toEqual([]);
});

test('a delayed failed initial row save reports the recording after Stop truthfully', async () => {
	const { whispering, host } = await open({ memory: true });
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	refuseRows(host!);
	const starting = whispering.startRecording();
	await eventually(() => whispering.recorder.phase === 'recording');
	const ending = whispering.stopRecording();
	try {
		// The audio finishes first while the initial row save is still held.
		await eventually(() => whispering.recorder.phase === 'idle');
	} finally {
		host!.control.putGate = undefined;
		release.resolve();
		await Promise.all([starting, ending]);
	}
	expect(whispering.recorder.phase).toBe('idle');
	expect(whispering.recorderError).toContain('audio is saved');
	expect(whispering.recorderError).toContain(
		'recording file could not be written',
	);
	expect(whispering.recorderError).not.toContain('recording is running');
});

for (const reason of [
	'deviceDisconnected',
	'permissionRevoked',
	'streamFailed',
	'storageFailed',
] as const) {
	test(`an interruption (${reason}) finishes captured audio and keeps its recording`, async () => {
		let folder: Awaited<ReturnType<typeof open>>['folder'];
		let audioPath = '';
		const opened = await open({
			stop: async (path) => {
				audioPath = path;
				expectOk(await folder.write(path, toneWav()));
				return Ok({ path, durationMs: 1000 });
			},
		});
		folder = opened.folder;
		await opened.whispering.startRecording();
		opened.end(reason);
		await eventually(() => opened.whispering.recorder.phase === 'idle');
		// The length is written by the Stop the ending started, before closing.
		await opened.whispering.stopRecording();
		closeTestWhispering(opened);
		expect(opened.stops()).toBe(1);
		const [name] = await rows(opened.test.root);
		const saved = await readFile(
			join(opened.test.root, 'recordings', name!),
			'utf8',
		);
		expect(saved).toContain('durationMs: 1000');
		expect(
			new Uint8Array(await readFile(join(opened.test.root, audioPath))),
		).toEqual(new Uint8Array(toneWav()));
		expect(opened.whispering.recorderError).toContain('Recording stopped');
	});
}

test('an interruption already reported at startup finishes the capture once', async () => {
	const { whispering, stops } = await open({
		earlyEnding: 'permissionRevoked',
	});
	await whispering.startRecording();
	await eventually(() => whispering.recorder.phase === 'idle');
	expect(stops()).toBe(1);
	expect(whispering.recorderError).toContain('permission');
});

test.each(['refused', 'thrown'] as const)(
	'an interrupted capture whose final save is %s keeps its row and reports the failure',
	async (failure) => {
		const { whispering, folder, end } = await open({
			stop: async () => {
				if (failure === 'thrown') throw new Error('disk is full');
				return RecorderError.Refused({ reason: 'disk is full' });
			},
		});
		await whispering.startRecording();
		end('storageFailed');
		await eventually(() => whispering.recorder.phase === 'idle');
		expect(folder.tables.recordings.rows).toHaveLength(1);
		expect(whispering.recorderError).toContain('disk is full');
		expect(whispering.recorderError).not.toContain('audio was saved');
	},
);

test('a Stop pressed again joins the first, which ends once the length is written', async () => {
	const { whispering, folder, host, end, stops } = await open({
		memory: true,
	});
	await whispering.startRecording();
	await settled(folder);
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	const first = whispering.stopRecording();
	// Pressed again, and an ending heard meanwhile: neither stops twice.
	expect(whispering.stopRecording()).toBe(first);
	end('deviceDisconnected');
	await eventually(() => folder.saving);
	// The microphone is free and the recorder idle while the length is
	// written; a Stop pressed now still joins the one writing it.
	expect(whispering.recorder.phase).toBe('idle');
	const again = whispering.stopRecording();
	expect(again).toBe(first);
	let joined = false;
	void again.then(() => {
		joined = true;
	});
	await Bun.sleep(10);
	expect(joined).toBe(false);
	host!.control.putGate = undefined;
	release.resolve();
	await again;
	expect(stops()).toBe(1);
	expect(folder.tables.recordings.rows[0]?.fields).toMatchObject({
		durationMs: 1000,
	});
});

test('closing leaves a recording under way to the page’s departure: nothing is stopped, deleted, or written', async () => {
	const { folder, whispering, test, end, stops } = await open();
	// Answers once the row written at start is saved.
	await whispering.startRecording();
	expect(await rows(test.root)).toHaveLength(1);

	closeTestWhispering({ whispering, folder });
	// An ending heard after closing finishes nothing either.
	end('deviceDisconnected');
	await whispering.stopRecording();

	expect(stops()).toBe(0);
	const files = await readdir(join(test.root, 'recordings'));
	expect(files).toHaveLength(1);
	expect(
		await readFile(join(test.root, 'recordings', files[0]!), 'utf8'),
	).not.toContain('durationMs');
});

test('closing during an interrupted capture’s Stop waits for neither the Stop nor its length', async () => {
	const release = deferred<void>();
	const { folder, whispering, test, end, stops } = await open({
		stop: async () => {
			await release.promise;
			return Ok({ path: 'recordings/interrupted.wav', durationMs: 1000 });
		},
	});
	await whispering.startRecording();
	end('deviceDisconnected');
	end('streamFailed');
	expect(whispering.recorder.phase).toBe('stopping');
	expect(stops()).toBe(1);

	closeTestWhispering({ whispering, folder });

	expect(stops()).toBe(1);
	release.resolve();
	await eventually(() => whispering.recorder.phase === 'idle');
	// The Stop answered after closing, so its length is never written.
	const [name] = await rows(test.root);
	expect(
		await readFile(join(test.root, 'recordings', name!), 'utf8'),
	).not.toContain('durationMs');
	expect(whispering.recorderError).toContain('Recording stopped');
});

test('a Stop whose row was still saving when closing began writes no length', async () => {
	const { whispering, folder, host } = await open({ memory: true });
	const release = deferred<void>();
	cleanups.push(() => release.resolve());
	host!.control.putGate = release.promise;
	const starting = whispering.startRecording();
	await eventually(() => whispering.recorder.phase === 'recording');
	const stopping = whispering.stopRecording();
	await eventually(() => whispering.recorder.phase === 'idle');
	closeTestWhispering({ whispering, folder });
	host!.control.putGate = undefined;
	release.resolve();
	await Promise.all([starting, stopping]);
	await settled(folder);
	const [row] = folder.tables.recordings.rows;
	expect(row?.issues).toBeNull();
	expect(row?.fields).not.toHaveProperty('durationMs');
	expect(whispering.recorderError).toBeUndefined();
});

test('a recording that answers after closing writes no row', async () => {
	const answer = deferred<void>();
	const { folder, whispering, test, starts, stops } = await open({
		beforeStart: answer.promise,
	});
	const starting = whispering.startRecording();
	await eventually(() => starts() === 1);
	closeTestWhispering({ whispering, folder });
	answer.resolve();
	await starting;
	expect(stops()).toBe(0);
	expect(whispering.recorder.phase).toBe('idle');
	expect(
		await readdir(join(test.root, 'recordings')).catch(() => [] as string[]),
	).toEqual([]);
});

test('the current audio path stays known until Stop finishes its bytes', async () => {
	const release = deferred<void>();
	const { whispering } = await open({
		stop: async (path) => {
			await release.promise;
			return Ok({ path, durationMs: 1000 });
		},
	});
	await whispering.startRecording();
	await eventually(() => whispering.entries.length === 1);
	const entry = whispering.entries[0]!;
	const expected = whispering.audioOf(entry);
	expect(expected.kind).toBe('here');
	const stopping = whispering.stopRecording();
	try {
		expect(
			whispering.capturePhase(expected.kind === 'here' ? expected.path : ''),
		).toBe('stopping');
		expect(whispering.audioOf(entry)).toEqual(expected);
	} finally {
		release.resolve();
		await stopping;
	}
});

test('a length that could not be written is reported, and the row keeps what landed', async () => {
	const { whispering, folder, test } = await open();
	await whispering.startRecording();
	await eventually(() => whispering.entries.length === 1);
	const [name] = await rows(test.root);
	const id = name!.slice(0, -'.md'.length);
	expectOk(
		await folder.tables.recordings.update(id, { body: 'Notes before Stop.\n' }),
	);
	const directory = join(test.root, 'recordings');
	chmodSync(directory, 0o555);
	try {
		await whispering.stopRecording();
	} finally {
		chmodSync(directory, 0o755);
	}
	expect(whispering.recorderError).toContain('length could not be written');
	expect(folder.tables.recordings.row(id)?.body).toBe('Notes before Stop.\n');
	expectOk(
		await folder.tables.recordings.update(id, { body: 'Notes after Stop.\n' }),
	);
	const saved = await readFile(join(directory, name!), 'utf8');
	expect(saved).not.toContain('durationMs');
	expect(saved).toContain('Notes after Stop.');
});

test('a title saved while Stop writes the length lands beside it', async () => {
	const { whispering, folder, test } = await open();
	await whispering.startRecording();
	await settled(folder);
	const [name] = await rows(test.root);
	const id = name!.slice(0, -'.md'.length);
	const stopping = whispering.stopRecording();
	const titled = folder.tables.recordings.update(id, {
		fields: { title: 'Typed while stopping' },
	});
	await stopping;
	expectOk(await titled);
	await settled(folder);
	expect(folder.tables.recordings.row(id)?.fields).toMatchObject({
		title: 'Typed while stopping',
		durationMs: 1000,
	});
	const saved = await readFile(join(test.root, 'recordings', name!), 'utf8');
	expect(saved).toContain('durationMs: 1000');
	expect(saved).toContain('Typed while stopping');
});
