/**
 * Store-owned blob lifecycle tests.
 *
 * Retained verbs refuse work before readiness and from the start of close.
 * Close drains admitted operations, including rejection and late URL acquisition,
 * and releases independently owned sources once before the SQLite backing.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	type BlobSource,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { compileData, defineData } from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createSqliteDurablePort } from './log.js';
import {
	createStoreOverPort,
	type StoreBacking,
	type StoreBlobBacking,
	StoreUnusableError,
} from './store.js';

const definition = expectOk(
	compileData(
		defineData({ id: 'so.epicenter.store-blobs-test', kv: {}, tables: {} }),
	),
);

function setup() {
	const raw = new Database(':memory:');
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const acquisition = Promise.withResolvers<Result<StoreBacking, never>>();
	const events: string[] = [];
	const calls: string[] = [];
	const bytes = new Blob(['bytes']);
	const stat = { size: bytes.size, contentType: bytes.type };
	function record<T>(name: string, value: T) {
		calls.push(name);
		return Promise.resolve(value);
	}
	const primitives: StoreBlobBacking = {
		local: {
			put: () => record('put', Ok(undefined)),
			copy: () => record('copy', Ok(undefined)),
			get: () => record('get', Ok(bytes)),
			stat: () => record('stat', Ok(stat)),
			statMany: (ids) =>
				record(
					'statMany',
					ids.map(() => Ok(stat)),
				),
			delete: () => record('delete', Ok(undefined)),
		},
		sources: {
			open: (id) => record('open', BlobStoreError.BlobNotFound({ id })),
		},
		remote: {
			upload: () => record('upload', Ok(undefined)),
			download: () => record('download', Ok(undefined)),
			purge: () => record('purge', Ok(undefined)),
		},
	};
	const backing: StoreBacking = {
		durable: port,
		loaded: port.load(),
		dispose() {
			events.push('backing');
			raw.close();
		},
	};
	const { createBlobs, ready, close } = createStoreOverPort({
		definition,
		blobStore: primitives.local,
		acquire: () => acquisition.promise,
	});
	return {
		createBlobs,
		ready,
		close,
		primitives,
		calls,
		events,
		bytes,
		acquire: () => acquisition.resolve(Ok(backing)),
	};
}

// ============================================================================
// Retained capabilities
// ============================================================================

test('every retained blob verb refuses before readiness and throughout close without primitive calls', async () => {
	const { createBlobs, primitives, ready, close, acquire, calls, bytes } =
		setup();
	const { add, get, stat, statMany, open, removeLocal, remote } =
		createBlobs(primitives);
	const { upload, download, purge } = remote;
	const id = generateBlobId();
	const operations = [
		() => add(bytes),
		() => get(id),
		() => stat(id),
		() => statMany([id]),
		() => statMany([]),
		() => open(id),
		() => removeLocal(id),
		() => upload(id),
		() => download(id),
		() => purge(id),
	];
	try {
		for (const operation of operations) expect(operation).toThrow('not ready');
		expect(calls).toEqual([]);
		acquire();
		expectOk(await ready);
		const closing = close();
		for (const operation of operations)
			expect(operation).toThrow(StoreUnusableError);
		await closing;
		for (const operation of operations)
			expect(operation).toThrow(StoreUnusableError);
		expect(calls).toEqual([]);
	} finally {
		acquire();
		await close();
	}
});

test('unconfigured remote methods retain the document guard and return typed refusals', async () => {
	const { createBlobs, primitives, ready, close, acquire } = setup();
	const blobs = createBlobs({ ...primitives, remote: null });
	const id = generateBlobId();
	const operations = [
		blobs.remote.upload,
		blobs.remote.download,
		blobs.remote.purge,
	];
	try {
		for (const operation of operations)
			expect(() => operation(id)).toThrow('not ready');
		acquire();
		expectOk(await ready);
		expect(expectErr(await blobs.remote.upload(id)).name).toBe('RemoteNotConfigured');
		expect(expectErr(await blobs.remote.download(id)).name).toBe('RemoteNotConfigured');
		expect(expectErr(await blobs.remote.purge(id)).name).toBe('RemoteNotConfigured');
		expect(Reflect.set(blobs, 'remote', primitives.remote)).toBe(false);
		const closing = close();
		for (const operation of operations)
			expect(() => operation(id)).toThrow(StoreUnusableError);
		await closing;
		for (const operation of operations)
			expect(() => operation(id)).toThrow(StoreUnusableError);
	} finally {
		acquire();
		await close();
	}
});

// ============================================================================
// Admitted operations and owned sources
// ============================================================================

test('close drains multiple admitted local and remote operations even when one rejects', async () => {
	const { createBlobs, primitives, ready, close, acquire, events, bytes } =
		setup();
	const reading =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['get']>>>();
	const uploading = Promise.withResolvers<Result<void, never>>();
	const deleting =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['delete']>>>();
	primitives.local.get = () => reading.promise;
	primitives.local.delete = () => deleting.promise;
	const blobs = createBlobs({
		...primitives,
		remote: {
			upload: () => uploading.promise,
			download: async () => Ok(undefined),
			purge: async () => Ok(undefined),
		},
	});
	acquire();
	expectOk(await ready);
	const id = generateBlobId();
	const read = blobs.get(id);
	const upload = blobs.remote.upload(id);
	const remove = blobs.removeLocal(id);
	const cause = new Error('upload rejected');
	const rejected = Promise.allSettled([upload]);
	const closing = close();
	let settled = false;
	void closing.then(() => {
		settled = true;
	});
	try {
		expect(close()).toBe(closing);
		uploading.reject(cause);
		expect(await rejected).toEqual([{ status: 'rejected', reason: cause }]);
		expect(settled).toBe(false);
		expect(events).toEqual([]);
		const refusal = BlobStoreError.BlobStoreFailed({ id, cause });
		deleting.resolve(refusal);
		expect(expectErr(await remove)).toBe(refusal.error);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(events).toEqual([]);
		reading.resolve(Ok(bytes));
		expect(expectOk(await read)).toBe(bytes);
		await closing;
		expect(settled).toBe(true);
		expect(events).toEqual(['backing']);
	} finally {
		reading.resolve(Ok(bytes));
		uploading.resolve(Ok(undefined));
		deleting.resolve(Ok(undefined));
		await closing;
	}
});

test('a source arriving after close is disposed once before backing release and refuses its URL', async () => {
	const { createBlobs, primitives, ready, close, acquire, events } = setup();
	const opening = Promise.withResolvers<Result<BlobSource, never>>();
	let reentrant: Promise<void> | undefined;
	const source: BlobSource = {
		url: 'blob:late',
		[Symbol.dispose]() {
			events.push('late source');
			reentrant = close();
		},
	};
	const blobs = createBlobs({
		...primitives,
		sources: { open: () => opening.promise },
	});
	acquire();
	expectOk(await ready);
	const opened = blobs.open(generateBlobId());
	const rejected = Promise.allSettled([opened]);
	const closing = close();
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(events).toEqual([]);
		opening.resolve(Ok(source));
		expect(await rejected).toEqual([
			{ status: 'rejected', reason: expect.any(StoreUnusableError) },
		]);
		await closing;
		expect(events).toEqual(['late source', 'backing']);
		expect(reentrant).toBe(closing);
		expect(close()).toBe(closing);
	} finally {
		opening.resolve(Ok(source));
		await closing;
	}
});

test('independent URL releases are idempotent and a source disposer reenters the same close promise', async () => {
	const { createBlobs, primitives, ready, close, acquire, events } = setup();
	let count = 0;
	let reentrant: Promise<void> | undefined;
	const blobs = createBlobs({
		...primitives,
		sources: {
			async open() {
				const name = `source ${++count}`;
				return Ok({
					url: `blob:${count}`,
					[Symbol.dispose]() {
						events.push(name);
						if (name === 'source 2') reentrant = close();
					},
				});
			},
		},
	});
	acquire();
	expectOk(await ready);
	try {
		const id = generateBlobId();
		const first = expectOk(await blobs.open(id));
		const second = expectOk(await blobs.open(id));
		expect(first.url).toBe('blob:1');
		expect(second.url).toBe('blob:2');
		first[Symbol.dispose]();
		first[Symbol.dispose]();
		expect(events).toEqual(['source 1']);
		const closing = close();
		await closing;
		first[Symbol.dispose]();
		second[Symbol.dispose]();
		second[Symbol.dispose]();
		expect(events).toEqual(['source 1', 'source 2', 'backing']);
		expect(reentrant).toBe(closing);
		expect(close()).toBe(closing);
	} finally {
		await close();
	}
});

test('a primitive that closes synchronously is already admitted to the drain', async () => {
	const { createBlobs, primitives, ready, close, acquire, events, bytes } =
		setup();
	const reading =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['get']>>>();
	const started = Promise.withResolvers<void>();
	let reentrant: Promise<void> | undefined;
	primitives.local.get = () => {
		reentrant = close();
		started.resolve();
		return reading.promise;
	};
	const blobs = createBlobs(primitives);
	acquire();
	expectOk(await ready);
	const pending = blobs.get(generateBlobId());
	try {
		await started.promise;
		expect(events).toEqual([]);
		expect(reentrant).toBe(close());
		reading.resolve(Ok(bytes));
		expect(expectOk(await pending)).toBe(bytes);
		await close();
		expect(events).toEqual(['backing']);
	} finally {
		reading.resolve(Ok(bytes));
		await close();
	}
});

test('a throwing source disposer does not skip other sources or backing release', async () => {
	const { createBlobs, primitives, ready, close, acquire, events } = setup();
	const cause = new Error('source release failed');
	let count = 0;
	const blobs = createBlobs({
		...primitives,
		sources: {
			async open() {
				const index = ++count;
				return Ok({
					url: `blob:${index}`,
					[Symbol.dispose]() {
						events.push(`source ${index}`);
						if (index === 1) throw cause;
					},
				});
			},
		},
	});
	acquire();
	expectOk(await ready);
	const first = expectOk(await blobs.open(generateBlobId()));
	const second = expectOk(await blobs.open(generateBlobId()));
	const closing = close();
	await expect(closing).rejects.toBe(cause);
	expect(close()).toBe(closing);
	expect(events).toEqual(['source 1', 'source 2', 'backing']);
	first[Symbol.dispose]();
	second[Symbol.dispose]();
	expect(events).toEqual(['source 1', 'source 2', 'backing']);
});
