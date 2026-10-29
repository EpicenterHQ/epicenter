/**
 * Held Text Tests
 *
 * Each file sits on three levels: what this device shows, what it promised
 * the server (what the server will have once its queued changes land), and
 * what the server has. A change moves down to the promised level when its
 * gate opens: its frontmatter parses, or the text below exists and does not
 * parse either. Until then it is held: saved here, shown, never sent. When a
 * lower level changes, the held text merges onto it, and is queued at once
 * if that makes it parse.
 *
 * Key behaviors:
 * - A text that would break a note that parses is saved and held, not refused and not sent
 * - Held text stays visible, unsent and held through an acknowledgment, a changed broadcast, a remote move, a remote delete, a path reuse and another device's applied send, and a restart at each point
 * - A repair queues exactly the repaired text, from what the server will have
 * - A merge that makes held text parse queues it at once
 * - Held text over a create whose reply was lost is not joined with that create when the hello brings it
 * - A callback's ready changes go together; a held change waits alone, and later changes follow a rename before it
 * - A send naming a held path fails at once, and one with a breaking text is refused before it is numbered
 * - A field write on a held note is Unparseable
 * - Reads say whether a file is synced, sending or held, and a change of that alone notifies
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from './bun/git.js';
import { openBunSqlite } from './bun/sqlite.js';
import { createInProcessTransport } from './bun/transport.js';
import { defineApp } from './define.js';
import type { Transport } from './engine/ports.js';
import { gitBlobHash } from './core/hash.js';
import type { Batch } from './protocol.js';
import { openRepository } from './repository.js';
import { createRepositoryServer } from './server/server.js';
import { parses } from './core/markdown.js';

const app = defineApp({
	notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()), mood: Type.Optional(Type.String()) }) },
});
const PATH = 'notes/a.md';
const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
/** Frontmatter that does not parse: a key given twice. */
const broken = (body: string) => `---\ntitle: A\ntitle: B\n---\n${body}`;

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'repository-held-'));
	const server = createRepositoryServer({ driver: openBunSqlite(), git: await openBunGitStore(join(dir, 'repo.git')) });
	/** A device whose pushes are recorded, and held while `hold` is set until `release`. */
	const device = (name: string, file?: string) => {
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
		const make = () => openRepository({ app, driver: openBunSqlite(file), transport, device: name });
		const it = {
			repo: make(),
			pushed,
			transport: inner,
			/** Close the database and open it again, as a reload would. */
			async restart() {
				it.repo.close();
				it.repo = make();
				await it.repo.flush();
			},
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
		return it;
	};
	return { dir, server, device, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** What every push carried for `path`. */
const sentTo = (pushed: Batch[], path: string) =>
	pushed.flatMap((batch) => batch.changes.flatMap((change) => (change.kind === 'write' && change.path === path ? [change.text] : [])));

test('a text that would break a note that parses is saved and held, not refused and not sent', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	await alice.repo.flush();
	expect((await alice.repo.files.readText(PATH))?.sync).toEqual({ state: 'synced' });
	expectOk(await alice.repo.files.writeText(PATH, broken('one\n')));
	await alice.repo.flush();
	expect(await alice.repo.files.readText(PATH)).toMatchObject({ text: broken('one\n'), sync: { state: 'held', reason: 'unparseable' } });
	expect(await alice.repo.notes.get({ stem: 'a' })).toMatchObject({ valid: false, sync: { state: 'held', reason: 'unparseable' } });
	expect(await t.server.read(PATH)).toBe(note('one\n'));
	expect(sentTo(alice.pushed, PATH).some((text) => text !== null && !parses(text))).toBe(false);
	await t.cleanup();
});

/**
 * Alice's valid P is queued and in flight when she types U, which does not
 * parse; P is acknowledged, then `meanwhile` happens while U is held. At
 * every point, and after a restart at each, U is visible, unsent and held.
 * Her repair then queues exactly the repaired text from what the server has.
 */
async function heldThrough(
	meanwhile: (t: Awaited<ReturnType<typeof setup>>, others: { bob: ReturnType<Awaited<ReturnType<typeof setup>>['device']> }) => Promise<void>,
	expected: { path: string; shown: string; server: string | null; repair: string; repaired: string },
) {
	const t = await setup();
	const alice = t.device('alice', join(t.dir, 'alice.sqlite'));
	const bob = t.device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n.\n.\nbob\n' }));
	await alice.repo.flush();
	await bob.repo.flush();
	alice.hold();
	expectOk(await alice.repo.files.writeText(PATH, note('ONE\n.\n.\nbob\n')));
	await Bun.sleep(5);
	expectOk(await alice.repo.files.writeText(PATH, broken('ONE\n.\n.\nbob\n')));
	const isHeld = async (path: string, shown: string) => {
		expect(await alice.repo.files.readText(path)).toMatchObject({ text: shown, sync: { state: 'held', reason: 'unparseable' } });
		expect(sentTo(alice.pushed, path).every((text) => text === null || parses(text))).toBe(true);
	};
	await isHeld(PATH, broken('ONE\n.\n.\nbob\n'));
	alice.release();
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe(note('ONE\n.\n.\nbob\n'));
	await isHeld(PATH, broken('ONE\n.\n.\nbob\n'));
	await alice.restart();
	await isHeld(PATH, broken('ONE\n.\n.\nbob\n'));

	await bob.repo.flush();
	await meanwhile(t, { bob });
	await bob.repo.flush();
	await alice.repo.flush();
	await isHeld(expected.path, expected.shown);
	expect(await t.server.read(expected.path)).toBe(expected.server);
	await alice.restart();
	await isHeld(expected.path, expected.shown);
	expect(await t.server.read(expected.path)).toBe(expected.server);

	const pushes = alice.pushed.length;
	expectOk(await alice.repo.files.writeText(expected.path, expected.repair));
	await alice.repo.flush();
	expect(alice.pushed.slice(pushes).map((batch) => batch.changes)).toEqual([
		[{ kind: 'write', path: expected.path, base: expected.server === null ? null : { hash: gitBlobHash(expected.server) }, text: expected.repair }],
	]);
	expect(await t.server.read(expected.path)).toBe(expected.repaired);
	expect((await alice.repo.files.readText(expected.path))?.sync).toEqual({ state: 'synced' });
	await t.cleanup();
}

test('held text survives a changed broadcast, and a repair queues exactly the repaired text', () =>
	heldThrough(
		async (_, { bob }) => {
			expectOk(await bob.repo.notes.write({ stem: 'a' }, { body: 'ONE\n.\n.\nBOB\n' }));
		},
		{
			path: PATH,
			shown: broken('ONE\n.\n.\nBOB\n'),
			server: note('ONE\n.\n.\nBOB\n'),
			repair: note('ONE\n.\n.\nBOB\n', 'B'),
			repaired: note('ONE\n.\n.\nBOB\n', 'B'),
		},
	));

test('held text follows a remote move', () =>
	heldThrough(
		async (_, { bob }) => {
			expectOk(await bob.repo.notes.move({ stem: 'a' }, { stem: 'b' }));
		},
		{
			path: 'notes/b.md',
			shown: broken('ONE\n.\n.\nbob\n'),
			server: note('ONE\n.\n.\nbob\n'),
			repair: note('ONE\n.\n.\nbob\n', 'B'),
			repaired: note('ONE\n.\n.\nbob\n', 'B'),
		},
	));

test('held text survives a remote delete, and its repair creates the note again', () =>
	heldThrough(
		async (_, { bob }) => {
			expectOk(await bob.repo.notes.delete({ stem: 'a' }));
		},
		{ path: PATH, shown: broken('ONE\n.\n.\nbob\n'), server: null, repair: note('ONE\n.\n.\nbob\n', 'B'), repaired: note('ONE\n.\n.\nbob\n', 'B') },
	));

test('held text survives its path reused by another note', () =>
	heldThrough(
		async (_, { bob }) => {
			expectOk(await bob.repo.notes.delete({ stem: 'a' }));
			await bob.repo.flush();
			expectOk(await bob.repo.notes.create({ stem: 'a' }, { fields: { title: 'R' }, body: 'reused\n' }));
		},
		{
			path: PATH,
			shown: `${broken('ONE\n.\n.\nbob\n')}${note('reused\n', 'R')}`,
			server: note('reused\n', 'R'),
			repair: note('reused\n', 'R2'),
			repaired: note('reused\n', 'R2'),
		},
	));

test("held text survives another device's applied send", () =>
	heldThrough(
		async (_, { bob }) => {
			const read = await bob.repo.notes.get({ stem: 'a' });
			if (read === null) throw new Error('Bob reads the note');
			const verdict = expectOk(await bob.repo.send((send) => send.notes.write({ stem: 'a' }, { body: 'ONE\n.\n.\nsent\n' }, { from: read })));
			expect(verdict.kind).toBe('applied');
		},
		{
			path: PATH,
			shown: broken('ONE\n.\n.\nsent\n'),
			server: note('ONE\n.\n.\nsent\n'),
			repair: note('ONE\n.\n.\nsent\n', 'B'),
			repaired: note('ONE\n.\n.\nsent\n', 'B'),
		},
	));

test('held text over a create whose reply was lost is not joined with that create when the server says hello', async () => {
	const t = await setup();
	const alice = t.device('alice', join(t.dir, 'alice.sqlite'));
	await alice.repo.flush();
	// The create lands, but its reply is lost and Alice goes offline.
	alice.transport.dropNextReply();
	expectOk(await alice.repo.files.writeText(PATH, note('one\n')));
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe(note('one\n'));
	expectOk(await alice.repo.files.writeText(PATH, broken('one\n')));
	// Back online, the hello brings her own create, and the retry is answered from its receipt.
	alice.transport.setOnline(true);
	await alice.repo.flush();
	await alice.repo.flush();
	expect(await alice.repo.files.readText(PATH)).toMatchObject({ text: broken('one\n'), sync: { state: 'held', reason: 'unparseable' } });
	await alice.restart();
	expect(await alice.repo.files.readText(PATH)).toMatchObject({ text: broken('one\n'), sync: { state: 'held' } });
	expectOk(await alice.repo.files.writeText(PATH, note('two\n')));
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe(note('two\n'));
	expect((await alice.repo.files.readText(PATH))?.sync).toEqual({ state: 'synced' });
	await t.cleanup();
});

test('a merge that makes held text parse queues it at once', async () => {
	const t = await setup();
	const alice = t.device('alice', join(t.dir, 'alice.sqlite'));
	const bob = t.device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	await alice.repo.flush();
	await bob.repo.flush();
	// Held: the title given twice.
	expectOk(await alice.repo.files.writeText(PATH, broken('one\n')));
	await alice.restart();
	// Bob removes the title Alice gave twice, which leaves hers once.
	expectOk(await bob.repo.files.writeText(PATH, '---\n---\none\n'));
	await bob.repo.flush();
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe('---\ntitle: B\n---\none\n');
	expect((await alice.repo.files.readText(PATH))?.sync).toEqual({ state: 'synced' });
	await t.cleanup();
});

test('a repair from a held state starts from what the server will have, while an earlier write is in flight', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	await alice.repo.flush();
	alice.hold();
	expectOk(await alice.repo.files.writeText(PATH, note('two\n')));
	await Bun.sleep(5);
	expectOk(await alice.repo.files.writeText(PATH, broken('two\n')));
	expect((await alice.repo.files.readText(PATH))?.sync).toMatchObject({ state: 'held' });
	expectOk(await alice.repo.files.writeText(PATH, note('three\n')));
	expect((await alice.repo.files.readText(PATH))?.sync).toEqual({ state: 'sending' });
	alice.release();
	await alice.repo.flush();
	expect(alice.pushed.map((batch) => batch.changes)).toMatchObject([
		[{ kind: 'write', text: note('one\n') }],
		[{ kind: 'write', text: note('two\n') }],
		[{ kind: 'write', base: { hash: gitBlobHash(note('two\n')) }, text: note('three\n') }],
	]);
	expect(await t.server.read(PATH)).toBe(note('three\n'));
	await t.cleanup();
});

test("a callback's ready changes go together, and a held change waits alone, after the rename before it", async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	expectOk(await alice.repo.notes.create({ stem: 'c' }, { fields: { title: 'C' }, body: 'c\n' }));
	await alice.repo.flush();
	const pushes = alice.pushed.length;
	expectOk(
		await alice.repo.batch((batch) => {
			batch.notes.move({ stem: 'a' }, { stem: 'b' });
			batch.notes.set({ stem: 'c' }, 'mood', 'x');
		}),
	);
	// A raw write through the new path, in its own callback, holds there.
	expectOk(await alice.repo.files.writeText('notes/b.md', broken('one\n')));
	await alice.repo.flush();
	expect(alice.pushed.slice(pushes).map((batch) => batch.changes.map((change) => change.kind))).toEqual([['move', 'write']]);
	expect(await t.server.read('notes/b.md')).toBe(note('one\n'));
	expect(await alice.repo.files.readText('notes/b.md')).toMatchObject({ text: broken('one\n'), sync: { state: 'held' } });
	await t.cleanup();
});

test('a send naming a held path fails at once, a send with a breaking text is refused before it is numbered, and a field write on a held note is Unparseable', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	expectOk(await alice.repo.notes.create({ stem: 'b' }, { fields: { title: 'B' }, body: 'b\n' }));
	await alice.repo.flush();
	expectOk(await alice.repo.files.writeText(PATH, broken('one\n')));
	const pushes = alice.pushed.length;
	expect(expectErr(await alice.repo.send((send) => send.notes.set({ stem: 'a' }, 'mood', 'x', { from: 'latest' })))).toMatchObject({
		name: 'Held',
		path: PATH,
	});
	// An append that opens frontmatter that never closes.
	expectOk(await alice.repo.notes.create({ stem: 'e' }, {}));
	await alice.repo.flush();
	const sent = alice.pushed.length;
	expect(expectErr(await alice.repo.send((send) => send.notes.append({ stem: 'e' }, '---\ntitle: [\n---\n', { from: 'latest' })))).toMatchObject({
		name: 'Unparseable',
		path: 'notes/e.md',
	});
	expectOk(await alice.repo.notes.set({ stem: 'b' }, 'mood', 'y'));
	await alice.repo.flush();
	// The refused send took no number: the next batch is numbered right after the last one sent.
	expect(alice.pushed.slice(sent).map((batch) => batch.n)).toEqual([(alice.pushed[sent - 1]?.n ?? 0) + 1]);
	expect(expectErr(await alice.repo.notes.set({ stem: 'a' }, 'mood', 'x'))).toMatchObject({ name: 'Unparseable', path: PATH });
	expect(expectErr(await alice.repo.notes.write({ stem: 'a' }, { body: 'two\n' }))).toMatchObject({ name: 'Unparseable', path: PATH });
	expect(alice.pushed.slice(pushes).every((batch) => sentTo([batch], PATH).length === 0)).toBe(true);
	await t.cleanup();
});

test('a change of sync state alone notifies a live read', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	await alice.repo.flush();
	const states: string[] = [];
	const stop = alice.repo.notes.live().subscribe((notes) => states.push(notes.map((n) => n.sync.state).join()));
	await alice.repo.flush();
	alice.hold();
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'mood', 'x'));
	// Its push is in flight, so flush would wait for it.
	await Bun.sleep(10);
	expect(states.at(-1)).toBe('sending');
	const opened = await alice.repo.notes.open({ stem: 'a' });
	expect(opened.read()?.sync).toEqual({ state: 'sending' });
	alice.release();
	await alice.repo.flush();
	expect(states.at(-1)).toBe('synced');
	expect(opened.read()?.sync).toEqual({ state: 'synced' });
	expect(await alice.repo.files.list({ sync: 'sending' })).toEqual([]);
	stop();
	opened.close();
	await t.cleanup();
});
