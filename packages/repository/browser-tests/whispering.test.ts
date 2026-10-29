/**
 * Whispering-Shaped Browser Tests
 *
 * The scenario of `src/sim/whispering.test.ts` in Chromium and WebKit: two
 * persistent profiles, each with a replica of one repository, sync through
 * the Bun dev server, each through its own gate so one can go offline. A
 * recording is a note at `recordings/<stem>.md` and its audio at
 * `recordings/<stem>.webm`. The server keeps blob bytes on disk, through a
 * byte store that reads them at 1 MiB/s so a PUT is still running when its
 * tab closes.
 *
 * Key behaviors:
 * - Offline, the note and its audio survive a reload; the audio waits, "its bytes are uploading"
 * - Online, the note lands, and the audio's pointer only once the server holds its bytes
 * - The other profile opens the audio (typed audio/webm, its SHA-256 the oid), then again offline
 * - A tab closed during a PUT leaves nothing on the server; reopened, the upload starts again and lands
 * - A pointer to bytes nobody has is held, and its delete clears it; past the blob limit is refused before sealing; past the quota is held
 * - Two profiles recording at one path: one lands, the other is held with why; a stale replace is held with why
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createFileLfsStore } from '../src/bun/lfs-store.js';
import type { FileStatus } from '../src/client/replica.js';
import { openDiskRepository, serveRepository } from '../src/bun/serve.js';
import { writePointer } from '../src/core/markdown.js';
import type { LfsStore } from '../src/server/lfs-store.js';
import { authenticateBearer } from '../src/wire/wire.js';
import { startGate } from './gate.js';
import { startSite } from './site.js';
import { launchProfile, loadReplicaPage, TIMEOUT } from './support.js';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

const MB = 1024 * 1024;
const UPLOADING: FileStatus = { status: 'sending', reason: 'its bytes are uploading' };
const note = (title: string) => `---\ntitle: ${title}\nrecordedAt: 2026-10-28T12:00:00Z\n---\n`;

/** A byte store that reads at `rate` bytes a second, so an upload takes long enough to cut off. */
function slowly(store: LfsStore, rate: number): LfsStore {
	return {
		...store,
		put(oid, size, body) {
			const started = performance.now();
			let count = 0;
			const throttled = body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					async transform(chunk, controller) {
						count += chunk.byteLength;
						const due = (count / rate) * 1000 - (performance.now() - started);
						if (due > 0) await Bun.sleep(due);
						controller.enqueue(chunk);
					},
				}),
			);
			return store.put(oid, size, throttled);
		},
	};
}

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'recordings made offline sync with their audio after its bytes, open on the other profile, and every refusal is held with why',
			async () => {
				const dir = await mkdtemp(join(tmpdir(), 'whispering-'));
				const blobs = join(dir, 'repo.git', 'epicenter', 'blobs');
				const server = await openDiskRepository(join(dir, 'repo.git'), { limits: { blob: 4 * MB, quota: 9 * MB } });
				/** Each pointer on main, and whether its bytes were on the server when it landed. */
				const landed: { path: string; bytesHere: boolean }[] = [];
				server.subscribe((event) => {
					for (const file of event.files) {
						const text = file.hash === null ? null : server.read(file.path);
						const oid = text === null ? null : /oid sha256:([0-9a-f]{64})/.exec(text)?.[1];
						if (oid !== null && oid !== undefined) landed.push({ path: file.path, bytesHere: server.uploaded(oid) !== null });
					}
				});
				const repository = `whispering-${crypto.randomUUID().slice(0, 8)}`;
				const served = serveRepository({
					repository,
					serverId: 'whispering',
					server,
					lfs: slowly(createFileLfsStore(blobs), MB),
					authenticate: authenticateBearer((token) => ({ user: token, role: 'writer' })),
					origins: [new URL(site.url).origin],
				});
				const gates = { alice: startGate(served.url), bob: startGate(served.url) };
				const alice = await launchProfile(browser);
				const bob = await launchProfile(browser);
				try {
					let a = await loadReplicaPage(alice.context, site.url, { page: alice.context.pages()[0] });
					const b = await loadReplicaPage(bob.context, site.url, { page: bob.context.pages()[0] });
					const { replica: aliceReplica } = await a.evaluate(([repository, url]) => replicas.create(repository, { account: 'alice', url, token: 'alice' }), [repository, gates.alice.url] as const);
					await b.evaluate(([repository, url]) => replicas.create(repository, { account: 'bob', url, token: 'bob' }), [repository, gates.bob.url] as const);
					if (aliceReplica === null) throw new Error("alice's replica was not created");
					const reopen = async () => {
						await a.waitForFunction(() => globalThis.replicas !== undefined);
						expect(await a.evaluate((replica) => replicas.open(replica, { token: 'alice' }), aliceReplica)).toEqual({ status: 'open' });
					};

					// Offline: the note and its audio, through a reload.
					gates.alice.setOpen(false);
					await a.evaluate((text) => replicas.write('recordings/r1.md', text), note('Standup'));
					const r1 = await a.evaluate(() => replicas.put('recordings/r1.webm', 3 * 1024 * 1024, 1));
					expect(r1.result as unknown).toEqual({ data: r1.expected, error: null });
					await a.reload();
					await reopen();
					expect(await a.evaluate(() => replicas.read('recordings/r1.md'))).toBe(note('Standup'));
					expect(await a.evaluate(() => replicas.openBytes('recordings/r1.webm'))).toEqual({ summary: r1.expected, type: 'audio/webm' });
					expect(await a.evaluate(() => replicas.state('recordings/r1.webm'))).toEqual(UPLOADING);

					// Online: the note lands, the pointer only after its bytes.
					gates.alice.setOpen(true);
					await b.evaluate(() => replicas.untilText('recordings/r1.md', '---\ntitle: Standup\nrecordedAt: 2026-10-28T12:00:00Z\n---\n'));
					await b.evaluate((text) => replicas.untilText('recordings/r1.webm', text), writePointer(r1.expected ?? { oid: '', size: 0 }));
					expect(landed).toEqual([{ path: 'recordings/r1.webm', bytesHere: true }]);

					// The other profile opens it, then again offline.
					expect(await b.evaluate(() => replicas.openBytes('recordings/r1.webm'))).toEqual({ summary: r1.expected, type: 'audio/webm' });
					gates.bob.setOpen(false);
					expect(await b.evaluate(() => replicas.openBytes('recordings/r1.webm'))).toEqual({ summary: r1.expected, type: 'audio/webm' });
					gates.bob.setOpen(true);

					// A tab closed during the PUT: nothing on the server; reopened, it starts again and lands.
					const r2 = await a.evaluate(() => replicas.put('recordings/r2.webm', 3 * 1024 * 1024, 2));
					const r2oid = r2.expected?.oid ?? '';
					await Bun.sleep(200);
					await a.close();
					await Bun.sleep(500);
					expect(server.uploaded(r2oid)).toBeNull();
					expect((await readdir(blobs).catch((): string[] => [])).includes(r2oid)).toBe(false);
					a = await loadReplicaPage(alice.context, site.url);
					await reopen();
					await b.evaluate((text) => replicas.untilText('recordings/r2.webm', text), writePointer(r2.expected ?? { oid: '', size: 0 }));
					expect(server.uploaded(r2oid)).toBe(3 * MB);

					// A pointer to bytes nobody has, then the blob limit and the quota.
					await a.evaluate((text) => replicas.write('recordings/ghost.webm', text), writePointer({ oid: 'f'.repeat(64), size: 10 }));
					await a.evaluate(() => replicas.untilState('recordings/ghost.webm', 'held'));
					expect(await a.evaluate(() => replicas.state('recordings/ghost.webm'))).toEqual({ status: 'held', reason: 'these bytes are not on this device or the server' });
					await a.evaluate(() => replicas.write('recordings/ghost.webm', null));
					expect(await a.evaluate(() => replicas.state('recordings/ghost.webm'))).toEqual({ status: 'synced' });
					expect((await a.evaluate(() => replicas.put('recordings/long.webm', 5 * 1024 * 1024, 3))).result).toMatchObject({ error: { name: 'TooLarge' } });
					await a.evaluate(() => replicas.put('recordings/r3.webm', Math.floor(3.5 * 1024 * 1024), 4));
					await a.evaluate(() => replicas.untilState('recordings/r3.webm', 'held'));
					expect(await a.evaluate(() => replicas.state('recordings/r3.webm'))).toEqual({ status: 'held', reason: 'the repository has no room left for files' });
					// Its person resolves it by deleting it.
					await a.evaluate(() => replicas.write('recordings/r3.webm', null));
					expect(await a.evaluate(() => replicas.unsent())).toEqual([]);

					// Two profiles recording at one path, then a stale replace.
					gates.alice.setOpen(false);
					await a.evaluate(() => replicas.put('recordings/r4.webm', 100_000, 5));
					const bobs = await b.evaluate(() => replicas.put('recordings/r4.webm', 100_000, 6));
					await b.evaluate(() => replicas.untilSynced());
					gates.alice.setOpen(true);
					await a.evaluate(() => replicas.untilState('recordings/r4.webm', 'held'));
					expect(await a.evaluate(() => replicas.state('recordings/r4.webm'))).toEqual({ status: 'held', reason: 'a file with this name was just added elsewhere' });
					expect(server.read('recordings/r4.webm')).toBe(writePointer(bobs.expected ?? { oid: '', size: 0 }));
					// Alice discards hers: the server's stays.
					await a.evaluate((text) => replicas.write('recordings/r4.webm', text), writePointer(bobs.expected ?? { oid: '', size: 0 }));
					await a.evaluate(() => replicas.untilSynced());
					gates.alice.setOpen(false);
					await a.evaluate(() => replicas.put('recordings/r4.webm', 100_000, 7, true));
					await b.evaluate(() => replicas.put('recordings/r4.webm', 100_000, 8, true));
					await b.evaluate(() => replicas.untilSynced());
					gates.alice.setOpen(true);
					await a.evaluate(() => replicas.untilState('recordings/r4.webm', 'held'));
					expect(await a.evaluate(() => replicas.state('recordings/r4.webm'))).toEqual({ status: 'held', reason: 'this file changed on another device' });
					expect(landed.every((file) => file.bytesHere)).toBe(true);
				} finally {
					await alice.cleanup();
					await bob.cleanup();
					gates.alice.stop();
					gates.bob.stop();
					await served.stop();
					// A flush leaves none due, so no alarm fires on this server after its directory is gone.
					await server.flush().catch(() => {});
					await rm(dir, { recursive: true, force: true });
				}
			},
			TIMEOUT * 2,
		);
	});
}
