import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentStorageId, type AttachmentContent } from '@epicenter/blobs';
import { openCurrentAuthority } from '@epicenter/data/sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { createS3BlobStore, type PresignedPut } from '../s3-blob-store.js';
import { createAttachmentTransfer } from './attachment-transfer.js';

const row = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const id = attachmentStorageId('recordings', row);
const file = new Blob(['finished recording'], { type: 'audio/wav' });
const content: AttachmentContent = {
	sha256: new Bun.CryptoHasher('sha256')
		.update(await file.arrayBuffer())
		.digest('hex'),
	size: file.size,
	contentType: file.type,
};

/** Actual HTTP bytes, real signing and persisted authority; not an S3 provider emulator. */
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'attachment-protocol-'));
	let database = new Database(join(directory, 'authority.sqlite'));
	let authority = openCurrentAuthority({
		sqlite: createBunSqliteAdapter(database),
	});
	authority.ensureCurrent(new Uint8Array([1]));
	let object: Blob | undefined;
	let reads = 0;
	let beforeRead: (() => Promise<void>) | undefined;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === 'GET') {
				reads++;
				await beforeRead?.();
				return object
					? new Response(object, { headers: { 'content-type': object.type } })
					: new Response(null, { status: 404 });
			}
			if (object) return new Response(null, { status: 412 });
			object = new Blob([await request.arrayBuffer()], {
				type: request.headers.get('content-type') ?? '',
			});
			return new Response(null, { status: 200 });
		},
	});
	const store = createS3BlobStore({
		endpoint: server.url.origin,
		region: 'auto',
		accessKeyId: 'test',
		secretAccessKey: 'test',
		bucket: 'test',
	});
	function transfer() {
		return createAttachmentTransfer({
			authority,
			store,
			library: 'apps/test/personal/alice/data/test',
		});
	}
	let handler = transfer();
	return {
		raw(request: Request) {
			return handler(request, 'recordings', row);
		},
		get authority() {
			return authority;
		},
		get reads() {
			return reads;
		},
		set object(value: Blob | undefined) {
			object = value;
		},
		set beforeRead(value: (() => Promise<void>) | undefined) {
			beforeRead = value;
		},
		request(method: string, evidence = content, generation = 1) {
			return handler(
				new Request(`http://library/attachment?generation=${generation}`, {
					method,
					...(method === 'GET'
						? {}
						: { body: JSON.stringify({ generation, content: evidence }) }),
				}),
				'recordings',
				row,
			);
		},
		reopen() {
			database.close();
			database = new Database(join(directory, 'authority.sqlite'));
			authority = openCurrentAuthority({
				sqlite: createBunSqliteAdapter(database),
			});
			handler = transfer();
		},
		async [Symbol.asyncDispose]() {
			server.stop(true);
			database.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test('malformed and oversized controls are invalid requests, not recoverable server failures', async () => {
	await using f = await setup();
	for (const body of ['{', 'x'.repeat(2049), '{}']) {
		expect(
			(
				await f.raw(
					new Request('http://library/attachment', { method: 'POST', body }),
				)
			).status,
		).toBe(400);
	}
	expect(f.reads).toBe(0);
});

test('tickets reserve nothing; only verified publication survives restart and lost responses', async () => {
	await using f = await setup();
	const wrong = { ...content, sha256: 'f'.repeat(64) };
	expect((await f.request('POST', wrong)).status).toBe(200);
	expect(f.authority.attachments.read(1, id).status).toBe('missing');
	const ticketResponse = await f.request('POST');
	expect(ticketResponse.status).toBe(200);
	const ticket = (await ticketResponse.json()) as PresignedPut;
	expect(
		(
			await fetch(ticket.url, {
				method: 'PUT',
				headers: ticket.requiredHeaders,
				body: file,
			})
		).status,
	).toBe(200);
	expect((await f.request('GET')).status).toBe(404);
	expect((await f.request('PUT')).status).toBe(204);
	expect(f.reads).toBe(1);
	// Forget the successful response and reopen an independent SQLite connection.
	f.reopen();
	expect((await f.request('PUT')).status).toBe(204);
	expect((await f.request('POST')).status).toBe(204);
	expect(f.reads).toBe(1);
	expect((await f.request('GET')).status).toBe(200);
	expect((await f.request('PUT', wrong)).status).toBe(409);
});

test('empty finished files publish through actual bytes and retry after restart', async () => {
	await using f = await setup();
	const empty = new Blob([], { type: 'application/octet-stream' });
	const evidence = {
		sha256: new Bun.CryptoHasher('sha256').digest('hex'),
		size: 0,
		contentType: empty.type,
	};
	const response = await f.request('POST', evidence);
	expect(response.status).toBe(200);
	const ticket = (await response.json()) as PresignedPut;
	expect(
		(
			await fetch(ticket.url, {
				method: 'PUT',
				headers: ticket.requiredHeaders,
				body: empty,
			})
		).status,
	).toBe(200);
	expect((await f.request('PUT', evidence)).status).toBe(204);
	f.reopen();
	expect((await f.request('POST', evidence)).status).toBe(204);
	expect(f.reads).toBe(1);
	expect((await f.request('POST', { ...evidence, size: -1 })).status).toBe(400);
});

test('412 and equal size or MIME do not prove content; incorrect occupied bytes remain a conflict', async () => {
	await using f = await setup();
	f.object = new Blob(['x'.repeat(file.size)], { type: file.type });
	const ticket = (await (await f.request('POST')).json()) as PresignedPut;
	expect(
		(
			await fetch(ticket.url, {
				method: 'PUT',
				body: file,
				headers: ticket.requiredHeaders,
			})
		).status,
	).toBe(412);
	expect((await f.request('PUT')).status).toBe(409);
	expect((await f.request('GET')).status).toBe(404);
	expect(f.authority.attachments.read(1, id).status).toBe('missing');
});

test('temporarily absent bytes can be retried without another row or reservation', async () => {
	await using f = await setup();
	expect((await f.request('PUT')).status).toBe(404);
	f.object = file;
	expect((await f.request('PUT')).status).toBe(204);
	expect(f.reads).toBe(2);
});

test('retirement during full-object verification refuses publication and preserves immutable evidence', async () => {
	await using f = await setup();
	f.object = file;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.beforeRead = async () => {
		entered.resolve();
		await release.promise;
	};
	const pending = f.request('PUT');
	await entered.promise;
	const activation = await f.authority.prepareActivation({
		operation: 'test-retire',
		expected: f.authority.capture(),
		bytes: new Uint8Array([2]),
	});
	expect(activation.activate().status).toBe('activated');
	release.resolve();
	expect((await pending).status).toBe(410);
	expect(f.authority.attachments.read(2, id).status).toBe('missing');
	expect((await f.request('PUT', content, 2)).status).toBe(204);
	expect((await f.request('PUT', content, 1)).status).toBe(410);
	f.reopen();
	expect(
		(await f.request('PUT', { ...content, sha256: 'f'.repeat(64) }, 2)).status,
	).toBe(409);
});

test('verification concurrency is bounded at the captured library owner', async () => {
	await using f = await setup();
	f.object = file;
	let arrived = 0;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.beforeRead = async () => {
		if (++arrived === 2) entered.resolve();
		await release.promise;
	};
	const first = f.request('PUT');
	const second = f.request('PUT');
	await entered.promise;
	try {
		expect((await f.request('PUT')).status).toBe(429);
	} finally {
		release.resolve();
	}
	expect((await first).status).toBe(204);
	expect((await second).status).toBe(204);
});
