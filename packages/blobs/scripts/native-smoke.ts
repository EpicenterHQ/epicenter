import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBlobStorageId } from '../src/attachment-key.js';
import { createBunBlobStore } from '../src/bun.js';

const repo = new URL('../../../', import.meta.url).pathname;
const test = Bun.spawn(
	[
		'cargo',
		'test',
		'--manifest-path',
		'apps/epicenter/src-tauri/Cargo.toml',
		'native_publication_metadata_contract',
		'--',
		'--nocapture',
	],
	{ cwd: repo, stdout: 'pipe', stderr: 'inherit' },
);
const output = await new Response(test.stdout).text();
if ((await test.exited) !== 0)
	throw new Error('Native publication fixture failed');
const fixtures = output
	.split('\n')
	.filter((line) => line.startsWith('BLOB_CONTRACT '));
if (fixtures.length !== 9)
	throw new Error(`Expected 9 native fixtures, got ${fixtures.length}`);
const directory = await mkdtemp(join(tmpdir(), 'epicenter-native-blob-'));
try {
	for (const [index, line] of fixtures.entries()) {
		const fixture: { id: string; metadata: string; data: string } = JSON.parse(
			line.slice('BLOB_CONTRACT '.length),
		);
		const id = parseBlobStorageId(fixture.id);
		if (!id) throw new Error('Invalid native blob ID');
		const root = join(directory, String(index));
		await mkdir(join(root, id), { recursive: true });
		await Bun.write(join(root, id, 'metadata.json'), fixture.metadata);
		await Bun.write(join(root, id, 'data'), fixture.data);
		const store = createBunBlobStore({ directory: root });
		const stat = await store.stat(id);
		if (stat.error) throw new Error(JSON.stringify(stat.error));
		const body = await store.get(id);
		if (body.error) throw new Error(JSON.stringify(body.error));
		if (
			(await body.data.text()) !== fixture.data ||
			stat.data.size !== body.data.size
		) {
			throw new Error('Native publication changed in the Bun reader');
		}
		const attachment = stat.data.attachment;
		if (attachment) {
			if (
				attachment.sha256 !==
				new Bun.CryptoHasher('sha256').update(fixture.data).digest('hex')
			)
				throw new Error('Native digest differs from actual bytes');
			if (
				attachment.pendingUpload !==
				(typeof attachment.originGeneration === 'number')
			)
				throw new Error('Native origin lost its upload obligation');
			if (typeof attachment.originGeneration === 'number') {
				const acknowledged = await store.attachments.acknowledge(
					id,
					attachment,
					attachment.originGeneration,
				);
				if (acknowledged.error) throw acknowledged.error;
				const reopened = await createBunBlobStore({ directory: root }).stat(id);
				if (
					reopened.error ||
					reopened.data.attachment?.pendingUpload !== false ||
					reopened.data.attachment.originGeneration !==
						attachment.originGeneration
				)
					throw new Error('Native origin or receipt did not survive reopen');
			}
		}
	}
	console.log(`Bun read ${fixtures.length} native-produced blob fixtures.`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
