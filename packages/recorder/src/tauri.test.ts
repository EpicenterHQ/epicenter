/**
 * The desktop recorder against a stand-in for the shell's commands.
 *
 * Key behaviors:
 * - `start` names the path and the chosen microphone by the ID the shell
 *   listed it under, and passes the channel an ending arrives on
 * - `listInputs` answers the shell's inputs, each by the ID to ask for it
 *   by and its name; `openMeter` opens one by ID, hears its levels, and
 *   closes it, and a meter withdrawn while opening is closed
 * - `stop` names the recording the shell minted, answers where the shell
 *   placed it and its length, and stops hearing the channel
 * - The shell's refusals arrive as this package's errors, by name
 * - A start withdrawn while the shell opened the microphone is stopped:
 *   released, with what the shell wrote kept
 * - `recover` names the directory, in the device's root, and answers each
 *   recording placed with its length
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
let answer: (call: Call) => unknown = () => null;

class FakeChannel<T> {
	onmessage: (message: T) => void = () => {};
}

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	Channel: FakeChannel,
	async invoke(cmd: string, args: Record<string, unknown> = {}) {
		const call = { cmd, args };
		calls.push(call);
		return answer(call);
	},
}));

const { recorder } = await import('./tauri.js');

/** The data folder the page opened. */
const device = {} as Parameters<typeof recorder.start>[0]['device'];

/** The id the shell minted for the recording it started. */
const started = '7';

beforeEach(() => {
	calls = [];
	answer = ({ cmd }) =>
		cmd === 'plugin:epicenter-recorder|start'
			? started
			: cmd === 'plugin:epicenter-recorder|stop'
				? { path: 'recordings/a.webm', durationMs: 1250 }
				: null;
});

test('a recording starts in Data and stops by the id the shell minted', async () => {
	const recording = expectOk(
		await recorder.start({
			device,
			path: 'recordings/a',
			input: { deviceId: 'coreaudio:desk-uid', label: 'Desk Microphone' },
		}),
	);
	const [start] = calls;
	expect(start?.cmd).toBe('plugin:epicenter-recorder|start');
	expect(start?.args).toMatchObject({
		path: 'recordings/a',
		device: 'coreaudio:desk-uid',
	});
	expect(start?.args).not.toHaveProperty('scope');

	const channel = start?.args.signals as FakeChannel<unknown>;
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	channel.onmessage({ kind: 'ended', reason: 'deviceDisconnected' });
	expect(endings).toEqual(['deviceDisconnected']);

	expect(expectOk(await recording.stop())).toEqual({
		path: 'recordings/a.webm',
		durationMs: 1250,
	});
	const stop = calls.at(-1) as Call;
	expect(stop).toEqual({
		cmd: 'plugin:epicenter-recorder|stop',
		args: { id: '7' },
	});
	recording.onEnded((reason) => endings.push(reason));
	expect(endings).toEqual(['deviceDisconnected']);
});

test('a command that throws instead of answering is a failure, not a refusal', async () => {
	const recording = expectOk(
		await recorder.start({ device, path: 'recordings/a' }),
	);
	const lost = new Error('the shell is gone');
	answer = () => {
		throw lost;
	};
	const failed = { name: 'Failed', cause: lost };
	expect(expectErr(await recording.stop())).toMatchObject(failed);
	expect(
		expectErr(await recorder.start({ device, path: 'recordings/b' })),
	).toMatchObject(failed);
	expect(expectErr(await recorder.openMeter())).toMatchObject(failed);
	expect(expectErr(await recorder.listInputs())).toMatchObject(failed);
	expect(
		expectErr(
			await recorder.recover({ device, under: 'recordings', unnamed: [] }),
		),
	).toMatchObject(failed);
});

test('the system default is asked for by naming no microphone', async () => {
	expectOk(await recorder.start({ device, path: 'recordings/a' }));
	expect(calls[0]?.args.device).toBeNull();
});

test('a stop the shell refuses arrives by name', async () => {
	const recording = expectOk(
		await recorder.start({ device, path: 'recordings/a' }),
	);
	answer = () => {
		throw { name: 'NotRecording', message: 'already stopped' };
	};
	expect(expectErr(await recording.stop())).toMatchObject({
		name: 'NotRecording',
		reason: 'already stopped',
	});
});

test('the shell refusing a start is the matching error, with the chosen label', async () => {
	for (const [name, expected] of [
		['InputUnavailable', { name: 'InputUnavailable', label: 'USB Mic' }],
		['Busy', { name: 'Busy', reason: 'held' }],
		['Refused', { name: 'Refused', reason: 'held' }],
		['PermissionDenied', { name: 'PermissionDenied' }],
		['NoInputDevice', { name: 'NoInputDevice', reason: 'held' }],
		['Failed', { name: 'Failed', cause: 'held' }],
	] as const) {
		answer = () => {
			throw { name, message: 'held' };
		};
		const refused = expectErr(
			await recorder.start({
				device,
				path: 'recordings/a',
				input: { deviceId: 'x', label: 'USB Mic' },
			}),
		);
		expect(refused).toMatchObject(expected);
	}
});

test('a start withdrawn while the shell opened the microphone is finalized, never deleted', async () => {
	const controller = new AbortController();
	answer = ({ cmd }) => {
		if (cmd === 'plugin:epicenter-recorder|start') {
			controller.abort();
			return started;
		}
		return null;
	};
	expect(
		expectErr(
			await recorder.start({
				device,
				path: 'recordings/a',
				signal: controller.signal,
			}),
		).name,
	).toBe('Cancelled');
	expect(calls.map(({ cmd }) => cmd)).toEqual([
		'plugin:epicenter-recorder|start',
		'plugin:epicenter-recorder|stop',
	]);
	expect(calls[1]?.args.id).toBe('7');
});

test('recover names the directory in Data and answers what it repaired, then each unnamed recording, whole at its path', async () => {
	const recovery = {
		recovered: [
			{ path: 'recordings/a.webm', durationMs: 1250 },
			{ path: 'recordings/b.webm', durationMs: 3000 },
		],
		unplaced: [
			{
				path: 'recordings/c.webm',
				pending: '.epicenter/recordings/recordings/c.webm',
			},
		],
	};
	answer = () => recovery;
	expect(
		expectOk(
			await recorder.recover({
				device,
				under: 'recordings',
				unnamed: ['recordings/a.webm', 'recordings/left.webm'],
			}),
		),
	).toEqual({
		recovered: [
			...recovery.recovered,
			{ path: 'recordings/left.webm', durationMs: null },
		],
		unplaced: recovery.unplaced,
	});
	expect(calls).toEqual([
		{
			cmd: 'plugin:epicenter-recorder|recover',
			args: { under: 'recordings' },
		},
	]);
});

test('a reply that is none of the shell’s refusals is a failure, not an answer', async () => {
	answer = () => {
		throw 'no such command plugin:epicenter-recorder|recover';
	};
	expect(
		expectErr(
			await recorder.recover({ device, under: 'recordings', unnamed: [] }),
		),
	).toMatchObject({
		name: 'Failed',
		cause: 'no such command plugin:epicenter-recorder|recover',
	});
});

test('the inputs are the shell’s, each with the ID to ask for it by', async () => {
	const inputs = [
		{ id: 'coreaudio:desk-uid', name: 'Desk Microphone', isDefault: true },
	];
	answer = () => inputs;
	expect(expectOk(await recorder.listInputs())).toEqual({
		inputs: [{ deviceId: 'coreaudio:desk-uid', label: 'Desk Microphone' }],
	});
	expect(calls).toEqual([
		{ cmd: 'plugin:epicenter-recorder|inputs', args: {} },
	]);
});

test('a meter opens the chosen microphone by ID, hears its level, and closes', async () => {
	answer = ({ cmd }) =>
		cmd === 'plugin:epicenter-recorder|open_meter'
			? { id: '9', device: 'Desk Microphone' }
			: null;
	const meter = expectOk(
		await recorder.openMeter({
			input: { deviceId: 'coreaudio:desk-uid', label: 'Desk Microphone' },
		}),
	);
	expect(meter.microphone).toBe('Desk Microphone');
	const [open] = calls;
	expect(open?.args.device).toBe('coreaudio:desk-uid');
	const channel = open?.args.levels as FakeChannel<unknown>;
	const levels: number[] = [];
	meter.onLevel((level) => levels.push(level));
	channel.onmessage({ kind: 'level', level: 0.5 });
	await meter.close();
	channel.onmessage({ kind: 'level', level: 0.9 });
	expect(levels).toEqual([0.5]);
	expect(calls.at(-1)).toEqual({
		cmd: 'plugin:epicenter-recorder|close_meter',
		args: { id: '9' },
	});
});

test('a meter withdrawn while the shell opened it is closed, and a refusal arrives by name', async () => {
	const controller = new AbortController();
	answer = ({ cmd }) => {
		if (cmd !== 'plugin:epicenter-recorder|open_meter') return null;
		controller.abort();
		return { id: '9', device: 'Desk Microphone' };
	};
	expect(
		expectErr(await recorder.openMeter({ signal: controller.signal })).name,
	).toBe('Cancelled');
	expect(calls.map(({ cmd }) => cmd)).toEqual([
		'plugin:epicenter-recorder|open_meter',
		'plugin:epicenter-recorder|close_meter',
	]);

	answer = () => {
		throw { name: 'InputUnavailable', message: 'gone' };
	};
	expect(
		expectErr(
			await recorder.openMeter({ input: { deviceId: 'x', label: 'USB Mic' } }),
		),
	).toMatchObject({ name: 'InputUnavailable', label: 'USB Mic' });
});

test('an ending received before start answers reaches its subscriber once and retires on stop', async () => {
	answer = ({ cmd, args }) => {
		if (cmd === 'plugin:epicenter-recorder|start') {
			(args.signals as FakeChannel<unknown>).onmessage({
				kind: 'ended',
				reason: 'permissionRevoked',
			});
			return started;
		}
		return { durationMs: 1250 };
	};
	const recording = expectOk(
		await recorder.start({ device, path: 'recordings/a' }),
	);
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	const channel = calls[0]?.args.signals as FakeChannel<unknown>;
	channel.onmessage({ kind: 'ended', reason: 'streamFailed' });
	expect(endings).toEqual(['permissionRevoked']);
	expectOk(await recording.stop());
	channel.onmessage({ kind: 'ended', reason: 'deviceDisconnected' });
	const late: string[] = [];
	recording.onEnded((reason) => late.push(reason));
	expect(late).toEqual([]);
});

test('an ending reaches every listener when the first listener stops the native recorder', async () => {
	const recording = expectOk(
		await recorder.start({ device, path: 'recordings/a' }),
	);
	let stopping: ReturnType<typeof recording.stop> | undefined;
	const endings: string[] = [];
	recording.onEnded(() => {
		stopping = recording.stop();
	});
	recording.onEnded((reason) => endings.push(reason));
	((calls[0] as Call).args.signals as FakeChannel<unknown>).onmessage({
		kind: 'ended',
		reason: 'permissionRevoked',
	});
	expect(endings).toEqual(['permissionRevoked']);
	expect(stopping).toBeDefined();
	expectOk(await stopping!);
});

test('a meter ending before its open reply is delivered once and retired on close', async () => {
	answer = ({ cmd, args }) => {
		if (cmd === 'plugin:epicenter-recorder|open_meter') {
			(args.levels as FakeChannel<unknown>).onmessage({
				kind: 'ended',
				reason: 'permissionRevoked',
			});
			return { id: '9', device: 'Desk Microphone' };
		}
		return null;
	};
	const meter = expectOk(await recorder.openMeter());
	const heard: string[] = [];
	meter.onEnded((reason) => heard.push(reason));
	const channel = calls[0]?.args.levels as FakeChannel<unknown>;
	channel.onmessage({ kind: 'ended', reason: 'streamFailed' });
	expect(heard).toEqual(['permissionRevoked']);
	await meter.close();
	const late: string[] = [];
	meter.onEnded((reason) => late.push(reason));
	channel.onmessage({ kind: 'ended', reason: 'deviceDisconnected' });
	expect(late).toEqual([]);
});
