/** Remote ownership drains requests and disposes presentation independently. */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type BlobSource, generateBlobId, type RemoteBlobs } from './index.js';
import { createRemoteBlobAccess } from './owner.js';

function remote(): RemoteBlobs {
	return {
		add: async () => Ok(generateBlobId('bin')),
		copyFromLocal: async () => Ok(generateBlobId('bin')),
		copyToLocal: async () => Ok(generateBlobId('bin')),
		get: async () => Ok(new Blob(['audio'])),
		open: async () =>
			Ok({
				url: 'blob:display',
				[Symbol.dispose]() {},
				async [Symbol.asyncDispose]() {},
			}),
		delete: async () => Ok(undefined),
	};
}

test('close aborts an admitted request, drains its late source and rejects new work', async () => {
	const arrived = Promise.withResolvers<void>();
	const reply =
		Promise.withResolvers<
			ReturnType<typeof Ok<BlobSource & AsyncDisposable>>
		>();
	let disposed = 0;
	let signal: AbortSignal | undefined;
	const owner = createRemoteBlobAccess({
		remote: {
			...remote(),
			open: async (_, options) => {
				signal = options?.signal;
				arrived.resolve();
				return reply.promise;
			},
		},
	});
	const opening = owner.value.open(generateBlobId('bin'));
	await arrived.promise;
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(signal?.aborted).toBe(true);
	expect(() => owner.value.get(generateBlobId('bin'))).toThrow('closed');
	reply.resolve(
		Ok({
			url: 'blob:late',
			async [Symbol.asyncDispose]() {},
			[Symbol.dispose]() {
				disposed++;
			},
		}),
	);
	expectErr(await opening);
	await closing;
	expect(disposed).toBe(1);
});

test('one owner closes only its own display sources and retained release is idempotent', async () => {
	let disposed = 0;
	const service = {
		...remote(),
		open: async () =>
			Ok({
				url: 'blob:display',
				async [Symbol.asyncDispose]() {},
				[Symbol.dispose]() {
					disposed++;
				},
			}),
	};
	const first = createRemoteBlobAccess({ remote: service });
	const second = createRemoteBlobAccess({ remote: service });
	const a = expectOk(await first.value.open(generateBlobId('bin')));
	const b = expectOk(await second.value.open(generateBlobId('bin')));
	await first.close();
	a[Symbol.dispose]();
	expect(disposed).toBe(1);
	b[Symbol.dispose]();
	await second.close();
	expect(disposed).toBe(2);
});

test('close drains presentation release even after the caller already disposed it', async () => {
	const release = Promise.withResolvers<void>();
	let settled = false;
	const owner = createRemoteBlobAccess({
		remote: {
			...remote(),
			async open() {
				return Ok({
					url: 'private:source',
					[Symbol.dispose]() {},
					[Symbol.asyncDispose]() {
						return release.promise;
					},
				});
			},
		},
	});
	const source = expectOk(await owner.value.open(generateBlobId('bin')));
	source[Symbol.dispose]();
	const closed = owner.close().then(() => {
		settled = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(settled).toBe(false);
	release.resolve();
	await closed;
	expect(settled).toBe(true);
});
