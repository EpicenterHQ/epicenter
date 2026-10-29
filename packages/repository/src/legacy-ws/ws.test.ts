/**
 * WebSocket Transport Tests
 *
 * Two Bun devices sync through `serveRepository` over real sockets on
 * 127.0.0.1, with the server's overlay and Git repository on disk, so a
 * restarted server keeps what it acknowledged.
 *
 * Key behaviors:
 * - An edit appears on the other device through the server's broadcast
 * - Edits made while the server is down wait in the outbox, are resent on reconnect, and merge
 * - A commit puts the merged file in the bare Git repository
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { openBunSqlite } from '../bun/sqlite.js';
import { defineApp } from '../core/lens.js';
import { openRepository } from '../repository.js';
import { createWebSocketTransport } from './client.js';
import { serveRepository } from './server.js';

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({}) } });

async function until(check: () => Promise<boolean>, what: string) {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

test('devices sync over WebSocket, and edits made while the server is down merge on reconnect', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'repository-ws-'));
	const repoDir = join(dir, 'repo.git');
	let served = await serveRepository({ dir: repoDir });
	const port = new URL(served.url).port;
	const device = (user: string) =>
		openRepository({
			app,
			driver: openBunSqlite(),
			transport: createWebSocketTransport({ url: `${served.url}?user=${user}`, retry: { minMs: 20, maxMs: 100 } }),
		});
	const alice = device('alice');
	const bob = device('bob');
	const text = async (repo: typeof alice, stem: string) => (await repo.notes.get({ stem }))?.text ?? null;
	try {
		// Written before the socket opens: it waits in the outbox and goes once connected.
		expectOk(await alice.notes.create({ stem: 'list' }, { body: 'a\nb\nc\n' }));
		await until(async () => (await text(bob, 'list')) === 'a\nb\nc\n', 'bob to see the list');

		await served.stop();
		const offline = [alice.notes.write({ stem: 'list' }, { body: 'A\nb\nc\n' }), bob.notes.write({ stem: 'list' }, { body: 'a\nb\nC\n' })];
		expect(await text(alice, 'list')).toBe('A\nb\nc\n');

		served = await serveRepository({ dir: repoDir, port: Number(port) });
		// Each was saved on its device at once, offline.
		for (const saved of await Promise.all(offline)) expectOk(saved);
		await until(async () => (await text(alice, 'list')) === 'A\nb\nC\n' && (await text(bob, 'list')) === 'A\nb\nC\n', 'both to merge');

		expectOk(await served.repository.commit());
		const shown = Bun.spawnSync(['git', '-C', repoDir, 'show', 'main:notes/list.md']);
		expect(shown.stdout.toString()).toBe('A\nb\nC\n');
	} finally {
		alice.close();
		bob.close();
		await served.stop();
		await rm(dir, { recursive: true, force: true });
	}
});
