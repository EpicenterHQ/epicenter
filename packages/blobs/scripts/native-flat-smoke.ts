/**
 * Exercise the Rust and Bun flat publishers against temporary files.
 * A generated PCM WAV crosses the runtime boundary; independent processes race
 * the same complete key. This does not exercise a microphone or installed host.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId, parseBlobId } from '../src/blob-id.js';
import { createBunBlobStore } from '../src/bun.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await realpath(
	await mkdtemp(join(tmpdir(), 'epicenter-native-flat-')),
);

async function run(command: string[]) {
	const process = Bun.spawn(command, {
		cwd: repo,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, status] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { stdout, stderr, status };
}

try {
	const binary = join(directory, 'native-flat-fixture');
	const compiled = await run([
		'rustc',
		'--edition=2021',
		'packages/blobs/scripts/native-flat-fixture.rs',
		'-o',
		binary,
	]);
	assert.equal(compiled.status, 0, compiled.stderr);
	const root = join(directory, 'blobs');
	const id = generateBlobId('wav');
	const published = await run([binary, 'publish', root, id]);
	assert.equal(published.status, 0, published.stderr);
	assert.equal(published.stdout.trim(), `SAVED ${id} 1644`);
	const store = createBunBlobStore({ directory: root });
	const native = expectOk(await store.get(id));
	assert.equal(native.type, 'audio/wav');
	const original = new Uint8Array(await native.arrayBuffer());
	assert.equal(new TextDecoder().decode(original.subarray(0, 4)), 'RIFF');
	assert.equal(new TextDecoder().decode(original.subarray(8, 12)), 'WAVE');
	const header = new DataView(original.buffer);
	assert.equal(header.getUint32(4, true), original.byteLength - 8);
	assert.equal(header.getUint16(20, true), 1); // PCM
	assert.equal(header.getUint32(24, true), 8000);
	assert.equal(header.getUint32(40, true), original.byteLength - 44);
	assert.deepEqual(expectOk(await store.stat(id)), {
		size: 1644,
		contentType: 'audio/wav',
	});
	assert.deepEqual(
		expectOk(await store.list()).items.map(({ id }) => id),
		[id],
	);
	assert.deepEqual(await readdir(root), [id]);

	const valid = [
		id,
		'blob_aaaaaaaaaaaaaaaaaaaaa.a123456789',
		'blob_012345678901234567890.0',
	];
	const invalid = [
		'blob_aaaaaaaaaaaaaaaaaaaaa',
		'blob_aaaaaaaaaaaaaaaaaaaaa.',
		'blob_aaaaaaaaaaaaaaaaaaaaa.WAV',
		'blob_aaaaaaaaaaaaaaaaaaaaa.a1234567890',
		'blob_aaaaaaaaaaaaaaaaaaaaa.wav.more',
		'blob_aaaaaaaaaaaaaaaaaaaaa.wav/../x',
		'blob_aaaaaaaaaaaaaaaaaaaaa.wav?x',
		'blob_aaaaaaaaaaaaaaaaaaaaa.wav#x',
		'blob_aaaaaaaaaaaaaaaaaaaaa.%2e',
		'blob_aaaaaaaaaaaaaaaaaaaaa.é',
		'blob_aaaaaaaaaaaaaaaaaaaaa.wav\n',
		'blob_aaaaaaaaaaaaaaaaaaaa.wav',
	];
	for (const key of [...valid, ...invalid]) {
		const result = await run([binary, 'validate', key]);
		assert.equal(result.status === 0, parseBlobId(key) !== undefined, key);
	}

	const altered = original.slice();
	altered[44] = (altered[44]! + 1) % 256;
	const bunInput = new Blob([altered], { type: 'audio/wav' });
	// Establish both publication directions independently of race scheduling.
	assert.equal(
		expectErr(await store.put(id, bunInput)).name,
		'BlobAlreadyExists',
	);
	assert.deepEqual(
		new Uint8Array(await expectOk(await store.get(id)).arrayBuffer()),
		original,
	);
	const bunId = generateBlobId('wav');
	expectOk(await store.put(bunId, bunInput));
	const refused = await run([binary, 'publish', root, bunId]);
	assert.equal(refused.status, 17, refused.stderr);
	assert.deepEqual(
		new Uint8Array(await expectOk(await store.get(bunId)).arrayBuffer()),
		altered,
	);
	let nativeWins = 0;
	let bunWins = 0;
	for (let attempt = 0; attempt < 20; attempt++) {
		const key = generateBlobId('wav');
		const publisher = Bun.spawn([binary, 'publish', root, key, '--wait'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		try {
			const reader = publisher.stdout.getReader();
			const ready = await reader.read();
			assert.equal(new TextDecoder().decode(ready.value), 'READY\n');
			const output = (async () => {
				let text = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					text += new TextDecoder().decode(value);
				}
				reader.releaseLock();
				return text;
			})();
			const bunPublication = store.put(key, bunInput);
			publisher.stdin.write('publish\n');
			publisher.stdin.end();
			const [bunResult, nativeStatus, nativeOutput, nativeError] =
				await Promise.all([
					bunPublication,
					publisher.exited,
					output,
					new Response(publisher.stderr).text(),
				]);
			if (nativeStatus === 0) {
				nativeWins++;
				assert.equal(bunResult.error?.name, 'BlobAlreadyExists');
				assert.equal(nativeOutput.trim(), `SAVED ${key} 1644`);
			} else {
				bunWins++;
				assert.equal(nativeStatus, 17, nativeError);
				expectOk(bunResult);
			}
			const saved = expectOk(await store.get(key));
			assert.deepEqual(
				new Uint8Array(await saved.arrayBuffer()),
				nativeStatus === 0 ? original : altered,
			);
		} finally {
			publisher.kill();
			await publisher.exited;
		}
	}
	assert.equal(
		(await readdir(root)).filter((name) => name.startsWith('.')).length,
		0,
	);
	console.log(
		`Native WAV read by Bun; both publishers refuse the other's saved file; ${valid.length + invalid.length} parser fixtures agree; 20 publication races preserved one winner (${nativeWins} Rust, ${bunWins} Bun).`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
