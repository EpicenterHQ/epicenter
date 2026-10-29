/**
 * Replica Sync Tests
 *
 * Two persistent browser profiles, as two people's browsers, each with a
 * replica of one repository, sync through the Bun dev server over a bare
 * Git repository on disk. A browser cannot set a WebSocket's headers, so
 * each socket connects with a one-use ticket its worker asked for over
 * HTTP (from this page's origin, which the dev server lists). Each profile
 * goes through its own gate, so one can be taken offline while the other
 * edits.
 *
 * Key behaviors:
 * - An edit in one profile appears in the other
 * - An offline edit survives a reload, is sent on reconnect, and merges with an edit made meanwhile
 * - The merged file reaches Git once the server flushes
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openDiskRepository, serveRepository } from '../src/bun/serve.js';
import { authenticateBearer } from '../src/wire/wire.js';
import { startGate } from './gate.js';
import { startSite } from './site.js';
import { launchProfile, loadReplicaPage, TIMEOUT } from './support.js';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

const note = (body: string) => `---\ntitle: List\n---\n${body}`;

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'two profiles sync through the dev server over ticketed sockets, including an offline edit merged on reconnect',
			async () => {
				const dir = await mkdtemp(join(tmpdir(), 'replica-sync-'));
				const server = await openDiskRepository(join(dir, 'repo.git'));
				// The repository's id is unique per run: WebKit's profiles share one origin's OPFS, which holds one replica per repository and account.
				const repository = `shared-${crypto.randomUUID().slice(0, 8)}`;
				const served = serveRepository({
					repository,
					serverId: 'replica-sync',
					server,
					authenticate: authenticateBearer((token) => ({ user: token, role: 'writer' })),
					origins: [new URL(site.url).origin],
				});
				const gates = { alice: startGate(served.url), bob: startGate(served.url) };
				const alice = await launchProfile(browser);
				const bob = await launchProfile(browser);
				try {
					const a = await loadReplicaPage(alice.context, site.url, { page: alice.context.pages()[0] });
					const b = await loadReplicaPage(bob.context, site.url, { page: bob.context.pages()[0] });
					await a.evaluate(([repository, server]) => replicas.create(repository, { account: 'alice', url: server, token: 'alice' }), [repository, gates.alice.url] as const);
					const { replica: bobReplica } = await b.evaluate(
						([repository, server]) => replicas.create(repository, { account: 'bob', url: server, token: 'bob' }),
						[repository, gates.bob.url] as const,
					);
					if (bobReplica === null) throw new Error("bob's replica was not created");

					await a.evaluate((text) => replicas.write('notes/list.md', text), note('a\nb\nc\n'));
					await b.evaluate((text) => replicas.untilText('notes/list.md', text), note('a\nb\nc\n'));

					gates.bob.setOpen(false);
					await b.evaluate((text) => replicas.write('notes/list.md', text), note('a\nb\nC\n'));
					await a.evaluate((text) => replicas.write('notes/list.md', text), note('A\nb\nc\n'));
					await a.evaluate(() => replicas.untilSynced());
					// Bob's edit outlives a reload while offline.
					await b.reload();
					await b.waitForFunction(() => globalThis.replicas !== undefined);
					expect(await b.evaluate((replica) => replicas.open(replica, { token: 'bob' }), bobReplica)).toEqual({ status: 'open' });
					expect(await b.evaluate(() => replicas.read('notes/list.md'))).toBe(note('a\nb\nC\n'));
					expect(await b.evaluate(() => replicas.unsent())).toEqual(['notes/list.md']);

					gates.bob.setOpen(true);
					await b.evaluate((text) => replicas.untilText('notes/list.md', text), note('A\nb\nC\n'));
					await a.evaluate((text) => replicas.untilText('notes/list.md', text), note('A\nb\nC\n'));
					await b.evaluate(() => replicas.untilSynced());
					expect(server.read('notes/list.md')).toBe(note('A\nb\nC\n'));

					await server.flush();
					const shown = Bun.spawnSync(['git', '-C', join(dir, 'repo.git'), 'show', 'main:notes/list.md']);
					expect(shown.stdout.toString()).toBe(note('A\nb\nC\n'));
				} finally {
					await alice.cleanup();
					await bob.cleanup();
					gates.alice.stop();
					gates.bob.stop();
					await served.stop();
					await rm(dir, { recursive: true, force: true });
				}
			},
			TIMEOUT,
		);
	});
}
