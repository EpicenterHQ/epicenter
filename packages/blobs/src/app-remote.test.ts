import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createAppRemoteBlobs } from './app.js';
import type { BlobSource, RemoteBlobs } from './index.js';

function remote(): RemoteBlobs {
	return {
		add: async () => Ok('https://cloud.example/object'),
		addLocal: async () => Ok('https://cloud.example/object'),
		get: async () => Ok(new Blob(['audio'])),
		open: async () => Ok({ url: 'blob:display', [Symbol.dispose]() {} }),
		delete: async () => Ok(undefined),
	};
}

test('close aborts an admitted request, drains its late source and rejects new work', async () => {
	const arrived = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<ReturnType<typeof Ok<BlobSource>>>();
	let disposed = 0;
	let signal: AbortSignal | undefined;
	const owner = createAppRemoteBlobs({
		remote: {
			...remote(),
			open: async (_, options) => {
				signal = options?.signal;
				arrived.resolve();
				return reply.promise;
			},
		},
	});
	const opening = owner.value.open('https://cloud.example/object');
	await arrived.promise;
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(signal?.aborted).toBe(true);
	expect(() => owner.value.get('https://cloud.example/object')).toThrow(
		'closed',
	);
	reply.resolve(
		Ok({
			url: 'blob:late',
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
				[Symbol.dispose]() {
					disposed++;
				},
			}),
	};
	const first = createAppRemoteBlobs({ remote: service });
	const second = createAppRemoteBlobs({ remote: service });
	const a = expectOk(await first.value.open('https://cloud.example/object'));
	const b = expectOk(await second.value.open('https://cloud.example/object'));
	await first.close();
	a[Symbol.dispose]();
	expect(disposed).toBe(1);
	b[Symbol.dispose]();
	await second.close();
	expect(disposed).toBe(2);
});
