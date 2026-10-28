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
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { expectOk } from 'wellcrafted/testing';
import { serveRepository } from '../src/ws/server.js';
import { startGate } from './gate.js';
import { startSite } from './site.js';
import { launchProfile, openTab, reopen, TIMEOUT, uniqueName } from './support.js';

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
	});
}
