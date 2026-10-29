/**
 * Upload Track and Read Tests
 *
 * A replica on a real server over HTTP and its socket, a memory blob store,
 * the upload track and the page's blob calls (`serveBytes`): the bytes go
 * through the Git LFS routes, never in a commit.
 *
 * Key behaviors:
 * - A put seals, stores the pointer, and the track uploads the bytes; the pointer lands only after the server holds them
 * - Bytes the server already holds are not sent again
 * - Bytes on neither this device nor the server are refused with why, and so are bytes past the blob limit or the quota
 * - A failed PUT goes again after a wait, and a new track (a new worker) starts again from the sealed bytes
 * - A create where a file is, or a replace where none is, is refused before anything is sealed; so are bytes past the server's limit
 * - Another device opens the bytes: fetched once, verified, then read from its own store; a path with no blob is Missing, an unreachable server Unavailable
 */
import { afterEach, expect, test } from 'bun:test';
import { unwrap } from 'wellcrafted/result';
import { openBunSqlite } from '../bun/sqlite.js';
import { serveRepository, socketWithHeaders } from '../bun/serve.js';
import { writePointer } from '../core/markdown.js';
import { createMemoryGitStore } from '../server/memory-git.js';
import { createMemoryLfsStore } from '../server/memory-lfs-store.js';
import { createServer, type Limits, type Session } from '../server/server.js';
import { createLfsClient, createWireClient, type LfsClient, LfsClientError } from '../wire/client.js';
import { authenticateBearer } from '../wire/wire.js';
import { createMemoryBlobStore } from './blobs.js';
import { bytesOf, oidOf } from './blobs.checks.js';
import { serveBytes } from './bytes.js';
import { openReplica } from './replica.js';
import { connectSocket } from './socket.js';
import { startUploads, UPLOAD_REFUSALS } from './uploads.js';

const SESSIONS: Record<string, Session> = { alice: { user: 'alice', role: 'writer' }, bob: { user: 'bob', role: 'writer' } };
const stops: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop();
});

/** Wait until `holds`, polling; throws after two seconds. */
async function until(holds: () => boolean | Promise<boolean>) {
	for (let tries = 0; tries < 200; tries++) {
		if (await holds()) return;
		await Bun.sleep(10);
	}
	throw new Error('never held');
}

function setup(limits: Partial<Limits> = {}) {
	const server = createServer({ store: openBunSqlite(), git: createMemoryGitStore(), limits });
	const bytes = createMemoryLfsStore();
	const served = serveRepository({ repository: 'r', serverId: 's', server, lfs: bytes, authenticate: authenticateBearer((token) => SESSIONS[token] ?? null) });
	stops.push(served.stop);
	/** A device of `user`: its replica on the socket, its store, its track, its blob calls. */
	function device(user: string, { lfs: wrap = (client: LfsClient) => client }: { lfs?: (client: LfsClient) => LfsClient } = {}) {
		const headers = { authorization: `Bearer ${user}` };
		const driver = openBunSqlite();
		const open = () => unwrap(openReplica({ driver, binding: { repository: 'r', server: null, account: user }, device: user, after: (ms, run) => void setTimeout(run, ms), now: () => Date.now() }));
		let replica = open();
		const socket = connectSocket(replica, createWireClient({ url: served.url, headers, openSocket: socketWithHeaders(headers) }));
		const store = createMemoryBlobStore();
		const lfs = wrap(createLfsClient({ url: served.url, headers }));
		let uploads = startUploads({ replica, store, lfs, retry: 20 });
		const stopWatching = replica.watch(() => uploads.kick());
		stops.push(() => {
			stopWatching();
			uploads.stop();
			socket.close();
			replica.close();
		});
		return {
			get replica() {
				return replica;
			},
			store,
			get uploads() {
				return uploads;
			},
			bytes: () => serveBytes({ replica, store, lfs }),
			/** A new worker over the same database and store: the track starts again. */
			restart() {
				uploads.stop();
				replica.close();
				replica = open();
				uploads = startUploads({ replica, store, lfs, retry: 20 });
			},
		};
	}
	return { server, bytes, served, device };
}

const PATH = 'recordings/r1.webm';
const blobOf = (seed: number, size = 300_000) => new Blob([bytesOf(size, seed) as BlobPart]);

test('a put seals and stores the pointer; the track uploads the bytes, and only then does the pointer land', async () => {
	const { server, device } = setup();
	const alice = device('alice');
	const put = unwrap(await alice.bytes().put(PATH, blobOf(1), { replace: false }));
	expect(put.oid).toBe(await oidOf(bytesOf(300_000, 1)));
	expect(alice.replica.read(PATH)).toBe(writePointer(put));
	await until(() => server.read(PATH) !== null);
	expect(server.uploaded(put.oid)).toBe(put.size);
	expect(alice.replica.state(PATH)).toEqual({ status: 'synced' });
});

test('bytes the server already holds are not sent again', async () => {
	const { server, device } = setup();
	let puts = 0;
	const counting = (client: LfsClient): LfsClient => ({ ...client, put: (action, body) => (puts++, client.put(action, body)) });
	const alice = device('alice', { lfs: counting });
	const bob = device('bob', { lfs: counting });
	unwrap(await alice.bytes().put(PATH, blobOf(2), { replace: false }));
	await until(() => server.read(PATH) !== null);
	await until(() => bob.replica.read(PATH) !== null);
	unwrap(await bob.bytes().put('recordings/copy.webm', blobOf(2), { replace: false }));
	await until(() => server.read('recordings/copy.webm') !== null);
	expect(puts).toBe(1);
});

test('bytes on neither this device nor the server, or past the limit or the quota, are refused with why', async () => {
	const { device } = setup({ quota: 500_000 });
	const alice = device('alice');
	const nowhere = { oid: 'f'.repeat(64), size: 10 };
	alice.replica.write('recordings/nowhere.webm', writePointer(nowhere));
	await until(() => alice.replica.state('recordings/nowhere.webm').status === 'held');
	expect(alice.replica.state('recordings/nowhere.webm')).toEqual({ status: 'held', reason: UPLOAD_REFUSALS.missing });
	unwrap(await alice.bytes().put('recordings/a.webm', blobOf(3), { replace: false }));
	unwrap(await alice.bytes().put('recordings/b.webm', blobOf(4), { replace: false }));
	await until(() => alice.replica.state('recordings/b.webm').status !== 'sending' || alice.replica.state('recordings/a.webm').status !== 'sending');
	await until(() => alice.replica.owed().length === 0);
	const states = ['recordings/a.webm', 'recordings/b.webm'].map((path) => alice.replica.state(path));
	expect(states).toContainEqual({ status: 'held', reason: UPLOAD_REFUSALS[507] });
	expect(states).toContainEqual({ status: 'synced' });
});

test('a failed PUT goes again after a wait, and a new track starts again from the sealed bytes', async () => {
	const { server, device } = setup();
	let failures = 2;
	const flaky = (client: LfsClient): LfsClient => ({ ...client, put: async (action, body) => (failures-- > 0 ? LfsClientError.Network({ cause: new Error('offline') }) : client.put(action, body)) });
	const alice = device('alice', { lfs: flaky });
	unwrap(await alice.bytes().put(PATH, blobOf(5), { replace: false }));
	await until(() => server.read(PATH) !== null);
	expect(failures).toBeLessThan(0);
	// A worker closed with bytes owed: the next one sends them.
	alice.uploads.stop();
	unwrap(await alice.bytes().put('recordings/r2.webm', blobOf(6), { replace: false }));
	expect(alice.replica.owed()).toHaveLength(1);
	alice.restart();
	await until(() => alice.replica.owed().length === 0);
	expect(server.uploaded((await oidOf(bytesOf(300_000, 6))))).toBe(300_000);
});

test('a create where a file is, a replace where none is, and bytes past the limit are refused before anything is sealed', async () => {
	const { device } = setup({ blob: 1_000 });
	const alice = device('alice');
	await until(() => alice.replica.blobLimit() === 1_000);
	expect((await alice.bytes().put(PATH, blobOf(7, 2_000), { replace: false })).error).toMatchObject({ name: 'TooLarge', limit: 1_000 });
	expect((await alice.bytes().put(PATH, blobOf(7, 500), { replace: true })).error).toMatchObject({ name: 'NotFound' });
	unwrap(await alice.bytes().put(PATH, blobOf(7, 500), { replace: false }));
	expect((await alice.bytes().put(PATH, blobOf(8, 500), { replace: false })).error).toMatchObject({ name: 'Exists' });
	expect((await alice.bytes().put('recordings/r1.md', blobOf(8, 500), { replace: false })).error).toMatchObject({ name: 'NotBlob' });
	expect(await alice.store.has(await oidOf(bytesOf(2_000, 7)))).toBe(false);
});

test('another device opens the bytes: fetched once, verified, then read from its own store', async () => {
	const { server, device, served } = setup();
	const alice = device('alice');
	const bob = device('bob');
	const put = unwrap(await alice.bytes().put(PATH, blobOf(9), { replace: false }));
	await until(() => bob.replica.read(PATH) !== null);
	const [first, second] = await Promise.all([bob.bytes().open(PATH), bob.bytes().open(PATH)]);
	const file = unwrap(first);
	expect(file.type).toBe('audio/webm');
	expect(file.name).toBe('r1.webm');
	expect(await oidOf(new Uint8Array(await file.arrayBuffer()))).toBe(put.oid);
	expect(unwrap(second).size).toBe(put.size);
	expect(await bob.store.has(put.oid)).toBe(true);
	expect((await bob.bytes().open('recordings/none.webm')).error).toMatchObject({ name: 'Missing' });
	expect((await bob.bytes().open('notes/a.md')).error).toMatchObject({ name: 'Missing' });
	// Offline, from its own store.
	await served.stop();
	expect(unwrap(await bob.bytes().open(PATH)).size).toBe(put.size);
	const unknown = { oid: 'e'.repeat(64), size: 4 };
	bob.replica.write('recordings/elsewhere.webm', writePointer(unknown));
	expect((await bob.bytes().open('recordings/elsewhere.webm')).error).toMatchObject({ name: 'Unavailable' });
	expect(server.read(PATH)).toBe(writePointer(put));
});
