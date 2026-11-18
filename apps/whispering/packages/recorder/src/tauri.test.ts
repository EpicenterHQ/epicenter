/**
 * The desktop recorder against a stand-in for the shell's commands.
 *
 * Key behaviors:
 * - `start` names the folder, the recording's id, and the chosen microphone
 *   by the ID the shell listed it under, and passes the channel an ending
 *   arrives on
 * - `listInputs` answers the shell's inputs, each by the ID to ask for it
 *   by and its name; `openMeter` opens one by ID, hears its levels, and
 *   closes it, and a meter withdrawn while opening is closed
 * - `stop` asks the shell to stop this window's recording, answers its id
 *   and length, and stops hearing the channel
 * - The shell's refusals arrive as this package's errors, by name
 * - A start withdrawn while the shell opened the microphone is stopped:
 *   released, with what the shell wrote kept
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

/** The folder the page names, which the shell writes into itself. */
const folder =
	'/Users/someone/Library/Application Support/so.epicenter.whispering/data';
const files: Parameters<typeof recorder.start>[0]['files'] = {
	location: folder,
	write: async () => {
		throw new Error('the shell writes the folder itself');
	},
};

beforeEach(() => {
	calls = [];
	answer = ({ cmd }) =>
		cmd === 'plugin:epicenter-recorder|stop'
			? { id: 'a', durationMs: 1250 }
			: null;
});

test('a recording starts by its id in the folder, and stop answers its id and length', async () => {
	const recording = expectOk(
		await recorder.start({
			files,
			id: 'a',
			input: { deviceId: 'coreaudio:desk-uid', label: 'Desk Microphone' },
		}),
	);
	const [start] = calls;
	expect(start?.cmd).toBe('plugin:epicenter-recorder|start');
	expect(start?.args).toMatchObject({
		dir: folder,
		id: 'a',
		device: 'coreaudio:desk-uid',
	});
	expect(start?.args).not.toHaveProperty('scope');

	const channel = start?.args.signals as FakeChannel<unknown>;
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	channel.onmessage({ kind: 'ended', reason: 'deviceDisconnected' });
	expect(endings).toEqual(['deviceDisconnected']);

	expect(expectOk(await recording.stop())).toEqual({
		id: 'a',
		durationMs: 1250,
	});
	const stop = calls.at(-1) as Call;
	expect(stop).toEqual({ cmd: 'plugin:epicenter-recorder|stop', args: {} });
	recording.onEnded((reason) => endings.push(reason));
	expect(endings).toEqual(['deviceDisconnected']);
});

test('a command that throws instead of answering is a failure, not a refusal', async () => {
	const recording = expectOk(
		await recorder.start({ files, id: 'a' }),
	);
	const lost = new Error('the shell is gone');
	answer = () => {
		throw lost;
	};
	const failed = { name: 'Failed', cause: lost };
	expect(expectErr(await recording.stop())).toMatchObject(failed);
	expect(
		expectErr(await recorder.start({ files, id: 'b' })),
	).toMatchObject(failed);
	expect(expectErr(await recorder.openMeter())).toMatchObject(failed);
	expect(expectErr(await recorder.listInputs())).toMatchObject(failed);
});

test('the system default is asked for by naming no microphone', async () => {
	expectOk(await recorder.start({ files, id: 'a' }));
	expect(calls[0]?.args.device).toBeNull();
});

test('a stop the shell refuses arrives by name', async () => {
	for (const [name, expected] of [
		['NotRecording', { name: 'NotRecording', reason: 'held' }],
		['Failed', { name: 'Failed', cause: 'held' }],
	] as const) {
		const recording = expectOk(await recorder.start({ files, id: 'a' }));
		answer = () => {
			throw { name, message: 'held' };
		};
		expect(expectErr(await recording.stop())).toMatchObject(expected);
		answer = () => null;
	}
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
				files,
				id: 'a',
				input: { deviceId: 'x', label: 'USB Mic' },
			}),
		);
		expect(refused).toMatchObject(expected);
	}
});

test('a start withdrawn while the shell opened the microphone is finalized, never deleted', async () => {
	const controller = new AbortController();
	answer = ({ cmd }) => {
		if (cmd === 'plugin:epicenter-recorder|start') controller.abort();
		return null;
	};
	expect(
		expectErr(
			await recorder.start({
				files,
				id: 'a',
				signal: controller.signal,
			}),
		).name,
	).toBe('Cancelled');
	expect(calls.map(({ cmd }) => cmd)).toEqual([
		'plugin:epicenter-recorder|start',
		'plugin:epicenter-recorder|stop',
	]);
});

test('a folder with no path here is refused before the shell is asked', async () => {
	const nowhere = { ...files, location: null };
	expect(
		expectErr(await recorder.start({ files: nowhere, id: 'a' })).name,
	).toBe('Refused');
	expect(calls).toEqual([]);
});

test('a reply that is none of the shell’s refusals is a failure, not an answer', async () => {
	answer = () => {
		throw 'no such command plugin:epicenter-recorder|inputs';
	};
	expect(expectErr(await recorder.listInputs())).toMatchObject({
		name: 'Failed',
		cause: 'no such command plugin:epicenter-recorder|inputs',
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
			return null;
		}
		return { id: 'a', durationMs: 1250 };
	};
	const recording = expectOk(
		await recorder.start({ files, id: 'a' }),
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
		await recorder.start({ files, id: 'a' }),
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
