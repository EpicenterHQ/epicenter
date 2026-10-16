/**
 * Microphone input tests
 *
 * Drives the session's microphone choice and test, and the library's
 * recorder over them, with a scripted capture device that counts what is
 * open. The folder is a real directory; no microphone is involved.
 *
 * Key behaviors:
 * - Opening a session reads the saved choice and opens, lists, and asks for
 *   nothing
 * - A choice is saved on this device, never in the folder, and survives a
 *   new session
 * - A recording asks for exactly the chosen microphone; one that is not
 *   there refuses, records nothing, and keeps the choice
 * - A recording keeps its microphone: the choice cannot change, and no test
 *   or enabling opens another, until it ends
 * - Enabling and testing share one owner: at most one is under way, and
 *   releasing, choosing, recording, and closing each end it, including a
 *   microphone that opens after the release
 * - A recording that is closed or cancelled while its microphone is opening
 *   releases it when it opens
 * - Closing releases the microphone at once, before waiting for file commands
 *   that were accepted, which still finish
 * - Saves of the choice run one at a time in the order chosen, only the
 *   latest choice reports whether it was saved, and closing waits for a save
 *   it had accepted after releasing the microphone at once
 * - A saved choice whose ID is not listed stays the choice: an input with the
 *   same name is not taken for it, and a recording with it refuses
 * - Fixture mode has no input: nothing is listed, tested, or asked for
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type ActiveCapture,
	type CaptureDevice,
	CaptureError,
	type CaptureStart,
	type MicrophoneMeter,
	type MicrophonePreference,
	toneWav,
} from './capture.js';
import { createQueryClient } from './query.test-support.js';
import type { Workspace } from './workspace/types.js';
import { deferred, openTestWorkspace } from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');

const BUILT_IN = { deviceId: 'built-in-id', label: 'Built-in Microphone' };
const USB = { deviceId: 'usb-id', label: 'USB Microphone' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A microphone device that counts what it was asked for and what is still open. */
function scriptedMicrophone(
	connected: MicrophonePreference[] = [BUILT_IN, USB],
) {
	const calls = {
		allowSignals: [] as AbortSignal[],
		list: 0,
		allow: 0,
		meter: [] as (MicrophonePreference | undefined)[],
		start: [] as CaptureStart[],
	};
	const open = { meters: 0, captures: 0 };
	const changeListeners = new Set<() => void>();
	/** Whoever hears the open meter's microphone stop on its own. */
	const meterEndings = new Set<(error: CaptureError) => void>();
	/** Set to hold the next meter or start until the test lets it answer. */
	const gate: { next?: Promise<void> } = {};
	const state = { connected, named: true, denied: false };

	async function opening(
		input: MicrophonePreference | undefined,
		signal: AbortSignal | undefined,
	) {
		const held = gate.next;
		gate.next = undefined;
		await held;
		if (state.denied) return CaptureError.PermissionDenied();
		if (
			input !== undefined &&
			!state.connected.some((device) => device.deviceId === input.deviceId)
		)
			return CaptureError.InputUnavailable({ label: input.label });
		// As the real device does: a microphone that opens after the withdrawal is released, never handed over.
		if (signal?.aborted) return CaptureError.Cancelled();
		return Ok(undefined);
	}

	const device: CaptureDevice = {
		source: 'microphone',
		label: 'Microphone',
		inputs: {
			async list() {
				calls.list += 1;
				return Ok({
					devices: state.named ? state.connected : [],
					namesWithheld: !state.named && state.connected.length > 0,
				});
			},
			async allow(signal) {
				calls.allow += 1;
				if (signal !== undefined) calls.allowSignals.push(signal);
				// The default microphone opens and is released at once; a withdrawn request keeps nothing.
				const { error: openError } = await opening(undefined, signal);
				if (openError !== null) return Err(openError);
				state.named = true;
				return Ok(undefined);
			},
			async meter(
				input,
				signal,
			): Promise<Result<MicrophoneMeter, CaptureError>> {
				calls.meter.push(input);
				const { error: openError } = await opening(input, signal);
				if (openError !== null) return Err(openError);
				open.meters += 1;
				let stopped = false;
				return Ok({
					label: input?.label ?? 'System default',
					level: () => 0.5,
					onEnded(listener) {
						meterEndings.add(listener);
						return () => meterEndings.delete(listener);
					},
					stop() {
						if (!stopped) open.meters -= 1;
						stopped = true;
					},
				});
			},
			onChange(listener) {
				changeListeners.add(listener);
				return () => changeListeners.delete(listener);
			},
		},
		async start(options): Promise<Result<ActiveCapture, CaptureError>> {
			calls.start.push(options);
			const { error: openError } = await opening(options.input, options.signal);
			if (openError !== null) return Err(openError);
			open.captures += 1;
			let settled = false;
			const release = () => {
				if (!settled) open.captures -= 1;
				settled = true;
			};
			const audioPath = `${options.path}.wav`;
			return Ok({
				audioPath,
				startedAt: performance.now(),
				async stop() {
					release();
					const { error } = await options.folder.files.create(
						audioPath,
						toneWav(),
					);
					if (error !== null)
						return CaptureError.NotSaved({ reason: error.message });
					return Ok({ durationMs: 1000 });
				},
				async cancel() {
					release();
				},
			});
		},
	};
	return { device, calls, open, gate, state, changeListeners, meterEndings };
}

/**
 * A microphone shaped as Epicenter's: every input named, no `allow`, and
 * access asked for by the shell when a microphone opens.
 */
function shellMicrophone(connected: MicrophonePreference[] = [BUILT_IN, USB]) {
	const microphone = scriptedMicrophone(connected);
	const inputs = microphone.device.inputs;
	if (inputs === undefined) throw new Error('A microphone has inputs');
	microphone.device = {
		...microphone.device,
		inputs: {
			async list() {
				const { data, error } = await inputs.list();
				if (error !== null) return Err(error);
				return Ok({ devices: data.devices });
			},
			meter: inputs.meter,
			onChange: inputs.onChange,
			openSettings: async () => Ok(undefined),
		},
	};
	return microphone;
}

/** Preferences kept in memory, as one device would across sessions. */
function devicePreferences(saved?: MicrophonePreference) {
	const store = { saved, writes: 0 };
	const preferences: Workspace['preferences'] = {
		microphone: async () => store.saved,
		async setMicrophone(microphone) {
			store.saved = microphone;
			store.writes += 1;
			return undefined;
		},
	};
	return { store, preferences };
}

async function open({
	microphone = scriptedMicrophone(),
	device = devicePreferences(),
}: {
	microphone?: ReturnType<typeof scriptedMicrophone>;
	device?: ReturnType<typeof devicePreferences>;
} = {}) {
	const test = await openTestWorkspace();
	const library = createLibrary(
		{
			...test.workspace,
			capture: microphone.device,
			preferences: device.preferences,
		},
		createQueryClient(),
	);
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	return { library, input: library.input, microphone, device, root: test.root };
}

test('opening a session reads the saved choice and opens, lists, and asks for nothing', async () => {
	const { input, microphone } = await open({ device: devicePreferences(USB) });

	expect(input.choice).toEqual(USB);
	expect(input.list).toEqual({ kind: 'unread' });
	expect(microphone.calls).toEqual({
		allowSignals: [],
		list: 0,
		allow: 0,
		meter: [],
		start: [],
	});
	expect(microphone.changeListeners.size).toBe(0);
});

test('a choice is saved on this device, not in the folder, and a new session starts with it', async () => {
	const device = devicePreferences();
	const first = await open({ device });
	// Start with folder settings an earlier build saved, so the device choice can be checked against them.
	await writeFile(
		join(first.root, 'kv.json'),
		'{"transcriptionModel": "verification-model"}\n',
	);
	await first.input.refresh();

	await first.input.select(USB);

	expect(device.store.saved).toEqual(USB);
	expect(await readFile(join(first.root, 'kv.json'), 'utf8')).not.toContain(
		'usb-id',
	);
	const second = await open({ device });
	expect(second.input.choice).toEqual(USB);

	await second.input.select(undefined);
	expect(device.store.saved).toBeUndefined();
});

test('a recording asks for exactly the chosen microphone, and for the default when none is chosen', async () => {
	const { library, input, microphone } = await open();

	await library.startRecording();
	library.cancelRecording();
	await input.select(USB);
	await library.startRecording();

	expect(microphone.calls.start.map((start) => start.input)).toEqual([
		undefined,
		USB,
	]);
	expect(library.recorder.phase).toBe('recording');
});

test('a chosen microphone that is not connected refuses the recording, records nothing, and stays chosen', async () => {
	const { library, input, microphone, device } = await open({
		microphone: scriptedMicrophone([BUILT_IN]),
		device: devicePreferences(USB),
	});

	await library.startRecording();

	expect(library.recorder).toEqual({ phase: 'idle' });
	expect(library.recorderError).toContain('“USB Microphone” is not available');
	expect(microphone.calls.start).toHaveLength(1);
	expect(microphone.open.captures).toBe(0);
	expect(input.choice).toEqual(USB);
	expect(device.store.saved).toEqual(USB);
	expect(library.entries).toEqual([]);

	await input.refresh();
	expect(input.choiceListed).toBe(false);
});

test('while a recording is starting, running, or finishing, the choice cannot change and nothing else opens a microphone', async () => {
	const { library, input, microphone, device } = await open();
	await input.refresh();
	const held = deferred<void>();
	microphone.gate.next = held.promise;

	const starting = library.startRecording();
	expect(library.recorder.phase).toBe('starting');
	await input.select(USB);
	await input.startTest();
	held.resolve();
	await starting;
	await input.select(USB);
	await input.startTest();
	await input.allow();

	expect(input.choice).toBeUndefined();
	expect(device.store.writes).toBe(0);
	expect(microphone.calls.meter).toEqual([]);
	expect(microphone.calls.allow).toBe(0);
	expect(microphone.open).toEqual({ meters: 0, captures: 1 });
	expect(input.problem).toContain('A recording is using the microphone');

	// The recording that started on the default microphone is the one that is saved.
	await library.stopRecording();
	expect(microphone.open.captures).toBe(0);
	await input.select(USB);
	expect(input.choice).toEqual(USB);
});

test('a second test does not open a second microphone, and stopping releases the one that is open', async () => {
	const { input, microphone } = await open();

	await Promise.all([input.startTest(), input.startTest()]);
	await input.startTest();

	expect(input.test).toEqual({ phase: 'running', label: 'System default' });
	expect(microphone.calls.meter).toHaveLength(1);
	expect(microphone.open.meters).toBe(1);

	input.release();

	expect(input.test).toEqual({ phase: 'idle' });
	expect(input.level).toBe(0);
	expect(microphone.open.meters).toBe(0);
});

test('a test stopped while its microphone is opening releases it when it opens', async () => {
	const { input, microphone } = await open();
	const held = deferred<void>();
	microphone.gate.next = held.promise;

	const starting = input.startTest();
	expect(input.test).toEqual({ phase: 'opening' });
	input.release();
	// A new test started before the first answered is the only one that runs.
	const again = input.startTest();
	held.resolve();
	await Promise.all([starting, again]);

	expect(microphone.calls.meter).toHaveLength(2);
	expect(microphone.open.meters).toBe(1);
	expect(input.test.phase).toBe('running');
	expect(input.problem).toBeUndefined();
});

test('starting a recording ends a running test before the recording opens its microphone', async () => {
	const { library, input, microphone } = await open();
	await input.startTest();
	const held = deferred<void>();
	microphone.gate.next = held.promise;

	const starting = library.startRecording();
	// The recording has asked for its microphone and the test's is already released.
	expect(microphone.open).toEqual({ meters: 0, captures: 0 });
	expect(input.test).toEqual({ phase: 'idle' });
	held.resolve();
	await starting;

	expect(microphone.open).toEqual({ meters: 0, captures: 1 });
});

test('a test that is still opening when a recording starts never holds a microphone beside it', async () => {
	const { library, input, microphone } = await open();
	const heldTest = deferred<void>();
	microphone.gate.next = heldTest.promise;
	const testing = input.startTest();

	await library.startRecording();
	heldTest.resolve();
	await testing;

	expect(microphone.open).toEqual({ meters: 0, captures: 1 });
	expect(input.test).toEqual({ phase: 'idle' });
});

test('choosing another input and closing the session each release a running test', async () => {
	const { library, input, microphone } = await open();
	await input.refresh();
	await input.startTest();

	await input.select(USB);
	expect(microphone.open.meters).toBe(0);
	expect(input.test).toEqual({ phase: 'idle' });

	await input.startTest();
	expect(microphone.calls.meter).toEqual([undefined, USB]);
	await library.close();

	expect(microphone.open.meters).toBe(0);
	expect(microphone.changeListeners.size).toBe(0);
	// Nothing opens after the session closed.
	await input.startTest();
	await input.allow();
	await input.refresh();
	expect(microphone.calls.meter).toHaveLength(2);
	expect(microphone.calls.allow).toBe(0);
});

test('a recording closed or cancelled while its microphone is opening releases it when it opens', async () => {
	for (const end of ['cancel', 'close'] as const) {
		const { library, microphone } = await open();
		const held = deferred<void>();
		microphone.gate.next = held.promise;

		const starting = library.startRecording();
		if (end === 'cancel') library.cancelRecording();
		const closing = end === 'close' ? library.close() : undefined;
		held.resolve();
		await starting;
		await closing;

		expect(microphone.calls.start).toHaveLength(1);
		expect(microphone.calls.start[0]!.signal?.aborted).toBe(true);
		expect(microphone.open.captures).toBe(0);
		if (end === 'cancel') expect(library.recorder).toEqual({ phase: 'idle' });
	}
});

test('refused access is reported, and enabling lists inputs by name once it is allowed', async () => {
	const microphone = scriptedMicrophone();
	microphone.state.named = false;
	microphone.state.denied = true;
	const { input } = await open({ microphone });

	await input.refresh();
	expect(input.list).toEqual({
		kind: 'listed',
		devices: [],
		namesWithheld: true,
	});
	await input.allow();
	expect(input.denied).toBe(true);
	expect(input.problem).toContain('Microphone access was denied');
	await input.startTest();
	expect(input.test).toEqual({ phase: 'idle' });
	expect(microphone.open.meters).toBe(0);

	microphone.state.denied = false;
	await input.allow();

	expect(input.denied).toBe(false);
	expect(input.problem).toBeUndefined();
	expect(input.list).toEqual({
		kind: 'listed',
		devices: [BUILT_IN, USB],
		namesWithheld: false,
	});
});

test('a connected or removed input is listed again without asking for access', async () => {
	const { input, microphone } = await open({ device: devicePreferences(USB) });
	await input.refresh();
	expect(input.choiceListed).toBe(true);

	microphone.state.connected = [BUILT_IN];
	for (const listener of microphone.changeListeners) listener();
	await Promise.resolve();
	await Promise.resolve();

	expect(input.list).toEqual({
		kind: 'listed',
		devices: [BUILT_IN],
		namesWithheld: false,
	});
	expect(input.choiceListed).toBe(false);
	expect(input.choice).toEqual(USB);
	expect(microphone.calls.allow).toBe(0);
});

test('a saved choice whose ID is not listed stays as it is: an input with the same name is not taken for it', async () => {
	// Another microphone of the same model, or the same one under a new ID: the name cannot say which.
	const sameName = { deviceId: 'usb-id-other', label: 'USB Microphone' };
	const device = devicePreferences(USB);
	const { library, input, microphone } = await open({
		microphone: scriptedMicrophone([BUILT_IN, sameName]),
		device,
	});

	await input.refresh();

	expect(input.choice).toEqual(USB);
	expect(input.choiceListed).toBe(false);
	expect(device.store).toEqual({ saved: USB, writes: 0 });
	await library.startRecording();
	expect(microphone.calls.start.map((start) => start.input)).toEqual([USB]);
	expect(microphone.open.captures).toBe(0);
	expect(library.recorder).toEqual({ phase: 'idle' });
	expect(library.recorderError).toContain('is not available');

	// Only the person's own choice of a listed input changes it.
	await input.select(sameName);
	expect(device.store.saved).toEqual(sameName);
	await library.startRecording();
	expect(microphone.calls.start[1]?.input).toEqual(sameName);
	expect(library.recorder.phase).toBe('recording');
});

// ============================================================================
// One owner for enabling and testing
// ============================================================================

test('a pending enable is not repeated, opens no test beside it, and releasing it keeps nothing and reports nothing', async () => {
	const microphone = scriptedMicrophone();
	microphone.state.named = false;
	const { input } = await open({ microphone });
	await input.refresh();
	const held = deferred<void>();
	microphone.gate.next = held.promise;

	const enabling = input.allow();
	expect(input.allowing).toBe(true);
	await input.allow();
	await input.startTest();
	expect(microphone.calls.allow).toBe(1);
	expect(microphone.calls.meter).toEqual([]);
	expect(input.test).toEqual({ phase: 'idle' });

	// What closing the popover or leaving the page does.
	input.release();
	expect(input.allowing).toBe(false);
	expect(microphone.calls.allowSignals[0]?.aborted).toBe(true);
	held.resolve();
	await enabling;

	expect(microphone.open).toEqual({ meters: 0, captures: 0 });
	expect(input.problem).toBeUndefined();
	// The withdrawn enable listed nothing again and allowed nothing.
	expect(microphone.calls.list).toBe(1);
	expect(input.list).toEqual({
		kind: 'listed',
		devices: [],
		namesWithheld: true,
	});
});

test('enabling does not open a microphone beside a test that is opening or running', async () => {
	const { input, microphone } = await open();
	const held = deferred<void>();
	microphone.gate.next = held.promise;

	const testing = input.startTest();
	await input.allow();
	held.resolve();
	await testing;
	await input.allow();

	expect(microphone.calls.allow).toBe(0);
	expect(microphone.open.meters).toBe(1);
	expect(input.test.phase).toBe('running');
});

test('starting a recording withdraws a pending enable before the recording opens its microphone', async () => {
	const { library, input, microphone } = await open();
	const held = deferred<void>();
	microphone.gate.next = held.promise;
	const enabling = input.allow();

	await library.startRecording();

	expect(microphone.calls.allowSignals[0]?.aborted).toBe(true);
	expect(input.allowing).toBe(false);
	held.resolve();
	await enabling;
	expect(microphone.open).toEqual({ meters: 0, captures: 1 });
	expect(library.recorder.phase).toBe('recording');
	expect(microphone.calls.list).toBe(0);
});

test('closing the session withdraws a pending enable at once', async () => {
	const { library, input, microphone } = await open();
	const held = deferred<void>();
	microphone.gate.next = held.promise;
	const enabling = input.allow();

	const closing = library.close();

	expect(microphone.calls.allowSignals[0]?.aborted).toBe(true);
	expect(input.allowing).toBe(false);
	held.resolve();
	await Promise.all([enabling, closing]);
	expect(microphone.open).toEqual({ meters: 0, captures: 0 });
	expect(microphone.calls.list).toBe(0);
});

test('closing releases the microphone at once, while a file command that was accepted is still being written', async () => {
	for (const holding of ['test', 'recording'] as const) {
		const microphone = scriptedMicrophone();
		const test = await openTestWorkspace();
		const writing = deferred<void>();
		const files = test.workspace.folder.files;
		const library = createLibrary(
			{
				...test.workspace,
				capture: microphone.device,
				folder: {
					...test.workspace.folder,
					files: {
						...files,
						async create(path, content) {
							await writing.promise;
							return files.create(path, content);
						},
					},
				} as Workspace['folder'],
			},
			createQueryClient(),
		);
		cleanups.push(async () => {
			await library.close();
			await test.remove();
		});
		await library.start();
		if (holding === 'test') await library.input.startTest();
		else await library.startRecording();
		expect(microphone.open).toEqual(
			holding === 'test'
				? { meters: 1, captures: 0 }
				: { meters: 0, captures: 1 },
		);
		const created = library.createFile('', 'note.txt');

		let closed = false;
		const closing = library.close().then(() => {
			closed = true;
		});

		// Nothing waits for the write: the microphone is released now.
		expect(microphone.open).toEqual({ meters: 0, captures: 0 });
		expect(library.input.test).toEqual({ phase: 'idle' });
		await Promise.resolve();
		expect(closed).toBe(false);

		// The accepted write still finishes before the folder is released.
		writing.resolve();
		expect(await created).toBeUndefined();
		await closing;
		expect(await readFile(join(test.root, 'note.txt'), 'utf8')).toBe('');
	}
});

// ============================================================================
// Saving the choice
// ============================================================================

/** Preferences whose every save waits for the test to answer it. */
function heldPreferences() {
	const saves: {
		microphone: MicrophonePreference | undefined;
		answer: (problem?: string) => void;
	}[] = [];
	const preferences: Workspace['preferences'] = {
		microphone: async () => undefined,
		setMicrophone: (microphone) =>
			new Promise((answer) => saves.push({ microphone, answer })),
	};
	return { saves, preferences };
}

test('choices are saved one at a time in the order chosen, and an older save that fails does not speak for the newer choice', async () => {
	const held = heldPreferences();
	const { input } = await open({
		device: {
			store: { saved: undefined, writes: 0 },
			preferences: held.preferences,
		},
	});

	const older = input.select(USB);
	const newer = input.select(BUILT_IN);
	await Promise.resolve();

	// The choice applies at once; the second save waits for the first to answer.
	expect(input.choice).toEqual(BUILT_IN);
	expect(held.saves.map((save) => save.microphone)).toEqual([USB]);

	held.saves[0]?.answer('Older choice failed');
	await older;
	expect(held.saves.map((save) => save.microphone)).toEqual([USB, BUILT_IN]);
	expect(input.preferenceProblem).toBeUndefined();

	held.saves[1]?.answer();
	await newer;
	expect(input.choice).toEqual(BUILT_IN);
	expect(input.preferenceProblem).toBeUndefined();

	// The latest choice does report its own failure, and a later one clears it.
	const failing = input.select(USB);
	await Promise.resolve();
	held.saves[2]?.answer('This choice failed');
	await failing;
	expect(input.preferenceProblem).toBe('This choice failed');
	const next = input.select(undefined);
	expect(input.preferenceProblem).toBeUndefined();
	await Promise.resolve();
	held.saves[3]?.answer();
	await next;
	expect(held.saves.map((save) => save.microphone)).toEqual([
		USB,
		BUILT_IN,
		USB,
		undefined,
	]);
});

test('closing while a choice is being saved releases the microphone at once and closes the workspace only after the save', async () => {
	const held = heldPreferences();
	const microphone = scriptedMicrophone();
	const test = await openTestWorkspace();
	const order: string[] = [];
	const library = createLibrary(
		{
			...test.workspace,
			capture: microphone.device,
			preferences: held.preferences,
			async close() {
				order.push('workspace closed');
				await test.workspace.close();
			},
		},
		createQueryClient(),
	);
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	const input = library.input;
	const first = input.select(USB);
	const second = input.select(BUILT_IN);
	await input.startTest();
	expect(microphone.open.meters).toBe(1);

	const closing = library.close();

	expect(microphone.open.meters).toBe(0);
	// A choice made after closing is not accepted.
	await input.select(undefined);
	expect(input.choice).toEqual(BUILT_IN);
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
	expect(order).toEqual([]);

	order.push('first save answered');
	held.saves[0]?.answer();
	await first;
	expect(order).toEqual(['first save answered']);
	order.push('latest save answered');
	held.saves[1]?.answer();
	await Promise.all([second, closing]);

	expect(order).toEqual([
		'first save answered',
		'latest save answered',
		'workspace closed',
	]);
	expect(held.saves.map((save) => save.microphone)).toEqual([USB, BUILT_IN]);
});

test('fixture mode has no input: nothing is listed, tested, enabled, or chosen', async () => {
	const test = await openTestWorkspace();
	const device = devicePreferences(USB);
	const library = createLibrary(
		{
			...test.workspace,
			preferences: device.preferences,
		},
		createQueryClient(),
	);
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	const input = library.input;

	await input.refresh();
	await input.allow();
	await input.startTest();
	await input.select(BUILT_IN);

	expect(input.available).toBe(false);
	expect(input.choice).toBeUndefined();
	expect(input.list).toEqual({ kind: 'unread' });
	expect(input.test).toEqual({ phase: 'idle' });
	expect(device.store.writes).toBe(0);
	// The fixture still records, and is saved as a fixture take.
	await library.startRecording();
	await library.stopRecording();
	expect(library.entries).toHaveLength(1);
});

test('an unreadable saved microphone reports the failure without opening a device or saving a default', async () => {
	const device = devicePreferences(USB);
	device.preferences.microphone = async () => {
		throw new Error('Storage access refused');
	};
	const { input, microphone } = await open({ device });
	expect(input.preferenceProblem).toBe(
		'The saved microphone could not be read: Storage access refused',
	);
	expect(input.choice).toBeUndefined();
	expect(device.store.saved).toEqual(USB);
	expect(device.store.writes).toBe(0);
	expect(microphone.calls).toEqual({
		allowSignals: [],
		list: 0,
		allow: 0,
		meter: [],
		start: [],
	});
});

test('a test whose microphone stops on its own ends and says why', async () => {
	const { input, microphone } = await open();
	await input.startTest();
	expect(input.test.phase).toBe('running');

	for (const listener of microphone.meterEndings)
		listener(CaptureError.InputUnavailable({ label: 'USB Microphone' }).error);

	expect(input.test).toEqual({ phase: 'idle' });
	expect(input.problem).toContain('“USB Microphone” is not available');
	expect(microphone.open.meters).toBe(0);
});

test('in Epicenter there is no enabling, listing never clears a denial, and settings can be opened', async () => {
	const microphone = shellMicrophone();
	microphone.state.denied = true;
	const { input } = await open({ microphone });

	expect(input.canAllow).toBe(false);
	expect(input.canOpenSettings).toBe(true);
	await input.startTest();
	expect(input.denied).toBe(true);
	await input.refresh();
	expect(input.list).toEqual({ kind: 'listed', devices: [BUILT_IN, USB] });
	expect(input.denied).toBe(true);

	microphone.state.denied = false;
	await input.startTest();
	expect(input.denied).toBe(false);
});
