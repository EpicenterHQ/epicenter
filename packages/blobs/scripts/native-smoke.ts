/** Rust publication and saved Stop bytes remain readable through independent Bun storage. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
	const fixtures = (
		await runNative('native_publication_metadata_contract')
	).filter((line) => line.startsWith('BLOB_CONTRACT '));
	assert.equal(fixtures.length, 7, 'Native normalization fixtures');
	for (const [index, line] of fixtures.entries()) {
		const fixture: { id: string; metadata: string; data: string } = JSON.parse(
			line.slice('BLOB_CONTRACT '.length),
		);
		const id = parseBlobId(fixture.id);
		assert(id, 'Native generic BlobId');
		const root = join(directory, 'normalization', String(index));
		await mkdir(join(root, id), { recursive: true });
		await Bun.write(join(root, id, 'metadata.json'), fixture.metadata);
		await Bun.write(join(root, id, 'data'), fixture.data);
		const store = createBunBlobStore({ directory: root });
		const stat = await store.stat(id);
		if (stat.error) throw stat.error;
		const body = await store.get(id);
		if (body.error) throw body.error;
		assert.equal(await body.data.text(), fixture.data);
		assert.equal(stat.data.size, body.data.size);
		const listed = await store.list();
		if (listed.error) throw listed.error;
		assert.deepEqual(listed.data, { items: [{ id, ...stat.data }] });
	}

	const lines = await runNative('native_saved_recording_contract', {
		EPICENTER_RECORDING_EVIDENCE_ROOT: directory,
	});
	const receipt = lines.find((line) => line.startsWith('SAVED_RECORDING '));
	assert(receipt, 'Native Stop produced a saved receipt');
	const saved: { blobId: string; durationMs: number; byteLength: number } =
		JSON.parse(receipt.slice('SAVED_RECORDING '.length));
	const id = parseBlobId(saved.blobId);
	assert(id, 'Stop returned a generic BlobId');
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
	const reopened = createBunBlobStore({ directory: root });
	const listed = await reopened.list();
	if (listed.error) throw listed.error;
	assert.deepEqual(listed.data, { items: [{ id, ...stat.data }] });
	console.log(
		`Bun read ${fixtures.length} native normalization fixtures and a saved native recording after session close.`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
