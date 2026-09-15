/**
 * Durable attachment content evidence and local upload origin.
 * Independent browser and filesystem instances preserve origin and receipts;
 * identical retries verify actual content and downloaded files never gain origin.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { attachmentStorageId } from './attachment-key.js';
import { createBrowserBlobStore } from './browser.js';
import { createBunBlobStore } from './bun.js';

const cleanup: string[] = [];
afterEach(async () => {
	for (const directory of cleanup.splice(0))
		await rm(directory, { recursive: true, force: true });
});

for (const platform of ['browser', 'bun'] as const) {
	test(`${platform}: origin and acknowledgment survive independent reopen; downloads do not create upload work`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'attachment-origin-'));
		cleanup.push(directory);
		const indexedDb = new IDBFactory();
		const reopen = () =>
			platform === 'bun'
				? createBunBlobStore({ directory })
				: createBrowserBlobStore({
						appId: 'test.attachments',
						replica: { library: 'local' },
						indexedDb,
						locks: {
							request: async (_name, _options, callback) => callback({}),
						},
					});
		const first = reopen();
		const id = attachmentStorageId('recordings', 'a'.repeat(24));
		const file = new Blob(['content'], { type: 'audio/wav' });
		const evidence = expectOk(await first.attachments!.put(id, file, 7));
		expect(expectOk(await reopen().stat(id)).attachment).toMatchObject({
			...evidence,
			originGeneration: 7,
			pendingUpload: true,
		});
		expectOk(await reopen().attachments!.put(id, file, 7));
		expect(
			expectErr(
				await reopen().attachments!.put(
					id,
					new Blob(['changed'], { type: 'audio/wav' }),
					7,
				),
			).name,
		).toBe('BlobAlreadyExists');
		expect(expectErr(await reopen().attachments!.put(id, file, 8)).name).toBe(
			'BlobAlreadyExists',
		);
		expect(
			expectErr(
				await reopen().attachments!.acknowledge(
					id,
					{ ...evidence, sha256: '0'.repeat(64) },
					7,
				),
			).name,
		).toBe('BlobStoreFailed');
		expectOk(await reopen().attachments!.acknowledge(id, evidence, 7));
		expect(expectOk(await reopen().stat(id)).attachment?.pendingUpload).toBe(
			false,
		);
		const download = attachmentStorageId('recordings', 'b'.repeat(24));
		expectOk(await reopen().attachments!.put(download, file));
		const downloaded = expectOk(await reopen().stat(download)).attachment!;
		expect(downloaded).not.toHaveProperty('originGeneration');
		expect(downloaded.pendingUpload).toBe(false);
		const local = attachmentStorageId('recordings', 'c'.repeat(24));
		expectOk(await reopen().attachments!.put(local, file, null));
		expect(expectOk(await reopen().stat(local)).attachment).toMatchObject({
			originGeneration: null,
			pendingUpload: false,
		});
	});
}

test('filesystem retries reject different bytes even when immutable metadata was retained', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'attachment-corrupt-'));
	cleanup.push(directory);
	const store = createBunBlobStore({ directory });
	const id = attachmentStorageId('recordings', 'd'.repeat(24));
	const file = new Blob(['same-size'], { type: 'audio/wav' });
	expectOk(await store.attachments.put(id, file, 1));
	await Bun.write(join(directory, id, 'data'), 'different');
	expect(expectErr(await store.attachments.put(id, file, 1)).name).toBe(
		'BlobAlreadyExists',
	);
});

test.each(['after rename', 'before staging'] as const)(
	'filesystem %s retries cannot confirm publication until ancestor barriers succeed',
	async (failurePoint) => {
		const ancestor = await mkdtemp(join(tmpdir(), 'attachment-barrier-'));
		cleanup.push(ancestor);
		const directory = join(ancestor, 'new-account', 'new-library', 'blobs');
		const reopen = () => createBunBlobStore({ directory });
		const id = attachmentStorageId('recordings', 'f'.repeat(24));
		const file = new Blob(['durable bytes'], { type: 'audio/wav' });
		if (failurePoint === 'before staging')
			expectOk(await reopen().attachments.put(id, file, 7));
		const originalOpen = fs.open;
		const barrierError = new Error('Injected ancestor durability failure');
		let blocked = true;
		const barriers: string[] = [];
		const openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
			const handle = await originalOpen(...args);
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				const path = resolve(String(args[0]));
				barriers.push(path);
				if (blocked && path === resolve(ancestor)) throw barrierError;
				await sync();
			};
			return handle;
		});
		// Force the existing-object fallback before staged metadata exists.
		const mkdirSpy =
			failurePoint === 'before staging'
				? spyOn(fs, 'mkdir').mockImplementation((): Promise<never> =>
						Promise.reject(new Error('Injected staging failure')),
					)
				: undefined;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const failure = expectErr(await reopen().attachments.put(id, file, 7));
				expect(failure.name).toBe('BlobStoreFailed');
				expect(failure).toHaveProperty('cause', barrierError);
				// Rename already happened: absence is not a safe conclusion.
				expect(await Bun.file(join(directory, id, 'data')).text()).toBe(
					'durable bytes',
				);
			}
			blocked = false;
			barriers.length = 0;
			expectOk(await reopen().attachments.put(id, file, 7));
			expect(barriers).toContain(resolve(join(directory, id, 'data')));
			expect(barriers).toContain(resolve(join(directory, id, 'metadata.json')));
			let current = resolve(join(directory, id));
			while (true) {
				expect(barriers).toContain(current);
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}
		} finally {
			openSpy.mockRestore();
			mkdirSpy?.mockRestore();
		}
	},
);

test.each([
	96_044, 5_760_044, 172_800_044,
])('filesystem streams and verifies representative mono WAV size %s', async (size) => {
	const directory = await mkdtemp(join(tmpdir(), 'attachment-stream-'));
	cleanup.push(directory);
	const store = createBunBlobStore({ directory });
	const id = attachmentStorageId('recordings', 'e'.repeat(24));
	let remaining = size;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!remaining) {
				controller.close();
				return;
			}
			const length = Math.min(64 * 1024, remaining);
			remaining -= length;
			controller.enqueue(new Uint8Array(length).fill(42));
		},
	});
	expectOk(
		await store.putRequest(
			id,
			new Request('https://host.invalid', {
				method: 'PUT',
				body,
				headers: { 'content-type': 'audio/wav' },
			}),
			{ generation: 3 },
		),
	);
	const opened = expectOk(await store.openFile(id));
	Object.defineProperty(opened.file, 'arrayBuffer', {
		value() {
			throw new Error('Whole-file materialization forbidden');
		},
	});
	expectOk(await store.attachments.put(id, opened.file, 3));
	expect(expectOk(await store.stat(id))).toMatchObject({
		size,
		attachment: { originGeneration: 3, pendingUpload: true },
	});
});
