/**
 * Moves Inside One Batch
 *
 * A rename and edits in one callback travel as one server batch, for a
 * person's `batch` and for a `send`. Later changes in the batch follow its
 * earlier moves, on the server and in both of the device's resolvers: an
 * edit named by the old path or the new one reaches the renamed note.
 *
 * Key behaviors:
 * - Edit then rename, rename then edit at the new path, and rename then edit at the old path each land one renamed, edited note
 * - A send's edit from the note as read, named by its new path, lands
 * - A rename onto a taken name keeps the note where it was; for a person the edit still reaches the note, for a send all is refused
 * - A send whose edit overlaps a change it did not read is refused whole, rename included
 * - Each callback is one pushed batch, and the device and another device end where the server is
 * - A batch the server cannot apply puts a renamed note back, and a notice keeps the edit made with the rename
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from './bun/git.js';
import { openBunSqlite } from './bun/sqlite.js';
import { createInProcessTransport } from './bun/transport.js';
import { defineApp } from './core/lens.js';
import type { BatchHandles, SendHandles } from './define.js';
import type { Transport } from './engine/ports.js';
import { gitBlobHash } from './core/hash.js';
import type { Batch } from './protocol.js';
import { openRepository } from './repository.js';
import { createRepositoryServer } from './server/server.js';

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) } });
type Defs = typeof app.definitions;
const TRIP = '---\ntitle: T\n---\nTrip\n';
const RENAMED = '---\ntitle: J\n---\nTrip\n';

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'repository-moves-'));
	const server = createRepositoryServer({ driver: openBunSqlite(), git: await openBunGitStore(join(dir, 'repo.git')) });
	const device = (name: string) => {
		const inner = createInProcessTransport(server, { user: name });
		const pushed: Batch[] = [];
		let gate: Promise<void> | null = null;
		let open = () => {};
		const transport: Transport = {
			connect(handlers) {
				const link = inner.connect(handlers);
				return {
					...link,
					async push(batch) {
						pushed.push(structuredClone(batch));
						await gate;
						return link.push(batch);
					},
				};
			},
		};
		return {
			repo: openRepository({ app, driver: openBunSqlite(), transport, device: name }),
			transport: inner,
			pushed,
			/** Hold this device's pushes until `release`. */
			hold() {
				gate = new Promise((resolve) => {
					open = resolve;
				});
			},
			release() {
				gate = null;
				open();
			},
		};
	};
	const alice = device('alice');
	const bob = device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'trip' }, { fields: { title: 'T' }, body: 'Trip\n' }));
	await alice.repo.flush();
	await bob.repo.flush();
	alice.pushed.length = 0;
	return { server, alice, bob, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Where each device and the server hold notes: path to text. */
async function where(t: Setup) {
	const notes = async (repo: Setup['alice']['repo']) => Object.fromEntries((await repo.notes.list()).map((note) => [note.path, note.text]));
	await t.bob.repo.flush();
	return {
		server: { trip: await t.server.read('notes/trip.md'), japan: await t.server.read('notes/japan.md') },
		alice: await notes(t.alice.repo),
		bob: await notes(t.bob.repo),
	};
}

const orderings: [string, (b: BatchHandles<Defs> & SendHandles<Defs>, latest: 'latest') => void][] = [
	['an edit then a rename', (b, from) => {
		b.notes.set({ stem: 'trip' }, 'title', 'J', { from });
		b.notes.move({ stem: 'trip' }, { stem: 'japan' });
	}],
	['a rename then an edit at the new path', (b, from) => {
		b.notes.move({ stem: 'trip' }, { stem: 'japan' });
		b.notes.set({ stem: 'japan' }, 'title', 'J', { from });
	}],
	['a rename then an edit at the old path', (b, from) => {
		b.notes.move({ stem: 'trip' }, { stem: 'japan' });
		b.notes.set({ stem: 'trip' }, 'title', 'J', { from });
	}],
];

const renamedEverywhere = {
	server: { trip: null, japan: RENAMED },
	alice: { 'notes/japan.md': RENAMED },
	bob: { 'notes/japan.md': RENAMED },
};

for (const [what, build] of orderings) {
	test(`a person's batch of ${what} is one batch and lands one renamed, edited note`, async () => {
		const t = await setup();
		expectOk(await t.alice.repo.batch((b) => build(b as never, 'latest')));
		await t.alice.repo.flush();
		expect(t.alice.pushed).toHaveLength(1);
		expect(await where(t)).toEqual(renamedEverywhere);
		expect(await t.alice.repo.notices.list()).toEqual([]);
		await t.cleanup();
	});

	test(`a send of ${what} applies as one batch`, async () => {
		const t = await setup();
		const verdict = expectOk(await t.alice.repo.send((b) => build(b as never, 'latest')));
		expect(verdict).toMatchObject({ kind: 'applied' });
		expect(t.alice.pushed).toHaveLength(1);
		expect(await where(t)).toEqual(renamedEverywhere);
		await t.cleanup();
	});
}

test("a send's rename then an edit from the note as read, named by its new path, applies", async () => {
	const t = await setup();
	const read = await t.alice.repo.notes.get({ stem: 'trip' });
	if (read === null) throw new Error('no note');
	const verdict = expectOk(
		await t.alice.repo.send((b) => {
			b.notes.move({ stem: 'trip' }, { stem: 'japan' });
			b.notes.set({ stem: 'japan' }, 'title', 'J', { from: read });
		}),
	);
	expect(verdict).toMatchObject({ kind: 'applied' });
	expect(await where(t)).toEqual(renamedEverywhere);
	await t.cleanup();
});

test("a person's rename onto a taken name, then an edit at it: the note stays and takes the edit, and the other note is untouched", async () => {
	const t = await setup();
	const JAPAN = '---\ntitle: Other\n---\nOther\n';
	// Alice has not heard of Bob's note: she is offline while she renames.
	t.alice.transport.setOnline(false);
	expectOk(await t.bob.repo.notes.create({ stem: 'japan' }, { fields: { title: 'Other' }, body: 'Other\n' }));
	await t.bob.repo.flush();
	expectOk(
		await t.alice.repo.batch((b) => {
			b.notes.move({ stem: 'trip' }, { stem: 'japan' });
			b.notes.set({ stem: 'japan' }, 'title', 'J');
		}),
	);
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	await t.alice.repo.flush();
	expect(await where(t)).toEqual({
		server: { trip: RENAMED, japan: JAPAN },
		alice: { 'notes/japan.md': JAPAN, 'notes/trip.md': RENAMED },
		bob: { 'notes/japan.md': JAPAN, 'notes/trip.md': RENAMED },
	});
	expect((await t.alice.repo.notices.list()).map((notice) => notice.reason)).toEqual(["'japan' is taken; your note is still 'trip'"]);
	await t.cleanup();
});

test("a send's rename onto a taken name, then an edit, is refused whole", async () => {
	const t = await setup();
	// The send is queued before Bob's note lands, so only the server can find the name taken.
	t.alice.hold();
	const sent = t.alice.repo.send((b) => {
		b.notes.move({ stem: 'trip' }, { stem: 'japan' });
		b.notes.set({ stem: 'japan' }, 'title', 'J', { from: 'latest' });
	});
	await Bun.sleep(5);
	expectOk(await t.bob.repo.notes.create({ stem: 'japan' }, { fields: { title: 'Other' }, body: 'Other\n' }));
	await t.bob.repo.flush();
	t.alice.release();
	expect(expectOk(await sent)).toMatchObject({ kind: 'refused', path: 'notes/japan.md' });
	expect(await t.server.read('notes/trip.md')).toBe(TRIP);
	await t.cleanup();
});

test('a send whose edit overlaps a change it did not read is refused whole, rename included', async () => {
	const t = await setup();
	const read = await t.alice.repo.notes.get({ stem: 'trip' });
	if (read === null) throw new Error('no note');
	expectOk(await t.bob.repo.notes.set({ stem: 'trip' }, 'title', 'B'));
	await t.bob.repo.flush();
	await t.alice.repo.flush();
	const verdict = expectOk(
		await t.alice.repo.send((b) => {
			b.notes.move({ stem: 'trip' }, { stem: 'japan' });
			b.notes.set({ stem: 'japan' }, 'title', 'J', { from: read });
		}),
	);
	expect(verdict).toMatchObject({ kind: 'refused' });
	const B = '---\ntitle: B\n---\nTrip\n';
	expect(await where(t)).toEqual({ server: { trip: B, japan: null }, alice: { 'notes/trip.md': B }, bob: { 'notes/trip.md': B } });
	await t.cleanup();
});

test("a person's batch of an edit then a rename that the server cannot apply puts the note back, and a notice keeps the edit", async () => {
	const transport: Transport = {
		connect: () => ({
			connected: () => true,
			hello: async () => Ok({ kind: 'snapshot' as const, seq: 1, through: 0, files: [{ path: 'notes/trip.md', text: TRIP, hash: gitBlobHash(TRIP) }] }),
			push: async () => Ok({ kind: 'refused' as const, path: '', reason: 'a fault', overlaps: [] }),
			close() {},
		}),
	};
	const repo = openRepository({ app, driver: openBunSqlite(), transport, device: 'scripted' });
	await repo.flush();
	expectOk(
		await repo.batch((b) => {
			b.notes.set({ stem: 'trip' }, 'title', 'J');
			b.notes.move({ stem: 'trip' }, { stem: 'japan' });
		}),
	);
	await repo.flush();
	expect((await repo.notes.list()).map((note) => [note.path, note.text])).toEqual([['notes/trip.md', TRIP]]);
	expect((await repo.notices.list()).map(({ kind, path, kept }) => ({ kind, path, kept }))).toEqual([
		{ kind: 'protocol', path: 'notes/trip.md', kept: null },
		{ kind: 'protocol', path: 'notes/trip.md', kept: RENAMED },
	]);
	repo.close();
});

test('an edit made elsewhere to a note this device renamed, before its rename lands, follows the rename and leaves no copy behind', async () => {
	const t = await setup();
	t.alice.hold();
	expectOk(await t.alice.repo.notes.move({ stem: 'trip' }, { stem: 'japan' }));
	await Bun.sleep(5);
	expectOk(await t.bob.repo.notes.write({ stem: 'trip' }, { body: 'Trip by Bob\n' }));
	await t.bob.repo.flush();
	const edited = '---\ntitle: T\n---\nTrip by Bob\n';
	expect(Object.fromEntries((await t.alice.repo.notes.list()).map((note) => [note.path, note.text]))).toEqual({ 'notes/japan.md': edited });
	t.alice.release();
	await t.alice.repo.flush();
	expect(await where(t)).toEqual({
		server: { trip: null, japan: edited },
		alice: { 'notes/japan.md': edited },
		bob: { 'notes/japan.md': edited },
	});
	await t.cleanup();
});

test('an acknowledged edit of a note this device then renamed leaves no copy at the old path, though the server merged in another edit', async () => {
	const t = await setup();
	t.alice.hold();
	expectOk(await t.alice.repo.notes.set({ stem: 'trip' }, 'title', 'J'));
	await Bun.sleep(5);
	// Bob's edit lands first, so the server's answer to Alice's holds it too.
	expectOk(await t.bob.repo.notes.write({ stem: 'trip' }, { body: 'Trip by Bob\n' }));
	await t.bob.repo.flush();
	expectOk(await t.alice.repo.notes.move({ stem: 'trip' }, { stem: 'japan' }));
	t.alice.release();
	await t.alice.repo.flush();
	const both = '---\ntitle: J\n---\nTrip by Bob\n';
	expect(await where(t)).toEqual({ server: { trip: null, japan: both }, alice: { 'notes/japan.md': both }, bob: { 'notes/japan.md': both } });
	await t.cleanup();
});
