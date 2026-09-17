/** Rust publication and saved Stop bytes remain readable through independent Bun storage. */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBlobId } from '../src/blob-id.js';
import { createBunBlobStore } from '../src/bun.js';

const repo = new URL('../../../', import.meta.url).pathname;
async function runNative(filter: string, env: Record<string, string> = {}) {
	const test = Bun.spawn(
		[
			'cargo',
			'test',
			'--manifest-path',
			'apps/epicenter/src-tauri/Cargo.toml',
			filter,
			'--',
			'--nocapture',
		],
		{
			cwd: repo,
			stdout: 'pipe',
			stderr: 'inherit',
			env: { ...process.env, ...env },
		},
	);
	const output = await new Response(test.stdout).text();
	if ((await test.exited) !== 0)
		throw new Error(`Native fixture failed: ${filter}`);
	return output.split('\n');
}

const directory = await mkdtemp(join(tmpdir(), 'epicenter-native-blob-'));
try {
	const lines = await runNative('native_saved_recording_contract', {
		EPICENTER_RECORDING_EVIDENCE_ROOT: directory,
	});
	const receipt = lines.find((line) => line.startsWith('SAVED_RECORDING '));
	assert(receipt, 'Native Stop produced a saved receipt');
	const saved: { blobId: string; durationMs: number; byteLength: number } =
		JSON.parse(receipt.slice('SAVED_RECORDING '.length));
	const id = parseBlobId(saved.blobId);
	assert(id && id.endsWith('.wav'), 'Stop returned a complete WAV key');
	assert(saved.durationMs > 0);
	const root = join(
		directory,
		'apps',
		'so.epicenter.recording-evidence',
		'blobs',
	);
	// Native Stop wrote this directory and closed its session. No fixture copy occurs.
	const store = createBunBlobStore({ directory: root });
	const stat = await store.stat(id);
	if (stat.error) throw stat.error;
	assert.deepEqual(stat.data, {
		size: saved.byteLength,
		contentType: 'audio/wav',
	});
	const body = await store.get(id);
	if (body.error) throw body.error;
	const header = new TextDecoder().decode(
		await body.data.slice(0, 12).arrayBuffer(),
	);
	assert.equal(header.slice(0, 4), 'RIFF');
	assert.equal(header.slice(8, 12), 'WAVE');
	const source = await store.openFile(id);
	if (source.error) throw source.error;
	assert.equal(source.data.file.size, saved.byteLength);
	await source.data.close();
	assert.deepEqual(await readdir(root), [id]);
	const reopened = createBunBlobStore({ directory: root });
	const listed = await reopened.list();
	if (listed.error) throw listed.error;
	assert.deepEqual(listed.data, { items: [{ id, ...stat.data }] });
	for (const command of [
		[
			'ffprobe',
			'-v',
			'error',
			'-show_entries',
			'stream=codec_name,sample_rate,channels',
			'-of',
			'json',
			join(root, id),
		],
		['ffmpeg', '-v', 'error', '-i', join(root, id), '-f', 'null', '-'],
	]) {
		const decoder = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
		const [output, error, status] = await Promise.all([
			new Response(decoder.stdout).text(),
			new Response(decoder.stderr).text(),
			decoder.exited,
		]);
		assert.equal(
			status,
			0,
			`${command[0]} refused native Stop output: ${error}`,
		);
		if (output) console.log(output.trim());
	}
	console.log(
		'Native Stop WAV survives session close, Bun reopening, and external decoding.',
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
