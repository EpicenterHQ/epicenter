/**
 * Library transfer ownership with real, independently reopened filesystem bytes.
 * Controlled transport barriers isolate deletion, closure, retirement and storage
 * failures. The authenticated browser journey separately proves wire integration.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	attachmentStorageId,
	AttachmentTransferError,
	BlobStoreError,
} from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { expectOk } from 'wellcrafted/testing';
import {
	createAttachmentSync,
	type AttachmentTransport,
} from './attachment-sync.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 4_000;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error('Transfer did not reach expected state.');
		await Bun.sleep(5);
	}
}
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'attachment-owner-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const bytes = createBunBlobStore({ directory });
	const id = attachmentStorageId('recordings', 'a'.repeat(24));
	const published = expectOk(
		await bytes.attachments!.put(
			id,
			new Blob(['audio'], { type: 'audio/wav' }),
			7,
		),
	);
	const content = {
		sha256: published.sha256,
		size: published.size,
		contentType: published.contentType,
	};
	let live = true;
	let present = true;
	let durable = true;
	let retired = false;
	const requests: string[] = [];
	let respond: AttachmentTransport['fetch'] = async () =>
		new Response(null, { status: 204 });
	const open = () => {
		const worker = createAttachmentSync({
			bytes,
			rows: () =>
				present
					? [
							{
								tableName: 'recordings',
								rowId: 'a'.repeat(24),
								content,
								isCurrent: () => live && present,
							},
						]
					: [],
			save: async () => durable,
			assertUsable() {
				if (!live) throw new Error('closed');
			},
			onRetired() {
				retired = true;
				live = false;
				void worker.close();
			},
			onObserverError(cause) {
				throw cause;
			},
		});
		cleanups.push(() => worker.close());
		worker.start({
			baseURL: 'https://authority.test',
			appId: 'test.app',
			library: 'personal',
			dataId: 'test.data',
			generation: 7,
			fetch: async (url, init) => {
				requests.push(init?.method ?? 'GET');
				return respond(url, init);
			},
		});
		return worker;
	};
	return {
		bytes,
		id,
		content,
		directory,
		requests,
		open,
		respond(fn: AttachmentTransport['fetch']) {
			respond = fn;
		},
		deleteRow() {
			present = false;
		},
		failSave() {
			durable = false;
		},
		retired: () => retired,
	};
}

test('reopen reconstructs upload debt and identical publication clears it durably', async () => {
	const { open, bytes, id, directory, requests } = await setup();
	const first = open();
	await until(() => first.value.status().items[0]?.transfer === 'idle');
	expect(requests).toEqual(['POST']);
	expect(
		expectOk(await createBunBlobStore({ directory }).stat(id)).attachment
			?.pendingUpload,
	).toBe(false);
	await first.close();
	const second = open();
	await until(() => second.value.status().items[0]?.transfer === 'idle');
	expect(requests).toEqual(['POST']);
	expect(await expectOk(await bytes.get(id)).text()).toBe('audio');
});

test('storage failure is not absence and retries without creating a download', async () => {
	const { open, bytes, requests } = await setup();
	const stat = bytes.stat;
	let failed = true;
	bytes.stat = async (id) =>
		failed
			? BlobStoreError.BlobStoreFailed({ id, cause: 'disk unavailable' })
			: stat(id);
	const worker = open();
	await until(() => worker.value.status().items[0]?.presence === 'error');
	expect(requests).toEqual([]);
	failed = false;
	await until(() => worker.value.status().items[0]?.transfer === 'idle');
	expect(requests).toEqual(['POST']);
});

test('unconfirmed row durability admits no transfer', async () => {
	const { open, failSave, requests } = await setup();
	failSave();
	const worker = open();
	await until(() => worker.value.status().items[0]?.error?.kind === 'storage');
	expect(requests).toEqual([]);
});

for (const outcome of ['delete', 'close', 'retire'] as const) {
	test(`${outcome} crossing publication never acknowledges the old owner`, async () => {
		const { open, respond, deleteRow, bytes, id, retired } = await setup();
		const barrier = Promise.withResolvers<Response>();
		respond(() => barrier.promise);
		const worker = open();
		await until(() => worker.value.status().items[0]?.transfer === 'uploading');
		let closing: Promise<void> | undefined;
		if (outcome === 'delete') {
			deleteRow();
			worker.changed();
		}
		if (outcome === 'close') closing = worker.close();
		barrier.resolve(
			new Response(null, { status: outcome === 'retire' ? 410 : 204 }),
		);
		if (closing) await closing;
		else if (outcome === 'retire') await until(retired);
		else {
			await worker.close();
			expect(worker.value.status().items).toEqual([]);
		}
		expect(expectOk(await bytes.stat(id)).attachment?.pendingUpload).toBe(true);
	});
}

test('wrong immutable content is a visible conflict until an explicit retry', async () => {
	const { open, respond, requests, bytes, id } = await setup();
	respond(async () => new Response(null, { status: 409 }));
	const worker = open();
	await until(() => worker.value.status().items[0]?.transfer === 'failed');
	expect(worker.value.status().items[0]?.error?.kind).toBe('conflict');
	expect(expectOk(await bytes.stat(id)).attachment?.pendingUpload).toBe(true);
	respond(async () => new Response(null, { status: 204 }));
	worker.value.retry();
	await until(() => worker.value.status().items[0]?.transfer === 'idle');
	expect(requests).toEqual(['POST', 'POST']);
});

test('automatic HTTP download survives restart without upload debt or read-time network', async () => {
	const { open, bytes, id, content, respond, requests, directory } =
		await setup();
	expectOk(await bytes.delete(id));
	let downloads = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			downloads += 1;
			return new Response('audio', {
				headers: { 'content-type': 'audio/wav' },
			});
		},
	});
	cleanups.push(async () => server.stop(true));
	respond(async () => Response.json({ url: server.url.href, content }));
	const worker = open();
	await until(() => worker.value.status().items[0]?.transfer === 'idle');
	expect(requests).toEqual(['GET', 'GET']);
	expect(downloads).toBe(1);
	await worker.close();
	server.stop(true);
	const reopened = createBunBlobStore({ directory });
	expect(expectOk(await reopened.stat(id)).attachment).toEqual({
		...content,
		pendingUpload: false,
	});
	expect(await expectOk(await reopened.get(id)).text()).toBe('audio');
	const second = open();
	await until(() => second.value.status().items[0]?.transfer === 'idle');
	expect(requests).toEqual(['GET', 'GET']);
});

test('pause downloads admits no HTTP bytes and resume uses the same owner', async () => {
	const { open, bytes, id, content, respond, requests } = await setup();
	expectOk(await bytes.delete(id));
	let downloads = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			downloads += 1;
			return new Response('audio', {
				headers: { 'content-type': 'audio/wav' },
			});
		},
	});
	cleanups.push(async () => server.stop(true));
	respond(async () => Response.json({ url: server.url.href, content }));
	const worker = open();
	worker.value.pauseDownloads();
	await until(() => worker.value.status().items[0]?.presence === 'missing');
	expect(requests).toEqual([]);
	expect(downloads).toBe(0);
	worker.value.resumeDownloads();
	await until(() => worker.value.status().items[0]?.transfer === 'idle');
	expect(downloads).toBe(1);
});

test('retirement after downloaded bytes retains immutable bytes without publishing completion', async () => {
	const { open, bytes, id, content, respond, retired } = await setup();
	expectOk(await bytes.delete(id));
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			return new Response('audio', {
				headers: { 'content-type': 'audio/wav' },
			});
		},
	});
	cleanups.push(async () => server.stop(true));
	let admissions = 0;
	respond(async () =>
		++admissions === 1
			? Response.json({ url: server.url.href, content })
			: new Response(null, { status: 410 }),
	);
	const worker = open();
	const observed: string[] = [];
	worker.value.subscribe(() =>
		observed.push(worker.value.status().items[0]?.transfer ?? 'absent'),
	);
	await until(retired);
	expect(observed).not.toContain('idle');
	expect(expectOk(await bytes.stat(id)).attachment).toEqual({
		...content,
		pendingUpload: false,
	});
});

test('two slots bound transfers and prioritization selects the next owner without another runner', async () => {
	const { bytes, content } = await setup();
	const rowIds = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(24));
	for (const rowId of rowIds.slice(1))
		expectOk(
			await bytes.attachments!.put(
				attachmentStorageId('recordings', rowId),
				new Blob(['audio'], { type: 'audio/wav' }),
				7,
			),
		);
	const requests: string[] = [];
	const barriers = new Map<
		string,
		ReturnType<typeof Promise.withResolvers<Response>>
	>();
	const worker = createAttachmentSync({
		bytes,
		rows: () =>
			rowIds.map((rowId) => ({
				tableName: 'recordings',
				rowId,
				content,
				isCurrent: () => true,
			})),
		save: async () => true,
		assertUsable() {},
		onRetired() {},
		onObserverError(cause) {
			throw cause;
		},
	});
	cleanups.push(async () => {
		for (const barrier of barriers.values())
			barrier.resolve(new Response(null, { status: 204 }));
		await worker.close();
	});
	worker.start({
		baseURL: 'https://authority.test',
		appId: 'test.app',
		library: 'personal',
		dataId: 'test.data',
		generation: 7,
		async fetch(input) {
			const rowId = new URL(input).pathname.split('/').at(-1)!;
			requests.push(rowId);
			const barrier = Promise.withResolvers<Response>();
			barriers.set(rowId, barrier);
			return barrier.promise;
		},
	});
	worker.value.pauseDownloads();
	await until(() => requests.length === 2);
	expect(requests).toEqual(rowIds.slice(0, 2));
	worker.value.prioritize('recordings', rowIds[3]!);
	barriers.get(rowIds[0]!)!.resolve(new Response(null, { status: 204 }));
	await until(() => requests.length === 3);
	expect(requests[2]).toBe(rowIds[3]);
	expect(
		worker.value.status().items.filter((item) => item.transfer === 'uploading'),
	).toHaveLength(2);
});

for (const finalStatus of [200, 410]) {
	test(`download admission retries 503 then ${finalStatus} without downloading again`, async () => {
		const { open, bytes, id, content, respond, retired } = await setup();
		expectOk(await bytes.delete(id));
		let downloads = 0;
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch() {
				downloads++;
				return new Response('audio', {
					headers: { 'content-type': 'audio/wav' },
				});
			},
		});
		cleanups.push(async () => server.stop(true));
		let admissions = 0;
		respond(async () => {
			admissions++;
			if (admissions === 1)
				return Response.json({ url: server.url.href, content });
			return new Response(null, {
				status: admissions === 2 ? 503 : finalStatus,
			});
		});
		const worker = open();
		await until(() =>
			finalStatus === 410
				? retired()
				: worker.value.status().items[0]?.transfer === 'idle',
		);
		expect(admissions).toBe(3);
		expect(downloads).toBe(1);
	});
}

test('expired byte ticket retries with fresh authorization automatically', async () => {
	const { open, bytes, id, content, respond, requests } = await setup();
	expectOk(await bytes.delete(id));
	let downloads = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			if (++downloads === 1) return new Response(null, { status: 403 });
			return new Response('audio', {
				headers: { 'content-type': 'audio/wav' },
			});
		},
	});
	cleanups.push(async () => server.stop(true));
	respond(async () => Response.json({ url: server.url.href, content }));
	const worker = open();
	await until(() => worker.value.status().items[0]?.transfer === 'idle');
	expect(downloads).toBe(2);
	expect(requests).toEqual(['GET', 'GET', 'GET']);
});

test('owner deadline aborts actual requests in both slots and schedules recovery', async () => {
	const { bytes, content } = await setup();
	const rowIds = ['a', 'b'].map((letter) => letter.repeat(24));
	expectOk(
		await bytes.attachments!.put(
			attachmentStorageId('recordings', rowIds[1]!),
			new Blob(['audio'], { type: 'audio/wav' }),
			7,
		),
	);
	const deadlines: (() => void)[] = [];
	const original = globalThis.setTimeout;
	const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
		callback: () => void,
		delay?: number,
	) => {
		if (delay === 20 * 60_000) {
			deadlines.push(callback);
			return original(() => {}, delay);
		}
		return original(callback, delay);
	}) as typeof setTimeout);
	cleanups.push(async () => timer.mockRestore());
	let started = 0;
	let aborted = 0;
	let hung = true;
	const worker = createAttachmentSync({
		bytes,
		rows: () =>
			rowIds.map((rowId) => ({
				tableName: 'recordings',
				rowId,
				content,
				isCurrent: () => true,
			})),
		save: async () => true,
		assertUsable() {},
		onRetired() {},
		onObserverError(cause) {
			throw cause;
		},
	});
	cleanups.push(() => worker.close());
	worker.start({
		baseURL: 'https://authority.test',
		appId: 'test.app',
		library: 'personal',
		dataId: 'test.data',
		generation: 7,
		async fetch(_input, init) {
			started++;
			if (!hung) return new Response(null, { status: 204 });
			return new Promise((_resolve, reject) =>
				init!.signal!.addEventListener(
					'abort',
					() => {
						aborted++;
						reject(init!.signal!.reason);
					},
					{ once: true },
				),
			);
		},
	});
	await until(() => started === 2);
	for (const expire of deadlines) expire();
	await until(() =>
		worker.value.status().items.every((item) => item.transfer === 'waiting'),
	);
	expect(aborted).toBe(2);
	hung = false;
	worker.wake();
	await until(() =>
		worker.value.status().items.every((item) => item.transfer === 'idle'),
	);
	expect(started).toBe(4);
});

for (const origin of [null, 6]) {
	test(`current generation does not adopt local origin ${origin}`, async () => {
		const { open, bytes, id, requests } = await setup();
		expectOk(await bytes.delete(id));
		expectOk(
			await bytes.attachments!.put(
				id,
				new Blob(['audio'], { type: 'audio/wav' }),
				origin,
			),
		);
		const worker = open();
		await until(() => worker.value.status().items[0]?.transfer === 'idle');
		expect(requests).toEqual([]);
		expect(expectOk(await bytes.stat(id)).attachment?.originGeneration).toBe(
			origin,
		);
	});
}

test('failed acknowledgment retains durable upload debt until verified retry', async () => {
	const { open, bytes, id, requests } = await setup();
	const acknowledge = bytes.attachments!.acknowledge;
	let failures = 1;
	bytes.attachments!.acknowledge = async (...args) =>
		failures-- > 0
			? BlobStoreError.BlobStoreFailed({ id, cause: 'receipt disk failure' })
			: acknowledge(...args);
	const worker = open();
	await until(() => worker.value.status().items[0]?.error?.kind === 'storage');
	expect(expectOk(await bytes.stat(id)).attachment?.pendingUpload).toBe(true);
	await until(() => worker.value.status().items[0]?.transfer === 'idle');
	expect(requests).toEqual(['POST', 'POST']);
	expect(expectOk(await bytes.stat(id)).attachment?.pendingUpload).toBe(false);
});

test('a byte adapter returning a timeout Result backs off instead of immediately uploading again', async () => {
	const { open, bytes, respond } = await setup();
	let expire: (() => void) | undefined;
	const original = globalThis.setTimeout;
	const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
		callback: () => void,
		delay?: number,
	) => {
		if (delay === 20 * 60_000) expire = callback;
		return original(callback, delay);
	}) as typeof setTimeout);
	cleanups.push(async () => timer.mockRestore());
	respond(async () =>
		Response.json({ url: 'https://bytes.test/file', requiredHeaders: {} }),
	);
	let uploads = 0;
	bytes.attachments!.upload = async (_id, _content, _ticket, signal) => {
		uploads++;
		return new Promise((resolve) =>
			signal.addEventListener(
				'abort',
				() =>
					resolve(
						AttachmentTransferError.Failed({
							kind: 'transport',
							cause: signal.reason,
						}),
					),
				{ once: true },
			),
		);
	};
	const worker = open();
	await until(() => uploads === 1);
	expire!();
	await until(() => worker.value.status().items[0]?.transfer === 'waiting');
	expect(worker.value.status().items[0]?.error?.kind).toBe('transport');
	await Bun.sleep(30);
	expect(uploads).toBe(1);
});
