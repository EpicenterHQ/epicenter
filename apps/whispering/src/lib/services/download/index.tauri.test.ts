/**
 * Native download filename tests.
 * Exercises the installed Tauri dialog/filesystem adapters through mock IPC:
 * complete names and exact bytes survive saving, archives retain .zip, and
 * cancelling the dialog writes nothing.
 */
import { expect, test } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { DownloadServiceLive } from './index.tauri.js';

function setup() {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Reflect.set(globalThis, 'window', {});
	return {
		[Symbol.dispose]() {
			clearMocks();
			if (previous) Object.defineProperty(globalThis, 'window', previous);
			else Reflect.deleteProperty(globalThis, 'window');
		},
	};
}

for (const [name, type] of [
	['recording.webm', 'audio/webm'],
	['recordings.zip', 'application/zip'],
] as const) {
	test(`native download supplies ${name} and its suffix without changing the bytes`, async () => {
		using _context = setup();
		const calls: Array<{ command: string; args: unknown }> = [];
		mockIPC((command, args) => {
			calls.push({ command, args });
			if (command === 'plugin:dialog|save') return `/chosen/${name}`;
			if (command === 'plugin:fs|write_file') return;
			throw new Error(`Unexpected native call ${command}`);
		});
		expectOk(
			await DownloadServiceLive.downloadBlob({
				name,
				blob: new Blob([new Uint8Array([0, 1, 255])], { type }),
			}),
		);
		expect(calls[0]).toMatchObject({
			command: 'plugin:dialog|save',
			args: {
				options: {
					defaultPath: name,
					filters: [{ name, extensions: [name.split('.').at(-1)] }],
				},
			},
		});
		expect(calls[1]).toEqual({
			command: 'plugin:fs|write_file',
			args: new Uint8Array([0, 1, 255]),
		});
	});
}

test('cancelled native save writes no bytes', async () => {
	using _context = setup();
	const commands: string[] = [];
	mockIPC((command) => {
		commands.push(command);
		return null;
	});
	expect(
		expectErr(
			await DownloadServiceLive.downloadBlob({
				name: 'recording.wav',
				blob: new Blob(),
			}),
		).name,
	).toBe('SaveCancelled');
	expect(commands).toEqual(['plugin:dialog|save']);
});
