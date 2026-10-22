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
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
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
	eventually,
	openTestServices,
	replaceTables,
	withObstructedCreates,
} from './services.test-support.js';
import {
	closeTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open({
	stop,
	beforeStart,
	earlyEnding,
}: {
	stop?: (path: string) => ReturnType<Recording['stop']>;
	beforeStart?: Promise<void>;
	earlyEnding?: RecordingEndedReason;
} = {}) {
	const test = await openTestServices();
	let starts = 0;
	let stops = 0;
	const endings: Set<(reason: RecordingEndedReason) => void>[] = [];
	const capture = createMicrophoneDevice({
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
	const { whispering, context } = await openTestWhispering({
		folder: test.folder,
		services: { ...test.services, capture },
	});
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await test.remove();
	});
	return {
		whispering,
		context,
		capture,
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

test('a delayed failed initial row save reports the recording after Stop truthfully', async () => {
	const test = await openTestServices();
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const recordings = withObstructedCreates(
		test.folder.tables.recordings,
		join(test.root, 'recordings'),
		{ creates: 1 },
	);
	replaceTables(test.folder, {
		recordings: {
			...recordings,
			async set(id, change) {
				if (change.body === '') {
					reached.resolve();
					await release.promise;
				}
				return recordings.set(id, change);
			},
		},
	});
	const { whispering, context } = await openTestWhispering(test);
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await test.remove();
	});
	const starting = whispering.startRecording();
	await reached.promise;
	const ending = whispering.stopRecording();
	try {
		// Finish audio first while the initial row write is still held.
		await eventually(() => whispering.recorder.phase === 'idle');
	} finally {
		release.resolve();
		await Promise.all([starting, ending]);
	}
	expect(whispering.recorder.phase).toBe('idle');
	expect(
		(await readdir(join(test.root, 'recordings'))).filter((path) =>
			path.endsWith('.wav'),
		),
	).toHaveLength(1);
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
		let test: Awaited<ReturnType<typeof open>>['test'];
		let audioPath = '';
		const opened = await open({
			stop: async (path) => {
				audioPath = path;
				expectOk(await test.folder.files.write(path, toneWav()));
				return Ok({ path, durationMs: 1000 });
			},
		});
		test = opened.test;
		await opened.whispering.startRecording();
		opened.end(reason);
		await eventually(() => opened.whispering.recorder.phase === 'idle');
		// The length is written by the Stop the ending started, before closing.
		await opened.whispering.stopRecording();
		await closeTestWhispering(opened);
		expect(opened.stops()).toBe(1);
		const [name] = await rows(test.root);
		const saved = await readFile(join(test.root, 'recordings', name!), 'utf8');
		expect(saved).toContain('durationMs: 1000');
		expect(new Uint8Array(await readFile(join(test.root, audioPath)))).toEqual(
			new Uint8Array(toneWav()),
		);
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
		const { whispering, test, end } = await open({
			stop: async () => {
				if (failure === 'thrown') throw new Error('disk is full');
				return RecorderError.Refused({ reason: 'disk is full' });
			},
		});
		await whispering.startRecording();
		end('storageFailed');
		await eventually(() => whispering.recorder.phase === 'idle');
		expect(expectOk(await test.folder.tables.recordings.list())).toHaveLength(
			1,
		);
		expect(whispering.recorderError).toContain('disk is full');
		expect(whispering.recorderError).not.toContain('audio was saved');
	},
);

test('a Stop pressed again joins the first, which ends once the length is written', async () => {
	const { whispering, test, end, stops } = await open();
	await whispering.startRecording();
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const recordings = test.folder.tables.recordings;
	replaceTables(test.folder, {
		recordings: {
			...recordings,
			async get(id) {
				reached.resolve();
				await release.promise;
				return recordings.get(id);
			},
		},
	});
	const first = whispering.stopRecording();
	// Pressed again, and an ending heard meanwhile: neither stops twice.
	expect(whispering.stopRecording()).toBe(first);
	end('deviceDisconnected');
	await reached.promise;
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
	release.resolve();
	await again;
	expect(stops()).toBe(1);
	const [name] = await rows(test.root);
	expect(
		await readFile(join(test.root, 'recordings', name!), 'utf8'),
	).toContain('durationMs: 1000');
});

test('closing leaves a recording under way to the page’s departure: nothing is stopped, deleted, or written', async () => {
	const { context, whispering, test, end, stops } = await open();
	// Answers once the row written at start is saved.
	await whispering.startRecording();
	expect(await rows(test.root)).toHaveLength(1);

	await closeTestWhispering({ whispering, context });
	// An ending heard after closing finishes nothing either.
	end('deviceDisconnected');
	await whispering.stopRecording();

	expect(stops()).toBe(0);
	expect(test.closes).toBe(1);
	const files = await readdir(join(test.root, 'recordings'));
	expect(files).toHaveLength(1);
	expect(
		await readFile(join(test.root, 'recordings', files[0]!), 'utf8'),
	).not.toContain('durationMs');
});

test('closing during an interrupted capture’s Stop waits for neither the Stop nor its length', async () => {
	const release = Promise.withResolvers<void>();
	const { context, whispering, test, end, stops } = await open({
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

	await closeTestWhispering({ whispering, context });

	expect(test.closes).toBe(1);
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

test('a Stop whose row was still saving when closing began writes no length, after the folder closes', async () => {
	const { whispering, context, test } = await open();
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	cleanups.push(async () => {
		release.resolve();
	});
	const recordings = test.folder.tables.recordings;
	replaceTables(test.folder, {
		recordings: {
			...recordings,
			async set(id, change) {
				const saved = await recordings.set(id, change);
				// The row is on disk; its answer is held, so Stop still waits on it.
				if (change.body === '') {
					reached.resolve();
					await release.promise;
				}
				return saved;
			},
		},
	});
	const starting = whispering.startRecording();
	await reached.promise;
	const stopping = whispering.stopRecording();
	await eventually(() => whispering.recorder.phase === 'idle');
	await closeTestWhispering({ whispering, context });
	release.resolve();
	await Promise.all([starting, stopping]);
	const [name] = await rows(test.root);
	expect(
		await readFile(join(test.root, 'recordings', name!), 'utf8'),
	).not.toContain('durationMs');
	expect(whispering.recorderError).toBeUndefined();
});

test('a recording that answers after context close writes no row', async () => {
	const answer = Promise.withResolvers<void>();
	const { context, whispering, test, starts, stops } = await open({
		beforeStart: answer.promise,
	});
	const starting = whispering.startRecording();
	await eventually(() => starts() === 1);
	context.close();
	answer.resolve();
	await starting;
	expect(stops()).toBe(0);
	expect(whispering.recorder.phase).toBe('idle');
	expect(
		await readdir(join(test.root, 'recordings')).catch(() => [] as string[]),
	).toEqual([]);
});

test('the current audio path stays known until Stop finishes its bytes', async () => {
	const release = Promise.withResolvers<void>();
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
