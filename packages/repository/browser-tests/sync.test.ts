/**
 * Browser Sync Tests
 *
 * Two persistent browser profiles, as two people's browsers, sync through
 * the local WebSocket server over a bare Git repository on disk. Each goes
 * through its own gate, so one can be taken offline while the other edits.
 *
 * Key behaviors:
 * - An edit in one profile appears in the other
 * - An offline edit survives a reload, is sent on reconnect, and merges with an edit made meanwhile
 * - A commit puts the merged file in Git
 * - A send is refused on overlap, written into its tab when applied, fails at once offline, and lands once after a lost reply
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page, webkit } from 'playwright';
import { expectOk } from 'wellcrafted/testing';
import { serveRepository } from '../src/ws/server.js';
import { startGate } from './gate.js';
import { startSite } from './site.js';
import { launchProfile, openTab, reopen, TIMEOUT, uniqueName } from './support.js';

type Gate = ReturnType<typeof startGate>;
type Served = Awaited<ReturnType<typeof serveRepository>>;

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'two profiles sync through the local server, including an offline edit merged on reconnect',
			async () => {
				const dir = await mkdtemp(join(tmpdir(), 'repository-sync-'));
				const served = await serveRepository({ dir: join(dir, 'repo.git') });
				const gates = { alice: startGate(served.url), bob: startGate(served.url) };
				const alice = await launchProfile(browser);
				const bob = await launchProfile(browser);
				try {
					// The server makes them one repository; each profile names its copy.
					const names = { alice: uniqueName('alice'), bob: uniqueName('bob') };
					const bobServer = `${gates.bob.url}?user=bob`;
					const a = await openTab(alice.context, site.url, names.alice, { page: alice.context.pages()[0], server: `${gates.alice.url}?user=alice` });
					const b = await openTab(bob.context, site.url, names.bob, { page: bob.context.pages()[0], server: bobServer });
					await a.evaluate(() => harness.write('list', 'a\nb\nc\n'));
					await b.evaluate(() => harness.untilText('list', 'a\nb\nc\n'));

					gates.bob.setOpen(false);
					await b.evaluate(() => harness.write('list', 'a\nb\nC\n'));
					await a.evaluate(() => harness.write('list', 'A\nb\nc\n'));
					// Bob's edit outlives a reload while offline.
					await b.reload();
					await reopen(b, names.bob, bobServer);
					expect(await b.evaluate(() => harness.text('list'))).toBe('a\nb\nC\n');
					expect(await b.evaluate(() => harness.unsent())).toBe(1);

					gates.bob.setOpen(true);
					await b.evaluate(() => harness.untilText('list', 'A\nb\nC\n'));
					await a.evaluate(() => harness.untilText('list', 'A\nb\nC\n'));
					await b.evaluate(() => harness.flush());
					expect(await b.evaluate(() => harness.unsent())).toBe(0);

					expectOk(await served.repository.commit());
					const shown = Bun.spawnSync(['git', '-C', join(dir, 'repo.git'), 'show', 'main:notes/list.md']);
					expect(shown.stdout.toString()).toBe('A\nb\nC\n');
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

		/** Two profiles through their own gates to one local server; `run` gets their tabs. */
		async function world(run: (w: { a: Page; b: Page; gates: { alice: Gate; bob: Gate }; served: Served; reopenBob(): Promise<unknown> }) => Promise<void>) {
			const dir = await mkdtemp(join(tmpdir(), 'repository-send-'));
			const served = await serveRepository({ dir: join(dir, 'repo.git') });
			const gates = { alice: startGate(served.url), bob: startGate(served.url) };
			const alice = await launchProfile(browser);
			const bob = await launchProfile(browser);
			try {
				const names = { alice: uniqueName('alice'), bob: uniqueName('bob') };
				const bobServer = `${gates.bob.url}?user=bob`;
				const a = await openTab(alice.context, site.url, names.alice, { page: alice.context.pages()[0], server: `${gates.alice.url}?user=alice` });
				const b = await openTab(bob.context, site.url, names.bob, { page: bob.context.pages()[0], server: bobServer });
				await run({ a, b, gates, served, reopenBob: () => reopen(b, names.bob, bobServer) });
			} finally {
				await alice.cleanup();
				await bob.cleanup();
				gates.alice.stop();
				gates.bob.stop();
				await served.stop();
				await rm(dir, { recursive: true, force: true });
			}
		}

		test(
			'a send that overlaps a change since the version it read is refused and changes nothing',
			() =>
				world(async ({ a, b }) => {
					await a.evaluate(() => harness.write('task', 'open\n'));
					await b.evaluate(() => harness.untilText('task', 'open\n'));
					const read = await b.evaluate(() => harness.version('task'));
					await a.evaluate(() => harness.write('task', 'started\n'));
					await b.evaluate(() => harness.untilText('task', 'started\n'));
					const verdict = await b.evaluate((base) => harness.sendBody('task', 'done\n', base), read);
					expect(verdict).toMatchObject({ error: null, data: { kind: 'refused', path: 'notes/task.md' } });
					expect(await b.evaluate(() => harness.text('task'))).toBe('started\n');
					expect(await b.evaluate(() => harness.unsent())).toBe(0);
				}),
			TIMEOUT,
		);

		test(
			'an applied send is written into the sending tab at once',
			() =>
				world(async ({ a, b, served }) => {
					await a.evaluate(() => harness.write('log', 'one\n'));
					await b.evaluate(() => harness.untilText('log', 'one\n'));
					const verdict = await b.evaluate(() => harness.sendAppend('log', 'two\n'));
					expect(verdict).toMatchObject({ error: null, data: { kind: 'applied' } });
					// The server sends its sender no broadcast; the verdict itself is written here.
					expect(await b.evaluate(() => harness.text('log'))).toBe('one\ntwo\n');
					await a.evaluate(() => harness.untilText('log', 'one\ntwo\n'));
					expect(await served.repository.read('notes/log.md')).toBe('one\ntwo\n');
				}),
			TIMEOUT,
		);

		test(
			'a send while offline fails at once and queues nothing',
			() =>
				world(async ({ b, gates }) => {
					await b.evaluate(() => harness.write('log', 'one\n'));
					await b.evaluate(() => harness.flush());
					gates.bob.setOpen(false);
					// A person's edit made meanwhile finds the connection gone, so the device knows it is offline.
					await b.evaluate(() => harness.write('log', 'one!\n'));
					const started = Date.now();
					expect(await b.evaluate(() => harness.sendAppend('log', 'two\n'))).toMatchObject({ error: { name: 'Offline' } });
					expect(Date.now() - started).toBeLessThan(1_000);
					// Only the person's edit waits; the send queued nothing and changed nothing.
					expect(await b.evaluate(() => harness.unsent())).toBe(1);
					expect(await b.evaluate(() => harness.text('log'))).toBe('one!\n');
				}),
			TIMEOUT,
		);

		test(
			'a send whose reply was lost is resent under its number and lands once',
			() =>
				world(async ({ a, b, gates, served }) => {
					await a.evaluate(() => harness.write('log', 'one\n'));
					await b.evaluate(() => harness.untilText('log', 'one\n'));
					gates.bob.dropNextReply();
					expect(await b.evaluate(() => harness.sendAppend('log', 'two\n'))).toMatchObject({ error: { name: 'Unknown' } });
					expect(await served.repository.read('notes/log.md')).toBe('one\ntwo\n');
					// The socket reconnects, the row is sent again, and the receipt answers it.
					await b.evaluate(() => harness.untilText('log', 'one\ntwo\n'));
					await b.evaluate(() => harness.flush());
					expect(await b.evaluate(() => harness.unsent())).toBe(0);
					expect(await served.repository.read('notes/log.md')).toBe('one\ntwo\n');
					await a.evaluate(() => harness.untilText('log', 'one\ntwo\n'));
				}),
			TIMEOUT,
		);
	});
}
