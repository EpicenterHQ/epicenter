/**
 * Capture cancellation and interruption keep the microphone, row, and folder
 * lifetimes aligned. Ends arriving during startup or closing finalize once;
 * failures retain the row and report what could not be saved.
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
import { toneWav } from './capture.js';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { closeTestLibrary, openTestLibrary } from './library.test-support.js';
import { createMicrophoneDevice } from './microphone.js';
import {
	eventually,
	openTestServices,
	replaceTables,
	withObstructedCreates,
} from './services.test-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open({
	cancel,
	stop,
	beforeStart,
	earlyEnding,
}: {
	cancel: Recording['cancel'];
	stop?: (path: string) => ReturnType<Recording['stop']>;
	beforeStart?: Promise<void>;
	earlyEnding?: RecordingEndedReason;
}) {
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
				cancel,
			});
		},
	});
	const library = await openTestLibrary({
		folder: test.folder,
		services: { ...test.services, capture },
	});
	cleanups.push(async () => {
		await closeTestLibrary(library);
		await test.remove();
	});
	return {
		library,
		capture,
		test,
		starts: () => starts,
		stops: () => stops,
		end: (reason: RecordingEndedReason, index = endings.length - 1) => {
			for (const listener of endings[index] ?? []) listener(reason);
		},
	};
}

test('a cancellation is registered before closing, including its row deletion', async () => {
	const release = Promise.withResolvers<void>();
	const { library, test } = await open({
		cancel: async () => {
			await release.promise;
			return Ok(undefined);
		},
	});
	await library.startRecording();
	// The row is on disk even if the listing has not refreshed yet.
	const rows = expectOk(await test.folder.tables.recordings.list());
	expect(rows).toHaveLength(1);
	const cancelling = library.cancelRecording();
	let closed = false;
	const closing = closeTestLibrary(library).then(() => {
		closed = true;
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);
		expect(test.closes).toBe(0);
	} finally {
		release.resolve();
		await cancelling;
		await closing;
	}
	expect(await readdir(join(test.root, 'recordings'))).toEqual([]);
	expect(closed).toBe(true);
});

test('a cancellation releases its microphone before another recording starts', async () => {
	const release = Promise.withResolvers<void>();
	const { library, starts } = await open({
		cancel: async () => {
			await release.promise;
			return Ok(undefined);
		},
	});
	await library.startRecording();
	const cancelling = library.cancelRecording();
	try {
		expect(library.recorder.phase).toBe('stopping');
		await library.cancelRecording();
		expect(library.recorder.phase).toBe('stopping');
		await library.startRecording();
		expect(starts()).toBe(1);
	} finally {
		release.resolve();
		await cancelling;
	}
	expect(library.recorder.phase).toBe('idle');
	await library.startRecording();
	expect(starts()).toBe(2);
});

test('an unconfirmed cancellation keeps the row and permits an explicit stop', async () => {
	const { library, test, stops } = await open({
		cancel: async () =>
			RecorderError.Failed({ cause: 'The native reply was lost' }),
	});
	await library.startRecording();
	await library.cancelRecording();
	expect(expectOk(await test.folder.tables.recordings.list())).toHaveLength(1);
	expect(library.recorderError).toContain('could not be confirmed');
	expect(library.recorder.phase).toBe('recording');
	await library.stopRecording();
	expect(stops()).toBe(1);
	expect(library.recorder.phase).toBe('idle');
	expect(expectOk(await test.folder.tables.recordings.list())).toHaveLength(1);
});

test('the capture adapter reports a native cancellation failure', async () => {
	const { capture } = await open({
		cancel: async () =>
			RecorderError.Failed({ cause: 'The native reply was lost' }),
	});
	const active = expectOk(
		await capture.start({
			folder: { write: async () => Ok(undefined) },
			path: 'audio/test',
		}),
	);
	const result = await active.cancel();
	expect(result).toBeDefined();
	expect(expectErr(result)).toMatchObject({ name: 'Failed' });
});

test('Stop resolves an unknown cancellation even when the host already cancelled it', async () => {
	const { library, test } = await open({
		cancel: async () =>
			RecorderError.Failed({ cause: 'The native reply was lost' }),
		stop: async () =>
			RecorderError.NotRecording({ reason: 'already cancelled' }),
	});
	await library.startRecording();
	await library.cancelRecording();
	await library.stopRecording();
	expect(library.recorder.phase).toBe('idle');
	expect(expectOk(await test.folder.tables.recordings.list())).toHaveLength(1);
});

test('closing after an unconfirmed cancellation finishes the held recording and keeps its row', async () => {
	const release = Promise.withResolvers<void>();
	const { library, test, stops } = await open({
		cancel: async () => {
			await release.promise;
			return RecorderError.Failed({ cause: 'The native reply was lost' });
		},
	});
	await library.startRecording();
	const cancelling = library.cancelRecording();
	const closing = closeTestLibrary(library);
	release.resolve();
	await Promise.all([cancelling, closing]);
	expect(stops()).toBe(1);
	expect(await readdir(join(test.root, 'recordings'))).toHaveLength(1);
});

test('a thrown cancellation keeps its row and remains explicitly stoppable', async () => {
	const { library, test, stops } = await open({
		cancel: async () => {
			throw new Error('The cancellation transport threw');
		},
	});
	await library.startRecording();
	await library.cancelRecording();
	expect(expectOk(await test.folder.tables.recordings.list())).toHaveLength(1);
	expect(library.recorderError).toContain('could not be confirmed');
	await library.stopRecording();
	expect(stops()).toBe(1);
});

test('a capture opening after cancellation handles a cleanup rejection', async () => {
	const release = Promise.withResolvers<void>();
	const { library } = await open({
		beforeStart: release.promise,
		cancel: async () => {
			throw new Error('The late cancellation transport threw');
		},
	});
	const starting = library.startRecording();
	await library.cancelRecording();
	release.resolve();
	await starting;
	expect(library.recorder.phase).toBe('idle');
	expect(library.recorderError).toContain('late recording');
});

for (const action of ['stop', 'cancel'] as const) {
	test(`a delayed failed initial row save reports the recording after ${action} truthfully`, async () => {
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
				async set(id, from, change) {
					if (from === null) {
						reached.resolve();
						await release.promise;
					}
					return recordings.set(id, from, change);
				},
			},
		});
		const library = await openTestLibrary(test);
		cleanups.push(async () => {
			await closeTestLibrary(library);
			await test.remove();
		});
		const starting = library.startRecording();
		await reached.promise;
		const ending =
			action === 'stop' ? library.stopRecording() : library.cancelRecording();
		try {
			// Finish audio first while the initial row write is still held.
			await eventually(() => library.recorder.phase === 'idle');
		} finally {
			release.resolve();
			await Promise.all([starting, ending]);
		}
		expect(library.recorder.phase).toBe('idle');
		if (action === 'cancel') {
			expect(library.recorderError).toBeUndefined();
		} else {
			expect(
				(await readdir(join(test.root, 'recordings'))).filter((path) =>
					path.endsWith('.wav'),
				),
			).toHaveLength(1);
			expect(library.recorderError).toContain('audio is saved');
			expect(library.recorderError).toContain(
				'recording file could not be written',
			);
			expect(library.recorderError).not.toContain('recording is running');
		}
	});
}

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
			cancel: async () => Ok(undefined),
			stop: async (path) => {
				audioPath = path;
				expectOk(await test.folder.files.write(path, null, toneWav()));
				return Ok({ path, durationMs: 1000 });
			},
		});
		test = opened.test;
		await opened.library.startRecording();
		opened.end(reason);
		await eventually(() => opened.library.recorder.phase === 'idle');
		await closeTestLibrary(opened.library);
		expect(opened.stops()).toBe(1);
		const [name] = (await readdir(join(test.root, 'recordings'))).filter((name) => name.endsWith('.md'));
		const saved = await readFile(join(test.root, 'recordings', name!), 'utf8');
		expect(saved).toContain('durationMs: 1000');
		expect(new Uint8Array(await readFile(join(test.root, audioPath)))).toEqual(
			new Uint8Array(toneWav()),
		);
		expect(opened.library.recorderError).toContain('Recording stopped');
	});
}

test('an interruption already reported at startup finishes the capture once', async () => {
	const { library, stops } = await open({
		cancel: async () => Ok(undefined),
		earlyEnding: 'permissionRevoked',
	});
	await library.startRecording();
	await eventually(() => library.recorder.phase === 'idle');
	expect(stops()).toBe(1);
	expect(library.recorderError).toContain('permission');
});

test('closing waits for an interrupted capture and does not stop it twice', async () => {
	const release = Promise.withResolvers<void>();
	const { library, test, end, stops } = await open({
		cancel: async () => Ok(undefined),
		stop: async () => {
			await release.promise;
			return Ok({ path: 'audio/interrupted.wav', durationMs: 1000 });
		},
	});
	await library.startRecording();
	end('deviceDisconnected');
	end('streamFailed');
	expect(library.recorder.phase).toBe('stopping');
	expect(stops()).toBe(1);
	let closed = false;
	const closing = closeTestLibrary(library).then(() => {
		closed = true;
	});
	try {
		await new Promise((r) => setTimeout(r, 20));
		expect(closed).toBe(false);
		expect(stops()).toBe(1);
	} finally {
		release.resolve();
		await closing;
	}
	expect(test.closes).toBe(1);
});

test.each(['refused', 'thrown'] as const)(
	'an interrupted capture whose final save is %s keeps its row and reports the failure',
	async (failure) => {
		const { library, test, end } = await open({
			cancel: async () => Ok(undefined),
			stop: async () => {
				if (failure === 'thrown') throw new Error('disk is full');
				return RecorderError.Refused({ reason: 'disk is full' });
			},
		});
		await library.startRecording();
		end('storageFailed');
		await eventually(() => library.recorder.phase === 'idle');
		expect(expectOk(await test.folder.tables.recordings.list())).toHaveLength(
			1,
		);
		expect(library.recorderError).toContain('disk is full');
		expect(library.recorderError).not.toContain('audio was saved');
	},
);
