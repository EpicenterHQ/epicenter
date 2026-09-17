/**
 * Blob resource lifecycle tests.
 *
 * Retained verbs refuse work before readiness and from the start of close.
 * Close drains admitted operations, including rejection and late URL acquisition,
 * and releases independently owned sources once before the SQLite backing.
 */
import { expect, test } from 'bun:test';
import {
	type BlobSource,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createAppBlobs } from './app.js';

type BlobPrimitives = Omit<
	Parameters<typeof createAppBlobs>[0],
	'assertUsable'
>;

function setup() {
	const acquisition = Promise.withResolvers<Result<void, never>>();
	let initialized = false;
	let closed = false;
	let owner: ReturnType<typeof createAppBlobs>;
	let closing: Promise<void> | undefined;
	const events: string[] = [];
	const calls: string[] = [];
	const bytes = new Blob(['bytes']);
	const stat = { size: bytes.size, contentType: bytes.type };
	function record<T>(name: string, value: T) {
		calls.push(name);
		return Promise.resolve(value);
	}
	const primitives: BlobPrimitives = {
		local: {
			put: () => record('put', Ok(undefined)),
			get: () => record('get', Ok(bytes)),
			stat: () => record('stat', Ok(stat)),
			list: () => record('list', Ok({ items: [] })),
			delete: () => record('delete', Ok(undefined)),
		},
		sources: {
			open: (id) => record('open', BlobStoreError.BlobNotFound({ id })),
		},
	};
	function createBlobs(options: BlobPrimitives) {
		owner = createAppBlobs({
			...options,
			assertUsable() {
				if (closed) throw new Error('closed');
				if (!initialized) throw new Error('not ready');
			},
		});
		return owner.value;
	}
	function close() {
		closed = true;
		closing ??= owner.close().then(() => {
			events.push('backing');
		});
		return closing;
	}
	const ready = acquisition.promise;
	return {
		createBlobs,
		ready,
		close,
		primitives,
		calls,
		events,
		bytes,
		acquire: () => {
			initialized = true;
			acquisition.resolve(Ok(undefined));
		},
	};
}

// ============================================================================
// Retained capabilities
// ============================================================================

test('every retained blob verb refuses before readiness and throughout close without primitive calls', async () => {
	const { createBlobs, primitives, ready, close, acquire, calls, bytes } =
		setup();
	const {
		add,
		get,
		stat,
		list,
		open,
		delete: remove,
	} = createBlobs(primitives);
	const id = generateBlobId('bin');
	const operations = [
		() => add(bytes),
		() => get(id),
		() => stat(id),
		() => list(),
		() => list({ limit: 1 }),
		() => open(id),
		() => remove(id),
	];
	try {
		for (const operation of operations) expect(operation).toThrow('not ready');
		expect(calls).toEqual([]);
		acquire();
		expectOk(await ready);
		const closing = close();
		for (const operation of operations) expect(operation).toThrow('closed');
		await closing;
		for (const operation of operations) expect(operation).toThrow('closed');
		expect(calls).toEqual([]);
	} finally {
		acquire();
		await close();
	}
});

test('application blobs expose no remote transfer coordination', async () => {
	const { createBlobs, primitives, ready, close, acquire } = setup();
	const blobs = createBlobs(primitives);
	try {
		acquire();
		expectOk(await ready);
		expect(blobs).not.toHaveProperty('remote');
		expect(Reflect.set(blobs, 'remote', {})).toBe(false);
	} finally {
		acquire();
		await close();
	}
});

// ============================================================================
// Admitted operations and owned sources
// ============================================================================

test('close drains multiple admitted local operations even when one rejects', async () => {
	const { createBlobs, primitives, ready, close, acquire, events, bytes } =
		setup();
	const reading =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['get']>>>();
	const checking =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['stat']>>>();
	const deleting =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['delete']>>>();
	primitives.local.get = () => reading.promise;
	primitives.local.delete = () => deleting.promise;
	primitives.local.stat = () => checking.promise;
	const blobs = createBlobs(primitives);
	acquire();
	expectOk(await ready);
	const id = generateBlobId('bin');
	const read = blobs.get(id);
	const check = blobs.stat(id);
	const remove = blobs.delete(id);
	const cause = new Error('stat rejected');
	const rejected = Promise.allSettled([check]);
	const closing = close();
	let settled = false;
	void closing.then(() => {
		settled = true;
	});
	try {
		expect(close()).toBe(closing);
		checking.reject(cause);
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
		checking.resolve(Ok({ size: bytes.size, contentType: bytes.type }));
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
	const opened = blobs.open(generateBlobId('bin'));
	const rejected = Promise.allSettled([opened]);
	const closing = close();
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(events).toEqual([]);
		opening.resolve(Ok(source));
		expect(await rejected).toEqual([
			{
				status: 'rejected',
				reason: expect.objectContaining({ message: 'closed' }),
			},
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
		const id = generateBlobId('bin');
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
	const pending = blobs.get(generateBlobId('bin'));
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

test('a throwing source disposer releases other sources but retains the backing', async () => {
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
	const first = expectOk(await blobs.open(generateBlobId('bin')));
	const second = expectOk(await blobs.open(generateBlobId('bin')));
	const closing = close();
	await expect(closing).rejects.toMatchObject({ errors: [cause] });
	expect(close()).toBe(closing);
	expect(events).toEqual(['source 1', 'source 2']);
	first[Symbol.dispose]();
	second[Symbol.dispose]();
	expect(events).toEqual(['source 1', 'source 2']);
});
