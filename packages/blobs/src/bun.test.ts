/**
 * Flat Bun blob publication tests.
 *
 * Verifies immutable flat files, metadata-only enumeration, scoped deletion,
 * no-follow reads, collision races, and retained publication receipts after
 * failed durability barriers. Historical and other publishers' files survive.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { BlobId } from './blob-id.js';
import { generateBlobId } from './blob-id.js';
import { createBunBlobStore } from './bun.js';

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-flat-blobs-'));
	directories.push(directory);
	return { directory, store: createBunBlobStore({ directory }) };
}

test('one complete key is one ordinary file with canonical format and no sidecar', async () => {
	const { directory, store } = await setup();
	const id = generateBlobId('wav');
	expectOk(
		await store.put(id, new Blob(['wave bytes'], { type: 'audio/x-wav' })),
	);
	expect(await readdir(directory)).toEqual([id]);
	expect((await lstat(join(directory, id))).isFile()).toBe(true);
	expect(await readFile(join(directory, id), 'utf8')).toBe('wave bytes');
	const saved = expectOk(await store.get(id));
	expect(saved.type).toBe('audio/wav');
	expect(await saved.text()).toBe('wave bytes');
	expect(expectOk(await store.stat(id))).toEqual({
		size: 10,
		contentType: 'audio/wav',
	});
	expectErr(
		await store.put(id, new Blob(['replacement'], { type: 'audio/wav' })),
	);
	expect(await readFile(join(directory, id), 'utf8')).toBe('wave bytes');
});

test('independent publishers racing one key publish exactly one complete body', async () => {
	const { directory, store } = await setup();
	const other = createBunBlobStore({ directory });
	const id = generateBlobId('bin');
	const outcomes = await Promise.all([
		store.put(id, new Blob(['a'.repeat(1024 * 1024)])),
		other.put(id, new Blob(['b'.repeat(1024 * 1024)])),
	]);
	expect(outcomes.filter((result) => result.error === null)).toHaveLength(1);
	expect(outcomes.find((result) => result.error)?.error?.name).toBe(
		'BlobAlreadyExists',
	);
	const body = await readFile(join(directory, id), 'utf8');
	expect(['a'.repeat(1024 * 1024), 'b'.repeat(1024 * 1024)]).toContain(body);
	expect(await readdir(directory)).toEqual([id]);
});

test('stat and paginated list never create a BunFile or read blob bodies', async () => {
	const { store } = await setup();
	const ids = Array.from({ length: 4 }, () => generateBlobId('bin')).sort();
	for (const id of ids) expectOk(await store.put(id, new Blob([])));
	const file = spyOn(Bun, 'file').mockImplementation(() => {
		throw new Error('Body read forbidden');
	});
	try {
		expect(expectOk(await store.stat(ids[0]!)).size).toBe(0);
		const first = expectOk(await store.list({ limit: 2 }));
		expect(first.items.map(({ id }) => id)).toEqual(ids.slice(0, 2));
		const second = expectOk(
			await store.list({ cursor: first.nextCursor, limit: 2 }),
		);
		expect(second.items.map(({ id }) => id)).toEqual(ids.slice(2));
		expect(second.nextCursor).toBeUndefined();
		expect(file).not.toHaveBeenCalled();
	} finally {
		file.mockRestore();
	}
});

test('symlinks, dangling symlinks, and directories are collisions and never readable blobs', async () => {
	const { directory, store } = await setup();
	const outside = join(directory, 'outside');
	await writeFile(outside, 'preserve');
	const ids = [
		generateBlobId('bin'),
		generateBlobId('bin'),
		generateBlobId('bin'),
	];
	await symlink(outside, join(directory, ids[0]!));
	await symlink(join(directory, 'missing'), join(directory, ids[1]!));
	await mkdir(join(directory, ids[2]!));
	for (const id of ids) {
		expect(expectErr(await store.put(id, new Blob(['new']))).name).toBe(
			'BlobAlreadyExists',
		);
		expect(expectErr(await store.get(id)).name).toBe('BlobStoreFailed');
		expect(expectErr(await store.stat(id)).name).toBe('BlobStoreFailed');
		expect(expectErr(await store.delete(id)).name).toBe('BlobStoreFailed');
	}
	expect(expectOk(await store.list()).items).toEqual([]);
	expect(await readFile(outside, 'utf8')).toBe('preserve');
	expect((await lstat(join(directory, ids[1]!))).isSymbolicLink()).toBe(true);
});

test('every key boundary refuses traversal and legacy names without touching files', async () => {
	const { directory, store } = await setup();
	await writeFile(join(directory, 'sentinel'), 'preserve');
	for (const value of [
		'./sentinel',
		'%2e%2e/sentinel',
		generateBlobId('wav') + '/data',
		'blob_' + 'a'.repeat(21),
	]) {
		const id = value as BlobId;
		expect(expectErr(await store.put(id, new Blob(['new']))).name).toBe(
			'BlobStoreFailed',
		);
		expect(expectErr(await store.get(id)).name).toBe('BlobStoreFailed');
		expect(expectErr(await store.stat(id)).name).toBe('BlobStoreFailed');
		expect(expectErr(await store.delete(id)).name).toBe('BlobStoreFailed');
		expect(expectErr(await store.list({ cursor: value })).name).toBe(
			'BlobStoreFailed',
		);
	}
	expect(await readdir(directory)).toEqual(['sentinel']);
});

test('deleting a key preserves legacy objects and all unrelated staging', async () => {
	const { directory, store } = await setup();
	const legacy = join(directory, 'blob_' + 'a'.repeat(21));
	await mkdir(legacy);
	await writeFile(join(legacy, 'data'), 'old bytes');
	await writeFile(join(legacy, 'metadata.json'), '{"size":9}');
	await mkdir(join(directory, '.staging'));
	await writeFile(join(directory, '.bun-other.tmp'), 'other bun writer');
	await writeFile(join(directory, '.native-other.tmp'), 'other native writer');
	const id = generateBlobId('bin');
	expectOk(await store.put(id, new Blob(['new'])));
	expectOk(await store.delete(id));
	expectOk(await store.delete(id));
	expect(expectOk(await store.list()).items).toEqual([]);
	expect(await readFile(join(legacy, 'data'), 'utf8')).toBe('old bytes');
	expect((await readdir(directory)).sort()).toEqual([
		'.bun-other.tmp',
		'.native-other.tmp',
		'.staging',
		'blob_' + 'a'.repeat(21),
	]);
});

test("temporary-name collision preserves the other publisher's staging file", async () => {
	const { directory, store } = await setup();
	const name = '.bun-11111111-1111-4111-8111-111111111111.tmp';
	await writeFile(join(directory, name), 'other publisher');
	const random = spyOn(crypto, 'randomUUID').mockReturnValue(
		'11111111-1111-4111-8111-111111111111',
	);
	try {
		expect(
			expectErr(await store.put(generateBlobId('bin'), new Blob(['new']))).name,
		).toBe('BlobStoreFailed');
	} finally {
		random.mockRestore();
	}
	expect(await readFile(join(directory, name), 'utf8')).toBe('other publisher');
	expect(await readdir(directory)).toEqual([name]);
});

test('known MIME mismatch fails before creating an entry', async () => {
	const { directory, store } = await setup();
	expect(
		expectErr(
			await store.put(
				generateBlobId('wav'),
				new Blob(['bad'], { type: 'audio/webm; codecs=opus' }),
			),
		).name,
	).toBe('BlobStoreFailed');
	expect(await readdir(directory)).toEqual([]);
});

test('streaming failure exposes no final file and removes only its own partial stage', async () => {
	const { directory, store } = await setup();
	let reads = 0;
	const request = new Request('https://example.test', {
		method: 'POST',
		body: new ReadableStream({
			pull(controller) {
				if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
				else controller.error(new Error('capture lost'));
			},
		}),
	});
	expect(
		expectErr(await store.putRequest(generateBlobId('bin'), request)).name,
	).toBe('BlobStoreFailed');
	expect(await readdir(directory)).toEqual([]);
});

test('failed prepublication sync retains complete bytes and retries a consumed request', async () => {
	const { directory, store } = await setup();
	const probe = await open(directory, 'r');
	const prototype: Pick<typeof probe, 'sync'> = Object.getPrototypeOf(probe);
	await probe.close();
	const sync = spyOn(prototype, 'sync').mockRejectedValueOnce(
		new Error('disk unavailable'),
	);
	const id = generateBlobId('bin');
	const input = new Request('https://example.test', {
		method: 'POST',
		body: 'complete',
	});
	try {
		expect(expectErr(await store.putRequest(id, input)).name).toBe(
			'BlobStoreFailed',
		);
	} finally {
		sync.mockRestore();
	}
	expect(expectOk(await store.list()).items).toEqual([]);
	expect(await readdir(directory)).toHaveLength(1);
	expectOk(await store.putRequest(id, input));
	expect(await readFile(join(directory, id), 'utf8')).toBe('complete');
	expect(await readdir(directory)).toEqual([id]);
});

test('failed postpublication sync retains the final file and receipt for retry', async () => {
	const { directory, store } = await setup();
	const probe = await open(directory, 'r');
	const prototype: Pick<typeof probe, 'sync'> = Object.getPrototypeOf(probe);
	const original = prototype.sync;
	await probe.close();
	let calls = 0;
	const sync = spyOn(prototype, 'sync').mockImplementation(function (
		this: typeof probe,
	) {
		if (++calls === 2)
			return Promise.reject(new Error('directory sync failed'));
		return original.call(this);
	});
	const id = generateBlobId('bin');
	const input = new Blob(['published']);
	try {
		expect(expectErr(await store.put(id, input)).name).toBe('BlobStoreFailed');
	} finally {
		sync.mockRestore();
	}
	expect(await readFile(join(directory, id), 'utf8')).toBe('published');
	expect(await readdir(directory)).toHaveLength(2);
	expect(expectErr(await store.put(id, new Blob(['different']))).name).toBe(
		'BlobStoreFailed',
	);
	expectOk(await store.put(id, input));
	expect(await readdir(directory)).toEqual([id]);
	expect(await readFile(join(directory, id), 'utf8')).toBe('published');
});

for (const barrier of [1, 2]) {
	for (const kind of ['Blob', 'Request', 'Response']) {
		test(`fresh ${kind} retry verifies bytes after ${barrier === 1 ? 'pre' : 'post'}publication failure`, async () => {
			const { directory, store } = await setup();
			const id = generateBlobId('bin');
			const bytes = 'abc123'.repeat(30_000);
			function input(value: string) {
				if (kind === 'Request')
					return new Request('https://example.test', {
						method: 'POST',
						body: value,
					});
				if (kind === 'Response') return new Response(value);
				return new Blob([value]);
			}
			function put(value: string) {
				const data = input(value);
				if (data instanceof Request) return store.putRequest(id, data);
				if (data instanceof Response) return store.putResponse(id, data);
				return store.put(id, data);
			}
			const probe = await open(directory, 'r');
			const prototype: Pick<typeof probe, 'sync'> =
				Object.getPrototypeOf(probe);
			const original = prototype.sync;
			await probe.close();
			let calls = 0;
			const sync = spyOn(prototype, 'sync').mockImplementation(function (
				this: typeof probe,
			) {
				if (++calls === barrier)
					return Promise.reject(new Error('sync failed'));
				return original.call(this);
			});
			try {
				expect(expectErr(await put(bytes)).name).toBe('BlobStoreFailed');
			} finally {
				sync.mockRestore();
			}
			for (const wrong of [
				bytes.slice(1),
				`${bytes}x`,
				`${bytes.slice(0, -1)}x`,
			]) {
				expect(expectErr(await put(wrong)).name).toBe('BlobStoreFailed');
			}
			if (barrier === 1)
				expect(expectErr(await store.get(id)).name).toBe('BlobNotFound');
			else expect(await readFile(join(directory, id), 'utf8')).toBe(bytes);
			expectOk(await put(bytes));
			expect(await readdir(directory)).toEqual([id]);
			expect(await readFile(join(directory, id), 'utf8')).toBe(bytes);
		});
	}
}

test('get reports descriptor close failure through its Result and releases the handle', async () => {
	const { directory, store } = await setup();
	const id = generateBlobId('bin');
	expectOk(await store.put(id, new Blob(['saved'])));
	const probe = await open(directory, 'r');
	const prototype: Pick<typeof probe, 'close'> = Object.getPrototypeOf(probe);
	await probe.close();
	const close = spyOn(prototype, 'close').mockRejectedValueOnce(
		new Error('close failed'),
	);
	try {
		const error = expectErr(await store.get(id));
		expect(error.name).toBe('BlobStoreFailed');
		expect(error.message).toContain('close failed');
		expect(close).toHaveBeenCalledTimes(2);
	} finally {
		close.mockRestore();
	}
});

test('Response stream finalization closes the borrowed file after completion and cancellation', async () => {
	const { store } = await setup();
	const id = generateBlobId('bin');
	expectOk(await store.put(id, new Blob(['saved data'])));
	for (const cancel of [false, true]) {
		const opened = expectOk(await store.openFile(id));
		const close = spyOn(opened, 'close');
		const reader = opened.file.stream().getReader();
		const response = new Response(
			new ReadableStream({
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (done) {
							await opened.close();
							controller.close();
						} else controller.enqueue(value);
					} catch (cause) {
						await opened.close();
						controller.error(cause);
					}
				},
				async cancel(reason) {
					try {
						await reader.cancel(reason);
					} finally {
						await opened.close();
					}
				},
			}),
		);
		if (cancel) await response.body!.cancel('client disconnected');
		else expect(await response.text()).toBe('saved data');
		expect(close).toHaveBeenCalledTimes(1);
		close.mockRestore();
	}
});

test('descriptor-backed ranges survive path replacement and close after consumption', async () => {
	const { directory, store } = await setup();
	const id = generateBlobId('bin');
	expectOk(await store.put(id, new Blob(['0123456789'])));
	const opened = expectOk(await store.openFile(id));
	try {
		await unlink(join(directory, id));
		await writeFile(join(directory, 'outside'), 'outside');
		await symlink(join(directory, 'outside'), join(directory, id));
		const response = new Response(opened.file.slice(2, 5));
		expect(await response.text()).toBe('234');
	} finally {
		await opened.close();
	}
	expect(expectErr(await store.openFile(id)).name).toBe('BlobStoreFailed');
});

test('a same-store writer waits for failed staging before publishing its own complete body', async () => {
	const { store } = await setup();
	const id = generateBlobId('bin');
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const first = store.putRequest(
		id,
		new Request('https://fixture.invalid', {
			method: 'PUT',
			body: new ReadableStream({
				async pull() {
					entered.resolve();
					await released.promise;
					throw new Error('capture failed');
				},
			}),
		}),
	);
	await entered.promise;
	let settled = false;
	const second = store
		.put(id, new Blob(['second complete body']))
		.then((result) => {
			settled = true;
			return result;
		});
	await Bun.sleep(0);
	expect(settled).toBe(false);
	released.resolve();
	expect(expectErr(await first).name).toBe('BlobStoreFailed');
	expectOk(await second);
	expect(await expectOk(await store.get(id)).text()).toBe(
		'second complete body',
	);
});
