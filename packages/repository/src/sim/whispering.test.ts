/**
 * Whispering-Shaped Tests
 *
 * Recordings as Whispering will keep them, before it moves onto the
 * repository: a note at `recordings/<stem>.md` and its audio at
 * `recordings/<stem>.webm`, named by the app. Two devices on a real server
 * over HTTP and its socket, each with its bytes on disk
 * (`createFileBlobStore`) and the upload track running in process, as
 * `openLocalRepository` runs it. The browser runs the same scenario in
 * `browser-tests/whispering.test.ts`.
 *
 * Key behaviors:
 * - Offline, a recording's note and audio are saved and survive a reopen; the audio waits, "its bytes are uploading"
 * - Online, the note lands, and the audio's pointer only once the server holds its bytes
 * - Another device opens the audio, fetched and verified, then again offline from its own store
 * - An upload cut off mid-PUT stores nothing on the server; the next track sends it again from the sealed bytes
 * - A pointer to bytes nobody has is held with why, and deleting it clears it; an attach past the blob limit is refused before sealing, and an upload past the quota is held with why
 * - Two devices recording at one path: one lands, the other beside it at a sibling named from its bytes; a stale replace too; nothing is held
 * - A `git push` that replaces a binary passes; one whose bytes are missing is refused
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createLocalHost } from '../api/local.js';
import { openRepository } from '../api/repository.js';
import { createFileBlobStore } from '../bun/blobs.js';
import { serveRepository, socketWithHeaders } from '../bun/serve.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { bytesOf, oidOf } from '../client/blobs.checks.js';
import { openReplica, UPLOADING } from '../client/replica.js';
import { connectSocket } from '../client/socket.js';
import { UPLOAD_REFUSALS } from '../client/uploads.js';
import { defineApp } from '../core/lens.js';
import { parsePointer, writePointer } from '../core/markdown.js';
import { MAIN } from '../server/git-store.js';
import { createMemoryGitStore } from '../server/memory-git.js';
import { createMemoryLfsStore } from '../server/memory-lfs-store.js';
import { createServer, type Limits, type Session } from '../server/server.js';
import { createLfsClient, createWireClient, type LfsClient, LfsClientError } from '../wire/client.js';
import { authenticateBearer } from '../wire/wire.js';

const whispering = defineApp({
	recordings: {
		path: 'recordings/{stem}.md',
		schema: Type.Object({ title: Type.String(), recordedAt: Type.String(), durationMs: Type.Optional(Type.Number()) }),
	},
	audio: { path: 'recordings/{stem}.webm', blob: true },
});
const ALICE: Session = { user: 'alice', role: 'writer' };
const SESSIONS: Record<string, Session> = { alice: ALICE, bob: { user: 'bob', role: 'writer' } };
const MB = 1024 * 1024;
const webm = (seed: number, size = 3 * MB) => new Blob([bytesOf(size, seed) as BlobPart], { type: 'audio/webm' });

const stops: (() => unknown)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop();
});

async function until(holds: () => boolean | Promise<boolean>, what = 'the condition') {
	for (let tries = 0; tries < 300; tries++) {
		if (await holds()) return;
		await Bun.sleep(10);
	}
	throw new Error(`never held: ${what}`);
}

async function setup(limits: Partial<Limits> = {}) {
	const git = createMemoryGitStore();
	/** Every commit on main, and whether the server held each pointer's bytes when it landed. */
	const landed: { path: string; text: string | null; bytesHere: boolean }[] = [];
	const server = createServer({
		store: openBunSqlite(),
		git,
		limits,
		onCommit: (committed) => {
			for (const file of committed.files) {
				const pointer = file.after === null ? null : parsePointer(file.after);
				landed.push({ path: file.path, text: file.after, bytesHere: pointer === null || server.uploaded(pointer.oid) === pointer.size });
			}
		},
	});
	const bytes = createMemoryLfsStore();
	const served = serveRepository({ repository: 'r', serverId: 's', server, lfs: bytes, authenticate: authenticateBearer((token) => SESSIONS[token] ?? null) });
	stops.push(served.stop);
	const dir = await mkdtemp(join(tmpdir(), 'whispering-'));
	stops.push(() => rm(dir, { recursive: true, force: true }));

	/** A device: its database and its bytes on disk outlive each open, as a reloaded page's do. */
	function device(user: string) {
		const headers = { authorization: `Bearer ${user}` };
		const driver = openBunSqlite();
		const store = createFileBlobStore(join(dir, user, 'objects'));
		let online = true;
		/** What a PUT does; a test cuts one off. */
		let putting: LfsClient['put'] | null = null;
		const real = createLfsClient({ url: served.url, headers });
		const offline = () => LfsClientError.Network({ cause: new Error('offline') });
		const lfs: LfsClient = {
			...real,
			batch: async (...args) => (online ? real.batch(...args) : offline()),
			put: async (...args) => (online ? (putting ?? real.put)(...args) : offline()),
			get: async (...args) => (online ? real.get(...args) : offline()),
		};
		let socket: { close(): void } | null = null;
		let session: ReturnType<typeof open> | null = null;
		function open() {
			const replica = unwrap(openReplica({ driver, binding: { repository: 'r', server: null, account: user }, device: user, app: whispering, after: (ms, run) => void setTimeout(run, ms), now: () => Date.now(), quiet: 0 }));
			const local = createLocalHost({ replica, app: whispering, store, lfs });
			const repo = openRepository({ app: whispering, host: local.host });
			return { replica, local, repo };
		}
		const connect = () => {
			socket?.close();
			socket = session === null ? null : connectSocket(session.replica, createWireClient({ url: served.url, headers, openSocket: socketWithHeaders(headers) }));
		};
		const close = () => {
			socket?.close();
			socket = null;
			session?.repo.close();
			session?.replica.close();
		};
		session = open();
		connect();
		stops.push(close);
		return {
			store,
			get replica() {
				return (session ?? open()).replica;
			},
			get repo() {
				return (session ?? open()).repo;
			},
			uploaded: () => session?.local.uploaded() ?? Promise.resolve(),
			setOnline(next: boolean) {
				online = next;
				if (next) connect();
				else {
					socket?.close();
					socket = null;
				}
			},
			cutPuts(put: LfsClient['put'] | null) {
				putting = put;
			},
			/** Close the page and open it again over the same database and bytes. */
			async reload() {
				close();
				session = open();
				if (online) connect();
				await until(() => session?.repo.status().status === 'open', 'the repository opens');
			},
		};
	}
	return { server, bytes, served, git, landed, device };
}

test('a recording made offline is here after a reload, lands online with its audio after its bytes, and opens on another device', async () => {
	const { server, landed, device } = await setup();
	const alice = device('alice');
	const bob = device('bob');
	await until(() => alice.repo.status().status === 'open' && bob.repo.status().status === 'open');
	alice.setOnline(false);
	const stem = '2026-10-28T12-00-00Z';
	expectOk(await alice.repo.recordings.create({ stem }, { fields: { title: 'Standup', recordedAt: '2026-10-28T12:00:00Z' } }));
	const audio = expectOk(await alice.repo.audio.create({ stem }, webm(1)));
	expectOk(await alice.repo.recordings.patch({ stem }, { durationMs: 61_000 }));
	expect(audio.oid).toBe(await oidOf(bytesOf(3 * MB, 1)));

	await alice.reload();
	expect(alice.repo.recordings.get({ stem })?.fields).toMatchObject({ title: 'Standup', durationMs: 61_000 });
	expect(expectOk(await alice.repo.audio.open({ stem })).size).toBe(3 * MB);
	expect(alice.replica.state(`recordings/${stem}.webm`)).toEqual({ status: 'waiting', reason: UPLOADING });

	alice.setOnline(true);
	await until(() => server.read(`recordings/${stem}.webm`) !== null, 'the audio lands');
	expect(server.read(`recordings/${stem}.md`)).toContain('Standup');
	expect(landed.filter((file) => file.path === `recordings/${stem}.webm`)).toEqual([{ path: `recordings/${stem}.webm`, text: writePointer(audio), bytesHere: true }]);
	expect(landed.every((file) => file.bytesHere)).toBe(true);
	expect(landed.findIndex((file) => file.path.endsWith('.md'))).toBeLessThan(landed.findIndex((file) => file.path.endsWith('.webm')));

	await until(() => bob.replica.read(`recordings/${stem}.webm`) !== null, 'bob hears of the audio');
	const file = expectOk(await bob.repo.audio.open({ stem }));
	expect(file.type).toBe('audio/webm');
	expect(await oidOf(new Uint8Array(await file.arrayBuffer()))).toBe(audio.oid);
	bob.setOnline(false);
	expect(expectOk(await bob.repo.audio.open({ stem })).size).toBe(3 * MB);
});

test('an upload cut off mid-PUT stores nothing, and the next track sends it from the sealed bytes', async () => {
	const { server, bytes, device } = await setup();
	const alice = device('alice');
	await until(() => alice.repo.status().status === 'open');
	// The tab closes during the PUT: half the body goes, and the connection ends.
	alice.cutPuts(async (action) => {
		const half = bytesOf(MB, 2).subarray(0, MB / 2);
		const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(half) });
		const abort = new AbortController();
		const sent = fetch(action.href, { method: 'PUT', headers: { ...action.header, 'content-length': String(MB) }, body, signal: abort.signal, duplex: 'half' } as RequestInit).catch(() => null);
		await Bun.sleep(100);
		abort.abort();
		await sent;
		return LfsClientError.Network({ cause: new Error('the tab closed') });
	});
	const put = expectOk(await alice.repo.audio.create({ stem: 'r2' }, webm(2, MB)));
	await until(async () => alice.replica.owed().length === 1);
	await Bun.sleep(300);
	expect(await bytes.has(put.oid)).toBe(false);
	expect(server.uploaded(put.oid)).toBeNull();
	alice.cutPuts(null);
	await alice.reload();
	await until(() => server.read('recordings/r2.webm') !== null, 'the audio lands after the reopen');
	expect(server.uploaded(put.oid)).toBe(MB);
});

test('a pointer to bytes nobody has is held, and its delete clears it; past the limit is refused before sealing; past the quota is held', async () => {
	const { device } = await setup({ blob: 2 * MB, quota: 3 * MB });
	const alice = device('alice');
	await until(() => alice.repo.status().status === 'open' && alice.replica.blobLimit() === 2 * MB);
	expectOk(await alice.repo.files.write('recordings/ghost.webm', writePointer({ oid: 'f'.repeat(64), size: 10 })));
	await until(() => JSON.stringify(alice.replica.state('recordings/ghost.webm')).includes(UPLOAD_REFUSALS.missing));
	expect(alice.replica.state('recordings/ghost.webm')).toEqual({ status: 'waiting', reason: UPLOAD_REFUSALS.missing });
	expectOk(await alice.repo.files.delete('recordings/ghost.webm'));
	expect(alice.replica.notSent()).toEqual([]);

	expect(expectErr(await alice.repo.audio.create({ stem: 'long' }, webm(3, 3 * MB)))).toMatchObject({ name: 'TooLarge', limit: 2 * MB });
	expect(await alice.store.has(await oidOf(bytesOf(3 * MB, 3)))).toBe(false);

	expectOk(await alice.repo.audio.create({ stem: 'one' }, webm(4, 2 * MB)));
	expectOk(await alice.repo.audio.create({ stem: 'two' }, webm(5, 2 * MB)));
	await until(() => alice.replica.owed().length === 0, 'both uploads are answered');
	expect([alice.replica.state('recordings/one.webm'), alice.replica.state('recordings/two.webm')]).toContainEqual({ status: 'waiting', reason: UPLOAD_REFUSALS[507] });
});

test('two devices recording at one path: one lands, the other lands beside it at a sibling; a stale replace too; nothing is held', async () => {
	const { server, device } = await setup();
	const alice = device('alice');
	const bob = device('bob');
	await until(() => alice.repo.status().status === 'open' && bob.repo.status().status === 'open');
	alice.setOnline(false);
	const alices = expectOk(await alice.repo.audio.create({ stem: 'r1' }, webm(6, MB)));
	const bobs = expectOk(await bob.repo.audio.create({ stem: 'r1' }, webm(7, MB)));
	await until(() => server.read('recordings/r1.webm') !== null);
	alice.setOnline(true);
	const beside = `recordings/r1 (conflict ${alices.oid.slice(0, 7)}).webm`;
	await until(() => server.read(beside) !== null && alice.replica.read(beside) !== null && bob.replica.read(beside) !== null, 'both see both');
	expect(server.read('recordings/r1.webm')).toBe(writePointer(bobs));
	expect(server.read(beside)).toBe(writePointer(alices));
	for (const d of [alice, bob]) {
		expect(d.replica.read('recordings/r1.webm')).toBe(writePointer(bobs));
		expect(d.replica.notSent()).toEqual([]);
	}

	// A stale replace.
	alice.setOnline(false);
	const stale = expectOk(await alice.repo.audio.replace({ stem: 'r1' }, webm(8, MB)));
	const newer = expectOk(await bob.repo.audio.replace({ stem: 'r1' }, webm(9, MB)));
	await until(() => server.read('recordings/r1.webm') === writePointer(newer));
	alice.setOnline(true);
	const again = `recordings/r1 (conflict ${stale.oid.slice(0, 7)}).webm`;
	await until(() => server.read(again) !== null && alice.replica.read('recordings/r1.webm') === writePointer(newer), 'the stale replace is beside it');
	expect(server.read(again)).toBe(writePointer(stale));
	expect(alice.replica.notSent()).toEqual([]);
});

test('a git push that replaces a binary passes; one whose bytes are missing is refused', async () => {
	const { server, git, device } = await setup();
	const alice = device('alice');
	await until(() => alice.repo.status().status === 'open');
	const first = expectOk(await alice.repo.audio.create({ stem: 'r1' }, webm(10, MB)));
	await until(() => server.read('recordings/r1.webm') !== null);
	await server.flush();
	const head = (await git.readRef(MAIN)) as string;
	const commitOn = async (parent: string, changes: Record<string, string | null>) => {
		const tree = await git.readTree((await git.readCommit(parent))?.tree ?? '');
		for (const [path, text] of Object.entries(changes)) {
			if (text === null) tree.delete(path);
			else tree.set(path, { mode: '100644', oid: await git.writeBlob(new TextEncoder().encode(text)) });
		}
		return git.writeCommit({ tree: await git.writeTree(tree), parents: [parent], message: 'pushed\n', author: { name: 'alice', email: 'a@b' }, at: new Date() });
	};
	const missing = await commitOn(head, { 'recordings/r1.webm': writePointer({ oid: 'e'.repeat(64), size: 5 }) });
	expect(await server.receive({ ref: MAIN, old: head, next: missing }, ALICE)).toMatchObject({ kind: 'refused', reason: "the file's bytes are not on the server" });
	// The bytes go through the LFS routes first, as git-lfs pushes them before the ref.
	const other = expectOk(await alice.repo.audio.create({ stem: 'r2' }, webm(11, MB)));
	await until(() => server.uploaded(other.oid) !== null);
	const replaced = await commitOn(head, { 'recordings/r1.webm': writePointer(other) });
	// Alice's second recording is live but not in Git yet: the push is merged over it.
	expect(await server.receive({ ref: MAIN, old: head, next: replaced }, ALICE)).toMatchObject({ kind: 'accepted', merged: true });
	expect(server.read('recordings/r1.webm')).toBe(writePointer(other));
	await server.flush();
	const now = (await git.readRef(MAIN)) as string;
	const replacedNow = await commitOn(now, { 'recordings/r1.webm': writePointer(first) });
	expect(await server.receive({ ref: MAIN, old: now, next: replacedNow }, ALICE)).toMatchObject({ kind: 'accepted' });
	expect(server.read('recordings/r1.webm')).toBe(writePointer(first));
	expect(first.oid).not.toBe(other.oid);
});
