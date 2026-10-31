/**
 * The desktop recorder against a stand-in for the shell's commands.
 *
 * Key behaviors:
 * - `start` names the path and the chosen microphone by the ID the shell
 *   listed it under, the window's folder (`null`) or the root the page
 *   names, and passes the channel levels and endings arrive on
 * - `listInputs` answers the shell's inputs; `openMeter` opens one by ID,
 *   hears its levels, and closes it, and a meter withdrawn while opening is
 *   closed
 * - `stop` names the recording the shell minted, and stops hearing the
 *   channel
 * - The shell's refusals arrive as this package's errors, by name
 * - A start withdrawn while the shell opened the microphone is stopped:
 *   released, with what the shell wrote kept
 * - `recover` names the directory, in the window's folder or the root named
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

const { listInputs, openMeter, startRecording, recoverRecordings } =
	await import('./tauri.js');

const started = {
	id: '7',
	path: 'recordings/a.wav',
	device: 'Desk Microphone',
};

beforeEach(() => {
	calls = [];
	answer = ({ cmd }) =>
		cmd === 'plugin:epicenter-recorder|start'
			? started
			: cmd === 'plugin:epicenter-recorder|stop'
				? { path: 'recordings/a.wav', durationMs: 1250 }
				: null;
});

test('a recording starts in the window folder and stops by the id the shell minted', async () => {
	const recording = expectOk(
		await startRecording({
			path: 'recordings/a',
			input: { deviceId: 'coreaudio:desk-uid', label: 'Desk Microphone' },
		}),
	);
	expect(recording.path).toBe('recordings/a.wav');
	expect(recording.device).toBe('Desk Microphone');
	const [start] = calls;
	expect(start?.cmd).toBe('plugin:epicenter-recorder|start');
	expect(start?.args).toMatchObject({
		root: null,
		path: 'recordings/a',
		device: 'coreaudio:desk-uid',
	});
	expect(start?.args).not.toHaveProperty('scope');

	const channel = start?.args.signals as FakeChannel<unknown>;
	const levels: number[] = [];
	const endings: string[] = [];
	recording.onLevel((level) => levels.push(level));
	recording.onEnded((reason) => endings.push(reason));
	channel.onmessage({ kind: 'level', level: 0.25 });
	channel.onmessage({ kind: 'level', level: null });
	channel.onmessage({ kind: 'ended', reason: 'deviceDisconnected' });
	expect(levels).toEqual([0.25, 0]);
	expect(endings).toEqual(['deviceDisconnected']);

	expect(expectOk(await recording.stop())).toEqual({
		path: 'recordings/a.wav',
		durationMs: 1250,
	});
	expect(calls.at(-1)).toEqual({
		cmd: 'plugin:epicenter-recorder|stop',
		args: { id: '7' },
	});
	channel.onmessage({ kind: 'level', level: 0.9 });
	expect(levels).toEqual([0.25, 0]);
});

test('the system default is asked for by naming no microphone', async () => {
	expectOk(await startRecording({ path: 'recordings/a' }));
	expect(calls[0]?.args.device).toBeNull();
});

test('a stop the shell refuses arrives by name', async () => {
	const recording = expectOk(await startRecording({ path: 'recordings/a' }));
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
			await startRecording({
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
			await startRecording({
				path: 'recordings/a',
				signal: controller.signal,
			}),
		).name,
	).toBe('Cancelled');
	expect(calls.map(({ cmd }) => cmd)).toEqual([
		'plugin:epicenter-recorder|start',
		'plugin:epicenter-recorder|stop',
	]);
	expect(calls[1]?.args).toEqual({ id: '7' });
});

test('a recording in a root the page opened names that root', async () => {
	expectOk(
		await startRecording({
			root: '/Users/me/Epicenter/App',
			path: 'recordings/a',
		}),
	);
	expect(calls[0]?.args).toMatchObject({
		root: '/Users/me/Epicenter/App',
		path: 'recordings/a',
		device: null,
	});
});

test('recover names the directory in the window folder, and answers what it repaired', async () => {
	answer = () => ['recordings/a.wav'];
	expect(expectOk(await recoverRecordings({ under: 'recordings' }))).toEqual([
		'recordings/a.wav',
	]);
	expectOk(
		await recoverRecordings({
			root: '/Users/me/Epicenter/App',
			under: 'recordings',
		}),
	);
	expect(calls).toEqual([
		{
			cmd: 'plugin:epicenter-recorder|recover',
			args: { root: null, under: 'recordings' },
		},
		{
			cmd: 'plugin:epicenter-recorder|recover',
			args: { root: '/Users/me/Epicenter/App', under: 'recordings' },
		},
	]);
});

test('a reply that is none of the shell’s refusals is a failure, not an answer', async () => {
	answer = () => {
		throw 'no such command plugin:epicenter-recorder|recover';
	};
	expect(
		expectErr(await recoverRecordings({ under: 'recordings' })),
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
	expect(expectOk(await listInputs())).toEqual(inputs);
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
		await openMeter({
			input: { deviceId: 'coreaudio:desk-uid', label: 'Desk Microphone' },
		}),
	);
	expect(meter.device).toBe('Desk Microphone');
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
	expect(expectErr(await openMeter({ signal: controller.signal })).name).toBe(
		'Cancelled',
	);
	expect(calls.map(({ cmd }) => cmd)).toEqual([
		'plugin:epicenter-recorder|open_meter',
		'plugin:epicenter-recorder|close_meter',
	]);

	answer = () => {
		throw { name: 'InputUnavailable', message: 'gone' };
	};
	expect(
		expectErr(await openMeter({ input: { deviceId: 'x', label: 'USB Mic' } })),
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
		return { path: 'recordings/a.wav', durationMs: 1250 };
	};
	const recording = expectOk(await startRecording({ path: 'recordings/a' }));
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
	const recording = expectOk(await startRecording({ path: 'recordings/a' }));
	let stopping: ReturnType<typeof recording.stop> | undefined;
	const endings: string[] = [];
	recording.onEnded(() => {
		stopping = recording.stop();
	});
	recording.onEnded((reason) => endings.push(reason));
	(calls[0]?.args.signals as FakeChannel<unknown>).onmessage({
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
	const meter = expectOk(await openMeter());
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
