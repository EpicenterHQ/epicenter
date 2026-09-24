/**
 * Native imported files retain their source evidence.
 * Tests that the actual Tauri path and filesystem adapters preserve basename
 * and bytes without adding a second MIME interpretation before app import.
 */
import { expect, test } from 'bun:test';
import { blobInputContentType, selectBlobFormat } from '@epicenter/blobs';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { expectOk } from 'wellcrafted/testing';
import { tauriOnly } from './tauri.tauri.js';

test('native import preserves basename and bytes for the shared format policy', async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Reflect.set(globalThis, 'window', {});
	try {
		mockIPC((command) => {
			if (command === 'plugin:fs|read_file')
				return new Uint8Array([82, 73, 70, 70]).buffer;
			if (command === 'plugin:path|basename') return 'Meeting.WAV';
			throw new Error(`Unexpected native call ${command}`);
		});
		const [file] = expectOk(
			await tauriOnly.fs.pathsToFiles(['/chosen/Meeting.WAV']),
		);
		expect(file!.name).toBe('Meeting.WAV');
		expect(file!.type).toBe('');
		expect(new Uint8Array(await file!.arrayBuffer())).toEqual(
			new Uint8Array([82, 73, 70, 70]),
		);
		expect(selectBlobFormat(file!)).toEqual({
			extension: 'wav',
			contentType: 'audio/wav',
		});
		expect(blobInputContentType(file!)).toBe('audio/wav');
	} finally {
		clearMocks();
		if (previous) Object.defineProperty(globalThis, 'window', previous);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});
