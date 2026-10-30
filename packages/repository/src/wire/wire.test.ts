/**
 * Wire Tests
 *
 * The wire's promises one at a time, over real HTTP and WebSockets against
 * the Bun dev server on localhost, with a SQLite Store and an in-memory Git
 * behind it. The property suite over the same wire is
 * `src/sim/wire.property.test.ts`.
 *
 * Key behaviors:
 * - every endpoint, reads included, refuses a request with no session (401) and one from a non-member (403)
 * - a commit's answer is JSON with a status for each outcome: 200 applied, merged (a stale parent merges), flushed; 409 outcome-unknown; 428 no parent; 429 rate; 403 a reader or another author; 413 too large; 422 the door; 400 not a commit
 * - PUT and DELETE are one-file conveniences over the same commit: 428 without a precondition, 412 with a stale one, an ETag that is the Git blob hash
 * - A GET of a file names the commit it read (Epicenter-Commit), so a one-shot client posts a commit on it and merges with what landed since
 * - a text by hash is immutable and private; a body is capped before it is parsed, and a slow one times out
 * - a device's socket names `main` when it opens, answers each request by its id before the commit's event, takes commits and catch-ups through the same functions as HTTP, and closes when the session expires
 * - a replica whose socket dropped resumes from its last head by catching up
 * - a browser's socket connects with a one-use ticket bound to the session that asked for it: refused when reused, expired, presented with another account's credential, or outliving its session
 * - the dev server serves a listed origin across origins
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { request as httpRequest } from 'node:http';
import { unwrap } from 'wellcrafted/result';
import { serveRepository, socketWithHeaders } from '../bun/serve.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { openReplica, type Replica } from '../client/replica.js';
import { connectSocket } from '../client/socket.js';
import { type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { writePointer } from '../core/markdown.js';
import { createMemoryGitStore } from '../server/memory-git.js';
import { createMemoryLfsStore } from '../server/memory-lfs-store.js';
import {
	createServer,
	LIMITS,
	type Limits,
	type Server,
} from '../server/server.js';
import { createLfsClient, createWireClient } from './client.js';
import {
	type Authenticate,
	authenticateBearer,
	type SocketMessage,
	type Verified,
	type WireLimits,
} from './wire.js';

const EPOCH = Date.UTC(2026, 9, 28, 12);
const note = (body: string) => `---\ntitle: A\n---\n${body}`;
const SESSIONS: Record<string, Verified> = {
	alice: { user: 'alice', role: 'writer' },
	bob: { user: 'bob', role: 'writer' },
	rita: { user: 'rita', role: 'reader' },
	eve: { user: 'eve', role: null },
};

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
});

function setup({
	limits,
	wire,
	authenticate = authenticateBearer((token) => SESSIONS[token] ?? null),
}: {
	limits?: Partial<Limits>;
	wire?: Partial<WireLimits>;
	authenticate?: Authenticate;
} = {}) {
	const clock = { now: EPOCH };
	const server = createServer({
		store: openBunSqlite(),
		git: createMemoryGitStore(),
		clock: () => clock.now,
		...(limits === undefined ? {} : { limits }),
	});
	const lfs = createMemoryLfsStore();
	const served = serveRepository({
		repository: 'test',
		serverId: 'test-server',
		server,
		authenticate,
		lfs,
		...(wire === undefined ? {} : { limits: wire }),
	});
	stops.push(served.stop);
	const url = (path: string) => new URL(path, served.url).href;
	const as = (user: string, headers: Record<string, string> = {}) => ({
		authorization: `Bearer ${user}`,
		...headers,
	});
	const post = (body: unknown, user = 'alice') =>
		fetch(url('commits'), {
			method: 'POST',
			headers: as(user, { 'content-type': 'application/json' }),
			body: typeof body === 'string' ? body : JSON.stringify(body),
		});
	return { clock, server, lfs, served, url, as, post };
}

function make(
	server: Server,
	files: CommitFile[],
	{
		user = 'alice',
		parent = server.main(),
		time = new Date(EPOCH).toISOString(),
	} = {},
): LiveCommit {
	const body = { parent, author: { user, device: 'laptop' }, time, files };
	return { id: commitId(body), ...body };
}

describe('Git LFS', () => {
	const media = 'application/vnd.git-lfs+json';
	const bytes = new TextEncoder().encode('an uploaded LFS object');
	const object = async () => ({
		oid: Array.from(
			new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
			(byte) => byte.toString(16).padStart(2, '0'),
		).join(''),
		size: bytes.length,
	});
	const batch = (
		url: (path: string) => string,
		as: (
			user: string,
			headers?: Record<string, string>,
		) => Record<string, string>,
		operation: string,
		objects: unknown[],
		user = 'alice',
	) =>
		fetch(url('info/lfs/objects/batch'), {
			method: 'POST',
			headers: as(user, { accept: media, 'content-type': media }),
			body: JSON.stringify({
				operation,
				transfers: ['basic'],
				hash_algo: 'sha256',
				objects,
			}),
		});

	test('batch, upload and download stream verified bytes and record presence only afterward', async () => {
		const { url, as, server } = setup();
		const item = await object();
		expect(server.uploaded(item.oid)).toBeNull();
		expect(
			server.push(
				make(server, [{ path: 'media/a.bin', text: writePointer(item) }]),
				{ user: 'alice', role: 'writer' },
			),
		).toMatchObject({ kind: 'refused', code: 'blob-missing' });
		const offered = await batch(url, as, 'upload', [item]);
		expect(offered.status).toBe(200);
		expect(offered.headers.get('content-type')).toContain(media);
		const action = (await offered.json()).objects[0].actions.upload;
		expect(action.href).toBe(url(`lfs/objects/${item.oid}`));
		const sent = await fetch(action.href, {
			method: 'PUT',
			headers: as('alice', { 'content-length': String(item.size) }),
			body: bytes,
		});
		expect(sent.status).toBe(200);
		expect(server.uploaded(item.oid)).toBe(item.size);
		expect(
			server.push(
				make(server, [{ path: 'media/a.bin', text: writePointer(item) }]),
				{ user: 'alice', role: 'writer' },
			),
		).toMatchObject({ kind: 'applied' });
		expect(
			(await (await batch(url, as, 'upload', [item])).json()).objects[0]
				.actions,
		).toBeUndefined();
		const download = (
			await (await batch(url, as, 'download', [item], 'rita')).json()
		).objects[0].actions.download;
		const read = await fetch(download.href, { headers: as('rita') });
		expect(read.status).toBe(200);
		expect(read.headers.get('content-length')).toBe(String(item.size));
		expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
	});

	test('PUT without Content-Length is refused before bytes are read', async () => {
		const { url, as, server } = setup();
		const item = await object();
		const status = await new Promise<number>((resolve, reject) => {
			const sent = httpRequest(
				url(`lfs/objects/${item.oid}`),
				{
					method: 'PUT',
					headers: as('alice', { 'transfer-encoding': 'chunked' }),
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			sent.on('error', reject);
			sent.end(bytes);
		});
		expect(status).toBe(411);
		expect(server.uploaded(item.oid)).toBeNull();
	});

	test('a stalled PUT reaches the shared body deadline and stores nothing', async () => {
		const { url, as, server } = setup({
			wire: { timeout: 30, minRate: 1024 * 1024 },
		});
		const item = await object();
		const status = await new Promise<number>((resolve, reject) => {
			const sent = httpRequest(
				url(`lfs/objects/${item.oid}`),
				{
					method: 'PUT',
					headers: as('alice', { 'content-length': String(item.size) }),
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			sent.on('error', reject);
			sent.write(bytes.slice(0, 3));
			setTimeout(() => sent.end(), 100);
		});
		expect(status).toBe(408);
		expect(server.uploaded(item.oid)).toBeNull();
	});

	test('a zero-length object uses the same PUT path', async () => {
		const { url, as, server } = setup();
		const oid =
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
		const response = await fetch(url(`lfs/objects/${oid}`), {
			method: 'PUT',
			headers: as('alice', { 'content-length': '0' }),
			body: new Uint8Array(),
		});
		expect(response.status).toBe(200);
		expect(server.uploaded(oid)).toBe(0);
	});

	test('a mismatch, a reader upload, and missing length do not mark presence', async () => {
		const { url, as, server } = setup();
		const item = await object();
		expect((await batch(url, as, 'upload', [item], 'rita')).status).toBe(403);
		expect(
			(
				await fetch(url(`lfs/objects/${item.oid}`), {
					method: 'PUT',
					headers: as('rita'),
					body: bytes,
				})
			).status,
		).toBe(403);
		const wrong = await fetch(url(`lfs/objects/${item.oid}`), {
			method: 'PUT',
			headers: as('alice', { 'content-length': String(item.size) }),
			body: new Uint8Array(item.size),
		});
		expect(wrong.status).toBe(422);
		expect(server.uploaded(item.oid)).toBeNull();
		expect(
			(await (await batch(url, as, 'download', [item])).json()).objects[0].error
				.code,
		).toBe(404);
	});

	test('too large and quota errors are per object in a mixed batch', async () => {
		const { url, as } = setup({ limits: { blob: bytes.length, quota: 0 } });
		const item = await object();
		const answers = (
			await (
				await batch(url, as, 'upload', [item, { ...item, size: item.size + 1 }])
			).json()
		).objects;
		expect(
			answers.map((answer: { error: { code: number } }) => answer.error.code),
		).toEqual([507, 422]);
	});

	test('a different batch hash algorithm gets the specified per-object 409', async () => {
		const { url, as } = setup();
		const item = await object();
		const response = await fetch(url('info/lfs/objects/batch'), {
			method: 'POST',
			headers: as('alice', { 'content-type': media }),
			body: JSON.stringify({
				operation: 'upload',
				objects: [item],
				hash_algo: 'sha512',
			}),
		});
		expect(response.status).toBe(200);
		expect((await response.json()).objects[0].error.code).toBe(409);
	});

	test('an existing object cannot be recorded at a different declared size', async () => {
		const { url, as, server, lfs } = setup();
		const item = await object();
		unwrap(
			await lfs.put(
				item.oid,
				item.size,
				new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>,
			),
		);
		const wrong = { ...item, size: item.size + 1 };
		const offered = (await (await batch(url, as, 'upload', [wrong])).json())
			.objects[0];
		expect(offered.error.code).toBe(422);
		const sent = await fetch(url(`lfs/objects/${item.oid}`), {
			method: 'PUT',
			headers: as('alice', { 'content-length': String(wrong.size) }),
			body: new Uint8Array(wrong.size),
		});
		expect(sent.status).toBe(422);
		expect(server.uploaded(item.oid)).toBeNull();
	});

	test('the LFS client follows batch action URLs and streams bytes', async () => {
		const { served } = setup();
		const item = await object();
		const writer = createLfsClient({
			url: served.url,
			headers: { authorization: 'Bearer alice' },
		});
		const upload = unwrap(await writer.batch('upload', [item]))[0]?.actions
			?.upload;
		expect(upload).toBeDefined();
		unwrap(await writer.put(upload!, new Blob([bytes as BlobPart])));
		const reader = createLfsClient({
			url: served.url,
			headers: { authorization: 'Bearer rita' },
		});
		const download = unwrap(await reader.batch('download', [item]))[0]?.actions
			?.download;
		expect(download).toBeDefined();
		const body = unwrap(await reader.get(download!));
		expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(
			bytes,
		);
	});

	test('the LFS client exposes per-object refusals and classifies HTTP failures', async () => {
		const { served, url } = setup({ limits: { readBurst: 0 } });
		const item = await object();
		const client = createLfsClient({
			url: served.url,
			headers: { authorization: 'Bearer rita' },
		});
		expect(unwrap(await client.batch('download', [item]))[0]?.error?.code).toBe(
			404,
		);
		expect((await client.batch('upload', [item])).error?.name).toBe('Refused');
		expect(
			(
				await client.get({
					href: url(`lfs/objects/${item.oid}`),
					header: { authorization: 'Bearer rita' },
				})
			).error?.name,
		).toBe('Retryable');
	});
});

/** Poll until `check` holds, in real time. */
async function until(check: () => boolean, ms = 3_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await Bun.sleep(5);
	}
}

// ============================================================================
// Authentication at every endpoint
// ============================================================================

test('every endpoint refuses a request with no session (401) and one from a non-member (403)', async () => {
	const { url, server, as } = setup();
	const hash = gitBlobHash(note('a\n'));
	const requests: [string, RequestInit][] = [
		[
			'commits',
			{
				method: 'POST',
				body: JSON.stringify(
					make(server, [{ path: 'n/a.md', text: note('a\n') }]),
				),
			},
		],
		['files/n/a.md', {}],
		[
			'files/n/a.md',
			{ method: 'PUT', headers: { 'if-none-match': '*' }, body: note('a\n') },
		],
		[
			'files/n/a.md',
			{ method: 'DELETE', headers: { 'if-match': `"${hash}"` } },
		],
		['catch-up?from=', {}],
		[`blobs/${hash}`, {}],
		[
			'socket',
			{
				headers: {
					upgrade: 'websocket',
					connection: 'upgrade',
					'sec-websocket-version': '13',
					'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
				},
			},
		],
	];
	for (const [path, init] of requests) {
		const headers = (init.headers ?? {}) as Record<string, string>;
		const anonymous = await fetch(url(path), init);
		expect([
			path,
			anonymous.status,
			anonymous.headers.get('www-authenticate'),
		]).toEqual([path, 401, 'Bearer']);
		const stranger = await fetch(url(path), {
			...init,
			headers: as('eve', headers),
		});
		expect([path, stranger.status]).toEqual([path, 403]);
		expect(await stranger.json()).toEqual({
			error: 'Not a member of this repository',
		});
	}
	// Nothing reached main.
	expect(server.read('n/a.md')).toBeNull();
});

// ============================================================================
// POST /commits: every answer and its status
// ============================================================================

describe('POST /commits', () => {
	test('applied and merged are 200, with the answer as JSON', async () => {
		const { server, post } = setup();
		const base = server.main();
		const applied = await post(
			make(server, [{ path: 'n/a.md', text: note('one\n') }]),
		);
		expect(applied.status).toBe(200);
		expect(applied.headers.get('cache-control')).toBe('no-store');
		expect(await applied.json()).toMatchObject({
			kind: 'applied',
			main: server.main(),
		});
		const merged = await post(
			make(server, [{ path: 'n/b.md', text: note('two\n') }], {
				user: 'bob',
				parent: base,
			}),
			'bob',
		);
		expect(merged.status).toBe(200);
		expect(await merged.json()).toMatchObject({
			kind: 'merged',
			main: server.main(),
		});
	});

	test('a resend after its answer left the window is 200 flushed; a parent past the window with no record is 409 outcome-unknown', async () => {
		const { server, post, clock } = setup({
			limits: { window: 1_000, seen: 1_000_000 },
		});
		const commit = make(server, [{ path: 'n/a.md', text: note('one\n') }]);
		const stale = make(server, [{ path: 'n/b.md', text: note('two\n') }], {
			time: new Date(EPOCH - 1).toISOString(),
		});
		expect((await post(commit)).status).toBe(200);
		await server.flush();
		clock.now += 5_000;
		// Something else lands, so the window moves past the old parent.
		expect(
			(await post(make(server, [{ path: 'n/c.md', text: note('three\n') }])))
				.status,
		).toBe(200);
		const flushed = await post(commit);
		expect([flushed.status, (await flushed.json()).kind]).toEqual([
			200,
			'flushed',
		]);
		const unknown = await post(stale);
		expect([unknown.status, (await unknown.json()).kind]).toEqual([
			409,
			'outcome-unknown',
		]);
	});

	test('a commit with no parent is 428', async () => {
		const { server, post } = setup();
		const { parent: _, ...orphan } = make(server, [
			{ path: 'n/a.md', text: note('a\n') },
		]);
		const response = await post(orphan);
		expect(response.status).toBe(428);
		expect(await response.json()).toMatchObject({
			kind: 'rejected',
			code: 'no-parent',
			reason: 'no parent',
		});
	});

	test('a commit on a stale parent is 200 merged', async () => {
		const { server, post } = setup();
		const base = server.main();
		await post(make(server, [{ path: 'n/a.md', text: note('one\n') }]));
		const response = await post(
			make(server, [{ path: 'n/b.md', text: note('two\n') }], { parent: base }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			kind: 'merged',
			main: server.main(),
		});
		expect([server.read('n/a.md'), server.read('n/b.md')]).toEqual([
			note('one\n'),
			note('two\n'),
		]);
	});

	test('past the rate is 429 with Retry-After', async () => {
		const { server, post } = setup({ limits: { burst: 1, rate: 0.001 } });
		expect(
			(await post(make(server, [{ path: 'n/a.md', text: note('a\n') }])))
				.status,
		).toBe(200);
		const response = await post(
			make(server, [{ path: 'n/b.md', text: note('b\n') }]),
		);
		expect([response.status, response.headers.get('retry-after')]).toEqual([
			429,
			'1',
		]);
		expect(await response.json()).toMatchObject({
			kind: 'rejected',
			code: 'rate',
			reason: 'rate',
		});
	});

	test('a reader, or a commit by another author, is 403', async () => {
		const { server, post } = setup();
		const reader = await post(
			make(server, [{ path: 'n/a.md', text: note('a\n') }], { user: 'rita' }),
			'rita',
		);
		expect([reader.status, (await reader.json()).reason]).toEqual([
			403,
			'a reader may not write',
		]);
		const forged = await post(
			make(server, [{ path: 'n/a.md', text: note('a\n') }], { user: 'bob' }),
		);
		expect([forged.status, (await forged.json()).reason]).toEqual([
			403,
			'the author is not the session',
		]);
	});

	test('a note the door refuses is 422, naming the path', async () => {
		const { server, post } = setup();
		const response = await post(
			make(server, [{ path: 'n/a.md', text: '---\r\ntitle: A\r\n---\r\n' }]),
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			kind: 'refused',
			path: 'n/a.md',
		});
	});

	test('a body that is not a live commit is 400; a route or method that does not exist is 404 or 405', async () => {
		const { server, post, url, as } = setup();
		expect((await post('{not json')).status).toBe(400);
		expect((await post({ ...make(server, []), extra: true })).status).toBe(400);
		const wrong = await fetch(url('commits'), { headers: as('alice') });
		expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'POST']);
		expect((await fetch(url('nowhere'), { headers: as('alice') })).status).toBe(
			404,
		);
	});
});

// ============================================================================
// Limits at the wire
// ============================================================================

describe('limits', () => {
	test('a body over the cap is 413 before it is parsed, by its Content-Length or as it streams', async () => {
		const { server, url, as, post } = setup({ wire: { body: 1_000 } });
		const big = make(server, [
			{ path: 'n/a.md', text: note('x'.repeat(2_000)) },
		]);
		const declared = await post(big);
		expect(declared.status).toBe(413);
		expect(await declared.json()).toMatchObject({
			kind: 'rejected',
			code: 'too-large',
			reason: 'request too large',
			main: server.main(),
		});
		// No Content-Length: the body is counted as it arrives.
		const bytes = new TextEncoder().encode(JSON.stringify(big));
		const stream = new ReadableStream({
			start(controller) {
				for (let at = 0; at < bytes.length; at += 100)
					controller.enqueue(bytes.slice(at, at + 100));
				controller.close();
			},
		});
		const streamed = await fetch(url('commits'), {
			method: 'POST',
			headers: as('alice', { 'content-type': 'application/json' }),
			body: stream,
		});
		expect(streamed.status).toBe(413);
		expect(server.read('n/a.md')).toBeNull();
	});

	test('a body not read within the timeout is 408', async () => {
		const { url, as } = setup({ wire: { timeout: 100 } });
		const stalled = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"id":'));
			},
		});
		const response = await fetch(url('commits'), {
			method: 'POST',
			headers: as('alice', { 'content-type': 'application/json' }),
			body: stalled,
		});
		expect(response.status).toBe(408);
	});
});

// ============================================================================
// PUT and DELETE: one file, conditional on its hash
// ============================================================================

describe('PUT and DELETE /files/<path>', () => {
	test('a write with no precondition is 428; If-None-Match: * creates; If-Match updates and deletes; the ETag is the Git blob hash', async () => {
		const { server, url, as } = setup();
		const put = (text: string, headers: Record<string, string>) =>
			fetch(url('files/notes/a%20b.md'), {
				method: 'PUT',
				headers: as('alice', headers),
				body: text,
			});
		const blind = await put(note('one\n'), {});
		expect([blind.status, (await blind.json()).reason]).toEqual([
			428,
			'no precondition',
		]);

		const created = await put(note('one\n'), {
			'if-none-match': '*',
			'epicenter-device': 'curl',
		});
		expect([created.status, created.headers.get('etag')]).toEqual([
			200,
			`"${gitBlobHash(note('one\n'))}"`,
		]);
		expect(server.read('notes/a b.md')).toBe(note('one\n'));

		const read = await fetch(url('files/notes/a%20b.md'), {
			headers: as('rita'),
		});
		expect([read.status, read.headers.get('etag'), await read.text()]).toEqual([
			200,
			`"${gitBlobHash(note('one\n'))}"`,
			note('one\n'),
		]);
		const unchanged = await fetch(url('files/notes/a%20b.md'), {
			headers: as('rita', {
				'if-none-match': `"${gitBlobHash(note('one\n'))}"`,
			}),
		});
		expect(unchanged.status).toBe(304);

		const updated = await put(note('two\n'), {
			'if-match': `"${gitBlobHash(note('one\n'))}"`,
		});
		expect(updated.status).toBe(200);
		expect(server.read('notes/a b.md')).toBe(note('two\n'));

		const removed = await fetch(url('files/notes/a%20b.md'), {
			method: 'DELETE',
			headers: as('alice', { 'if-match': `"${gitBlobHash(note('two\n'))}"` }),
		});
		expect(removed.status).toBe(200);
		expect(
			(await fetch(url('files/notes/a%20b.md'), { headers: as('alice') }))
				.status,
		).toBe(404);
	});

	test('a GET names the commit it read, so a one-shot client posts a commit on it and merges with what landed since', async () => {
		const { server, url, as, post } = setup();
		await fetch(url('files/n/a.md'), {
			method: 'PUT',
			headers: as('alice', { 'if-none-match': '*' }),
			body: note('one\ntwo\n'),
		});
		const read = await fetch(url('files/n/a.md'), { headers: as('bob') });
		const parent = read.headers.get('epicenter-commit');
		expect(parent).toBe(server.main());
		const unchanged = await fetch(url('files/n/a.md'), {
			headers: as('bob', {
				'if-none-match': `"${gitBlobHash(note('one\ntwo\n'))}"`,
			}),
		});
		expect([
			unchanged.status,
			unchanged.headers.get('epicenter-commit'),
		]).toEqual([304, parent]);
		// Someone else's edit lands; the one-shot client's commit on what it read merges with it, where a PUT on its ETag would be 412.
		await fetch(url('files/n/a.md'), {
			method: 'PUT',
			headers: as('alice', {
				'if-match': `"${gitBlobHash(note('one\ntwo\n'))}"`,
			}),
			body: note('zero\none\ntwo\n'),
		});
		const response = await post(
			make(server, [{ path: 'n/a.md', text: note('one\ntwo\nbob\n') }], {
				user: 'bob',
				parent: parent ?? '',
			}),
			'bob',
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ kind: 'merged' });
		expect(server.read('n/a.md')).toBe(note('zero\none\ntwo\nbob\n'));
	});

	test("a stale If-Match, or If-None-Match: * on an existing file, is 412 with the file's current text", async () => {
		const { server, url, as } = setup();
		await fetch(url('files/n/a.md'), {
			method: 'PUT',
			headers: as('alice', { 'if-none-match': '*' }),
			body: note('one\n'),
		});
		const main = server.main();
		const current = {
			path: 'n/a.md',
			text: note('one\n'),
			hash: gitBlobHash(note('one\n')),
		};
		const stale = await fetch(url('files/n/a.md'), {
			method: 'PUT',
			headers: as('bob', { 'if-match': `"${gitBlobHash(note('zero\n'))}"` }),
			body: note('two\n'),
		});
		expect(stale.status).toBe(412);
		expect(await stale.json()).toEqual({
			kind: 'rejected',
			code: 'file-moved',
			reason: 'the file moved',
			main,
			files: [current],
		});
		const again = await fetch(url('files/n/a.md'), {
			method: 'PUT',
			headers: as('bob', { 'if-none-match': '*' }),
			body: note('two\n'),
		});
		expect(again.status).toBe(412);
		const deleted = await fetch(url('files/n/a.md'), {
			method: 'DELETE',
			headers: as('bob', {
				'if-match': '"0000000000000000000000000000000000000000"',
			}),
		});
		expect(deleted.status).toBe(412);
		expect(server.main()).toBe(main);
	});

	test("a path's other spelling is the same file: its read, its ETag and its create-if-absent see the file main has", async () => {
		const { server, url, as } = setup();
		await fetch(url('files/notes/a.md'), {
			method: 'PUT',
			headers: as('alice', { 'if-none-match': '*' }),
			body: note('alice\n'),
		});
		const read = await fetch(url('files/Notes/A.md'), { headers: as('bob') });
		expect([read.status, await read.text()]).toEqual([200, note('alice\n')]);
		const create = await fetch(url('files/Notes/A.md'), {
			method: 'PUT',
			headers: as('bob', { 'if-none-match': '*' }),
			body: note('bob\n'),
		});
		expect(create.status).toBe(412);
		expect(await create.json()).toMatchObject({
			kind: 'rejected',
			code: 'file-moved',
			reason: 'the file moved',
			files: [{ path: 'notes/a.md', text: note('alice\n') }],
		});
		expect(server.read('notes/a.md')).toBe(note('alice\n'));
		const update = await fetch(url('files/Notes/A.md'), {
			method: 'PUT',
			headers: as('bob', { 'if-match': `"${gitBlobHash(note('alice\n'))}"` }),
			body: note('bob\n'),
		});
		expect(update.status).toBe(200);
		expect(server.read('notes/a.md')).toBe(note('bob\n'));
	});

	test('a reader may read a file but not write one (403)', async () => {
		const { url, as } = setup();
		const response = await fetch(url('files/n/a.md'), {
			method: 'PUT',
			headers: as('rita', { 'if-none-match': '*' }),
			body: note('a\n'),
		});
		expect(response.status).toBe(403);
	});
});

// ============================================================================
// Reads: catch-up and texts by hash
// ============================================================================

describe('reads', () => {
	test("reads come out of the member's read bucket: past it, 429 over HTTP and an error naming the request on the socket", async () => {
		const { url, as, served } = setup({
			limits: { readBurst: 2, readRate: 0.001 },
		});
		const statuses = [];
		for (let i = 0; i < 3; i++)
			statuses.push(
				(await fetch(url('catch-up?from='), { headers: as('alice') })).status,
			);
		expect(statuses).toEqual([200, 200, 429]);
		const slowed = await fetch(url('files/n/a.md'), { headers: as('alice') });
		expect([slowed.status, slowed.headers.get('retry-after')]).toEqual([
			429,
			'1',
		]);
		// Another member's reads are their own.
		expect(
			(await fetch(url('catch-up?from='), { headers: as('bob') })).status,
		).toBe(200);
		const alice = open(served.url, 'alice');
		await until(() => alice.messages.length === 1);
		alice.socket.send({ type: 'catch-up', rid: 4, from: null });
		await alice.socket.ping();
		expect(alice.messages.at(-1)).toEqual({
			type: 'error',
			rid: 4,
			status: 429,
			error: 'Too many reads; slow down',
		});
	});

	test('a text by hash is immutable and private, revalidates as 304, and an unknown hash is 404 and not cached', async () => {
		const { server, url, as, post } = setup();
		await post(make(server, [{ path: 'n/a.md', text: note('one\n') }]));
		const hash = gitBlobHash(note('one\n'));
		const response = await fetch(url(`blobs/${hash}`), { headers: as('rita') });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe(
			'private, max-age=31536000, immutable',
		);
		expect(response.headers.get('etag')).toBe(`"${hash}"`);
		expect(await response.text()).toBe(note('one\n'));
		const again = await fetch(url(`blobs/${hash}`), {
			headers: as('rita', { 'if-none-match': `"${hash}"` }),
		});
		expect([again.status, again.headers.get('cache-control')]).toEqual([
			304,
			'private, max-age=31536000, immutable',
		]);
		const missing = await fetch(url(`blobs/${'0'.repeat(40)}`), {
			headers: as('rita'),
		});
		expect([missing.status, missing.headers.get('cache-control')]).toEqual([
			404,
			'no-store',
		]);
		expect(
			(await fetch(url('blobs/not-a-hash'), { headers: as('rita') })).status,
		).toBe(404);
	});

	test('a catch-up page is the server catch-up, not cached', async () => {
		const { server, url, as, post } = setup({ limits: { page: 1 } });
		const base = server.main();
		await post(
			make(server, [
				{ path: 'n/a.md', text: note('a\n') },
				{ path: 'n/b.md', text: note('b\n') },
			]),
		);
		const first = await fetch(url(`catch-up?from=${base}`), {
			headers: as('rita'),
		});
		expect(first.headers.get('cache-control')).toBe('no-store');
		const page = await first.json();
		expect(page).toEqual(server.catchUp({ from: base }));
		const next = await fetch(
			url(`catch-up?from=${base}&to=${page.main}&after=${page.next}`),
			{ headers: as('rita') },
		);
		expect(await next.json()).toEqual(
			server.catchUp({ from: base, to: page.main, after: page.next }),
		);
	});

	test('a request without a WebSocket upgrade to the socket is 426', async () => {
		const { url, as } = setup();
		expect((await fetch(url('socket'), { headers: as('alice') })).status).toBe(
			426,
		);
	});
});

// ============================================================================
// The device's socket
// ============================================================================

/** Open a socket as `user`, keeping every message it gets. */
function open(base: string, user: string) {
	const client = createWireClient({
		url: base,
		openSocket: socketWithHeaders({ authorization: `Bearer ${user}` }),
	});
	const messages: SocketMessage[] = [];
	const closed: number[] = [];
	const socket = client.socket({
		message: (message) => messages.push(message),
		closed: (code) => closed.push(code),
	});
	stops.push(async () => socket.close());
	return { socket, messages, closed };
}

describe("the device's socket", () => {
	test('a socket is told main when it opens; a push on it is answered before its own event, and every socket gets the event in order', async () => {
		const { server, served } = setup();
		const alice = open(served.url, 'alice');
		const rita = open(served.url, 'rita');
		await until(
			() => alice.messages.length === 1 && rita.messages.length === 1,
		);
		const base = server.main();
		expect(rita.messages[0]).toEqual({
			type: 'head',
			main: base,
			repository: 'test',
			server: 'test-server',
			user: 'rita',
			limits: {
				request: LIMITS.request,
				files: LIMITS.files,
				blob: LIMITS.blob,
			},
		});
		const commit = make(server, [{ path: 'n/a.md', text: note('one\n') }]);
		alice.socket.send({ type: 'push', rid: 7, commit });
		await alice.socket.ping();
		await rita.socket.ping();
		const event = {
			type: 'commit' as const,
			commit: commit.id,
			parents: [base],
			files: [{ path: 'n/a.md', hash: gitBlobHash(note('one\n')) }],
		};
		expect(alice.messages.slice(1)).toEqual([
			{
				type: 'answer',
				rid: 7,
				status: 200,
				answer: expect.objectContaining({ kind: 'applied', main: commit.id }),
			},
			event,
		]);
		// Events name paths and hashes, never texts.
		expect(rita.messages.slice(1)).toEqual([event]);
	});

	test('the socket and HTTP take a commit and a catch-up through the same functions, with the same statuses', async () => {
		const { server, served, post } = setup();
		const alice = open(served.url, 'alice');
		const rita = open(served.url, 'rita');
		await until(
			() => alice.messages.length === 1 && rita.messages.length === 1,
		);
		const base = server.main();
		await post(make(server, [{ path: 'n/a.md', text: note('one\n') }]));
		alice.socket.send({
			type: 'push',
			rid: 1,
			commit: make(server, [{ path: 'n/z.md', text: note('two\n') }], {
				parent: base,
			}),
		});
		rita.socket.send({
			type: 'push',
			rid: 2,
			commit: make(server, [{ path: 'n/b.md', text: note('b\n') }], {
				user: 'rita',
			}),
		});
		alice.socket.send({
			type: 'push',
			rid: 3,
			commit: make(server, [
				{ path: 'n/c.md', text: '---\r\ntitle: C\r\n---\r\n' },
			]),
		});
		alice.socket.send({ type: 'catch-up', rid: 4, from: base });
		await alice.socket.ping();
		await rita.socket.ping();
		const replies = alice.messages.filter(
			(m) => m.type === 'answer' || m.type === 'caught-up',
		);
		expect(replies).toEqual([
			{
				type: 'answer',
				rid: 1,
				status: 200,
				answer: expect.objectContaining({ kind: 'merged' }),
			},
			{
				type: 'answer',
				rid: 3,
				status: 422,
				answer: expect.objectContaining({ kind: 'refused', path: 'n/c.md' }),
			},
			{ type: 'caught-up', rid: 4, catchUp: server.catchUp({ from: base }) },
		]);
		expect(rita.messages.at(-1)).toEqual({
			type: 'answer',
			rid: 2,
			status: 403,
			answer: expect.objectContaining({ reason: 'a reader may not write' }),
		});
	});

	test('a message that is not a request is an error; one past the body limit is refused unread, naming its request id', async () => {
		const { server, served } = setup({ wire: { body: 1_000 } });
		const alice = open(served.url, 'alice');
		await until(() => alice.messages.length === 1);
		alice.socket.send({
			type: 'push',
			rid: 9,
			commit: make(server, [{ path: 'n/a.md', text: note('x'.repeat(2_000)) }]),
		});
		alice.socket.send({ type: 'nonsense', rid: 10 } as never);
		await alice.socket.ping();
		expect(alice.messages.slice(1)).toEqual([
			{
				type: 'answer',
				rid: 9,
				status: 413,
				answer: {
					kind: 'rejected',
					code: 'too-large',
					reason: 'request too large',
					main: server.main(),
				},
			},
			{ type: 'error', rid: null, status: 400, error: 'Not a socket request' },
		]);
		expect(server.read('n/a.md')).toBeNull();
	});

	test('the server closes a socket when its session expires (4401); an expired session is refused at the door (401)', async () => {
		const { served, url } = setup({
			authenticate: authenticateBearer((token) => {
				if (token === 'brief')
					return { user: 'alice', role: 'writer', expires: Date.now() + 150 };
				if (token === 'gone')
					return { user: 'alice', role: 'writer', expires: Date.now() - 1 };
				return null;
			}),
		});
		const brief = open(served.url, 'brief');
		await until(() => brief.messages.length === 1);
		await until(() => brief.closed.length === 1);
		expect(brief.closed).toEqual([4401]);
		expect(
			(
				await fetch(url('catch-up?from='), {
					headers: { authorization: 'Bearer gone' },
				})
			).status,
		).toBe(401);
		const gone = open(served.url, 'gone');
		await until(() => gone.closed.length === 1);
		expect(gone.messages).toEqual([]);
	});

	test('a replica whose socket dropped resumes from its last head by catching up, and syncs through the wire', async () => {
		const { served, clock } = setup();
		const sockets: WebSocket[] = [];
		const replicas: Replica[] = [];
		const connect = (user: string) => {
			const client = createWireClient({
				url: served.url,
				headers: { authorization: `Bearer ${user}` },
				openSocket: (url) => {
					const socket = socketWithHeaders({ authorization: `Bearer ${user}` })(
						url,
					);
					if (user === 'bob') sockets.push(socket);
					return socket;
				},
			});
			const replica = unwrap(
				openReplica({
					driver: openBunSqlite(),
					binding: { repository: 'test', server: 'test-server', account: user },
					device: user,
					after: (ms, run) => setTimeout(run, ms),
					now: () => clock.now,
					timeout: 1_000,
					quiet: 0,
				}),
			);
			stops.push(async () => connection.close());
			const connection = connectSocket(replica, client, { retry: 50 });
			replicas.push(replica);
			return replica;
		};
		const alice = connect('alice');
		const bob = connect('bob');
		await until(
			() =>
				alice.position() !== null &&
				bob.position() !== null &&
				sockets[0]?.readyState === WebSocket.OPEN,
		);

		alice.write('n/a.md', note('one\n'));
		await until(() => bob.read('n/a.md') === note('one\n'));
		const caughtUp = bob.stats().catchUps;

		// Bob's socket drops; alice writes while it is down; bob learns of it only by resuming.
		sockets[0]?.close();
		await until(() => sockets[0]?.readyState === WebSocket.CLOSED);
		alice.write('n/a.md', note('one\ntwo\n'));
		await until(() => !alice.busy());
		await until(() => bob.read('n/a.md') === note('one\ntwo\n'));
		expect(sockets.length).toBe(2);
		expect(bob.stats().catchUps).toBe(caughtUp + 1);
		expect(bob.position()).toBe(alice.position());

		// Over the reopened socket, the next write arrives as an event again.
		bob.write('n/b.md', note('b\n'));
		await until(() => alice.read('n/b.md') === note('b\n'));
		expect(replicas.every((replica) => !replica.busy())).toBe(true);
	});
});

// ============================================================================
// Socket tickets, for a client that cannot set a WebSocket's headers
// ============================================================================

describe('socket tickets', () => {
	/** Open a socket the way a browser does: no headers, only the ticket in its URL. */
	function openWithTicket(
		base: string,
		ticket: string,
		headers: Record<string, string> = {},
	) {
		const target = new URL('socket', base);
		target.protocol = 'ws:';
		target.searchParams.set('ticket', ticket);
		const socket =
			Object.keys(headers).length === 0
				? new WebSocket(target.href)
				: socketWithHeaders(headers)(target.href);
		const messages: SocketMessage[] = [];
		const closed: number[] = [];
		const opened = new Promise<boolean>((resolve) => {
			socket.onopen = () => resolve(true);
			socket.onerror = () => resolve(false);
		});
		socket.onmessage = (event) =>
			messages.push(JSON.parse(String(event.data)) as SocketMessage);
		socket.onclose = (event) => closed.push(event.code);
		stops.push(async () => socket.close());
		return { socket, messages, closed, opened };
	}

	async function issue(
		url: (path: string) => string,
		as: (user: string) => Record<string, string>,
		user: string,
	) {
		const response = await fetch(url('tickets'), {
			method: 'POST',
			headers: as(user),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		return (await response.json()) as { ticket: string; expires: number };
	}

	test("a ticket asked for with a session opens one socket as that session, which is told main and the session's user", async () => {
		const { served, server, url, as } = setup();
		expect((await fetch(url('tickets'), { method: 'POST' })).status).toBe(401);
		expect(
			(await fetch(url('tickets'), { method: 'POST', headers: as('eve') }))
				.status,
		).toBe(403);
		const before = Date.now();
		const { ticket, expires } = await issue(url, as, 'bob');
		expect(ticket).toMatch(/^[0-9a-f]{64}$/);
		expect(expires - before).toBeGreaterThanOrEqual(30_000);
		expect(expires - Date.now()).toBeLessThanOrEqual(30_000);

		const socket = openWithTicket(served.url, ticket);
		expect(await socket.opened).toBe(true);
		await until(() => socket.messages.length === 1);
		expect(socket.messages[0]).toMatchObject({
			type: 'head',
			main: server.main(),
			repository: 'test',
			server: 'test-server',
			user: 'bob',
		});
	});

	test("a ticket is refused once used, once expired, and with another account's credential, and is spent by the refusal", async () => {
		const { served, url, as } = setup({ wire: { ticket: 100 } });
		// Reused: the first socket spends it.
		const reused = await issue(url, as, 'alice');
		expect(await openWithTicket(served.url, reused.ticket).opened).toBe(true);
		expect(await openWithTicket(served.url, reused.ticket).opened).toBe(false);
		const refused = await fetch(url(`socket?ticket=${reused.ticket}`), {
			headers: { upgrade: 'websocket' },
		});
		expect(refused.status).toBe(401);
		expect((await refused.json()).error).toContain('unknown or already used');

		// Expired: presented after its window.
		const late = await issue(url, as, 'alice');
		await Bun.sleep(150);
		const expired = await fetch(url(`socket?ticket=${late.ticket}`), {
			headers: { upgrade: 'websocket' },
		});
		expect(expired.status).toBe(401);
		expect((await expired.json()).error).toContain('expired');

		// Another account's session: alice's ticket presented with bob's credential.
		const stolen = await issue(url, as, 'alice');
		const wrong = await fetch(url(`socket?ticket=${stolen.ticket}`), {
			headers: { upgrade: 'websocket', ...as('bob') },
		});
		expect(wrong.status).toBe(401);
		expect((await wrong.json()).error).toContain("another account's session");
		// The refusal spent it: even its own session cannot use it now.
		expect(
			await openWithTicket(served.url, stolen.ticket, as('alice')).opened,
		).toBe(false);
	});

	test('a ticket outlives neither the session it was issued for, nor works anywhere but the socket', async () => {
		const expires = Date.now() + 150;
		const { url, as } = setup({
			authenticate: authenticateBearer((token) =>
				token === 'alice' ? { user: 'alice', role: 'writer', expires } : null,
			),
		});
		const { ticket } = await issue(url, as, 'alice');
		expect((await fetch(url(`catch-up?from=&ticket=${ticket}`))).status).toBe(
			401,
		);
		// The session ends before its ticket is presented.
		await Bun.sleep(200);
		const second = await fetch(url('tickets'), {
			method: 'POST',
			headers: as('alice'),
		});
		expect(second.status).toBe(401);
		const refused = await fetch(url(`socket?ticket=${ticket}`), {
			headers: { upgrade: 'websocket' },
		});
		expect(refused.status).toBe(401);
		expect((await refused.json()).error).toContain(
			'session behind this ticket has expired',
		);
	});

	test('a wire client with tickets syncs a replica over a socket that carries no headers', async () => {
		const { served, server } = setup();
		const client = createWireClient({
			url: served.url,
			headers: { authorization: 'Bearer alice' },
			tickets: true,
		});
		const replica = unwrap(
			openReplica({
				driver: openBunSqlite(),
				binding: {
					repository: 'test',
					server: 'test-server',
					account: 'alice',
				},
				device: 'laptop',
				after: (ms, run) => setTimeout(run, ms),
				now: () => EPOCH,
				quiet: 0,
			}),
		);
		const connection = connectSocket(replica, client, { retry: 50 });
		stops.push(async () => connection.close());
		await until(() => replica.position() !== null);
		replica.write('n/a.md', note('one\n'));
		await until(() => !replica.busy());
		expect(server.read('n/a.md')).toBe(note('one\n'));
	});
});

// ============================================================================
// The dev server across origins
// ============================================================================

test("the dev server answers a listed origin's preflight and marks its responses readable there, and no other origin's", async () => {
	const server = createServer({
		store: openBunSqlite(),
		git: createMemoryGitStore(),
		clock: () => EPOCH,
	});
	const served = serveRepository({
		repository: 'test',
		serverId: 'test-server',
		server,
		authenticate: authenticateBearer((token) => SESSIONS[token] ?? null),
		origins: ['http://app.test'],
	});
	stops.push(served.stop);
	const preflight = await fetch(new URL('tickets', served.url), {
		method: 'OPTIONS',
		headers: {
			origin: 'http://app.test',
			'access-control-request-method': 'POST',
			'access-control-request-headers': 'authorization',
		},
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get('access-control-allow-origin')).toBe(
		'http://app.test',
	);
	expect(preflight.headers.get('access-control-allow-headers')).toContain(
		'authorization',
	);
	expect(preflight.headers.get('access-control-allow-headers')).toContain(
		'content-length',
	);
	const listed = await fetch(new URL('tickets', served.url), {
		method: 'POST',
		headers: { origin: 'http://app.test', authorization: 'Bearer alice' },
	});
	expect(listed.status).toBe(200);
	expect(listed.headers.get('access-control-allow-origin')).toBe(
		'http://app.test',
	);
	expect(listed.headers.get('access-control-expose-headers')).toContain('etag');
	expect(listed.headers.get('access-control-expose-headers')).toContain(
		'content-length',
	);
	const other = await fetch(new URL('tickets', served.url), {
		method: 'POST',
		headers: { origin: 'http://elsewhere.test', authorization: 'Bearer alice' },
	});
	expect(other.headers.get('access-control-allow-origin')).toBeNull();
});
