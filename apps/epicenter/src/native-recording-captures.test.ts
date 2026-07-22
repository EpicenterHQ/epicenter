import { expect, test } from 'bun:test';
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopRecordNativeCaptureResolution } from '@epicenter/data/desktop-record-owner';
import { createNativeRecordingCaptureResolver } from './native-recording-captures.ts';

const CAPTURE_ID = 'capture_0123456789abcdef0123456789abcdef';

test('verified native capture streams then releases its pinned descriptor', async () => {
	await using directory = await temporaryDirectory();
	const path = join(directory.path, `${CAPTURE_ID}.wav`);
	await writeFile(path, 'native bytes');
	const resolve = createNativeRecordingCaptureResolver(directory.path);
	const resolved = await resolve({
		kind: 'native-capture',
		captureId: CAPTURE_ID,
		byteLength: 12,
	});

	expect(await readSource(resolved.source)).toBe('native bytes');
	await resolved.release();
	expect(await Bun.file(path).text()).toBe('native bytes');
});

test('native capture resolution rejects symlinks and declared length mismatch', async () => {
	await using directory = await temporaryDirectory();
	const target = join(directory.path, 'target.wav');
	await writeFile(target, 'target');
	await symlink(target, join(directory.path, `${CAPTURE_ID}.wav`));
	const resolve = createNativeRecordingCaptureResolver(directory.path);

	await expect(
		resolve({
			kind: 'native-capture',
			captureId: CAPTURE_ID,
			byteLength: 6,
		}),
	).rejects.toThrow('unavailable');

	const otherId = 'capture_1123456789abcdef0123456789abcdef';
	await writeFile(join(directory.path, `${otherId}.wav`), 'short');
	await expect(
		resolve({
			kind: 'native-capture',
			captureId: otherId,
			byteLength: 6,
		}),
	).rejects.toThrow('changed before admission');
});

test('release never deletes a replacement at the verified capture path', async () => {
	await using directory = await temporaryDirectory();
	const path = join(directory.path, `${CAPTURE_ID}.wav`);
	await writeFile(path, 'original');
	const resolved = await createNativeRecordingCaptureResolver(directory.path)({
		kind: 'native-capture',
		captureId: CAPTURE_ID,
		byteLength: 8,
	});
	expect(await readSource(resolved.source)).toBe('original');

	await rename(path, join(directory.path, 'moved-original.wav'));
	await writeFile(path, 'replacement');
	await resolved.release();
	expect(await Bun.file(path).text()).toBe('replacement');
	expect(
		await Bun.file(join(directory.path, 'moved-original.wav')).text(),
	).toBe('original');
});

async function temporaryDirectory() {
	const path = await mkdtemp(join(tmpdir(), 'native-capture-'));
	return {
		path,
		[Symbol.asyncDispose]() {
			return rm(path, { recursive: true, force: true });
		},
	};
}

async function readSource(
	source: DesktopRecordNativeCaptureResolution['source'],
): Promise<string> {
	const chunks: Uint8Array[] = [];
	if ('getReader' in source) {
		const reader = source.getReader();
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			chunks.push(result.value.slice());
		}
	} else {
		for await (const chunk of source) chunks.push(chunk.slice());
	}
	return Buffer.concat(chunks).toString();
}
