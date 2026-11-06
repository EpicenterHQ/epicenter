/**
 * The platform's folder operations end to end (ADR-0811, ADR-0819): each
 * person's Epicenter folder a directory in Bun, and the real server on a
 * disposable Postgres with the Git and LFS disk stores
 * (`startRepositoryServer`), every person signed in as the CLI is, reaching
 * every folder they hold. Requires initdb and pg_ctl on PATH.
 *
 * Key behaviors:
 * - The home lists each folder with its title and state
 * - A share lands in the other person's Epicenter folder once accepted
 * - A first sync joins the folder its manifest names, or makes one
 * - A copied folder sends nothing until the person says what it is
 * - Two syncs of one folder at once lose no edit (ADR-0819)
 * - One request finds which folders moved, and only those sync
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { startRepositoryServer } from '../../../server/src/test-helpers/repository-server.js';
import { epicenterRoot, localFolder } from '../device/node-root.js';
import { nodeStore } from '../device/node-store.js';
import { listFolders, shareFolder } from '../remote/folders.js';
import { folderRepository } from '../remote/repository.js';
import { scratch } from '../scratch.test-support.js';
import type { Repository } from '../sync/repository.js';
import { storeManifest, sync } from '../sync/sync.js';
import { listHome } from './epicenter-folder.js';
import { initFolder } from './init.js';
import { type KeptState, keepEverySynced } from './keep-synced.js';
import { acceptIntoHome, syncEvery, syncFolder } from './sync-folder.js';

let server: Awaited<ReturnType<typeof startRepositoryServer>>;
const roots: string[] = [];

beforeAll(async () => {
	server = await startRepositoryServer();
}, 120_000);

afterAll(async () => {
	await server?.stop();
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A person with an Epicenter folder of their own. */
async function person(label: string) {
	const account = await server.signIn(label);
	const home = await scratch(`epicenter-home-${label}-`);
	roots.push(home);
	return { account, home, root: epicenterRoot(join(home, 'Epicenter')) };
}

/** Make the directory `name` in `home`'s Epicenter folder, holding `files`. */
async function folderWith(
	home: string,
	name: string,
	files: Record<string, string>,
) {
	const path = join(home, 'Epicenter', name);
	for (const [file, text] of Object.entries(files)) {
		await mkdir(join(path, file, '..'), { recursive: true });
		await writeFile(join(path, file), text);
	}
	return expectOk(await localFolder(path));
}

const synced = (result: Awaited<ReturnType<typeof syncFolder>>) => {
	const done = expectOk(result);
	if (done.kind !== 'synced')
		throw new Error(`expected a sync, got ${done.kind}`);
	return done;
};

const note = (title: string, body = '') =>
	`---\ntitle: ${JSON.stringify(title)}\n---\n${body}`;

test('init proposes a contract; a first sync makes the folder; a share lands in the other Epicenter folder once accepted; the home shows each state', async () => {
	const alice = await person('home-alice');
	const bob = await person('home-bob');
	const books = await folderWith(alice.home, 'books', {
		'books/dune.md': note('Dune'),
		'covers/dune.jpg': 'jpeg bytes',
	});
	const proposed = expectOk(
		await initFolder({
			store: books.store,
			title: 'Reading list',
			path: books.path,
		}),
	);
	expect(proposed.written).toBe(true);
	expect(proposed.contract.collections).toEqual({
		books: { path: 'books/{name}.md', fields: { title: { type: 'string' } } },
		covers: { path: 'covers/{name}.jpg' },
	});
	await folderWith(alice.home, 'scratch', { 'notes/a.md': note('A') });

	// Before syncing, both folders are local.
	const before = expectOk(await listHome({ root: alice.root }));
	expect(
		before.folders.map(({ name, title, state }) => [name, title, state]),
	).toEqual([
		['books', 'Reading list', 'local'],
		['scratch', null, 'local'],
	]);

	const first = synced(
		await syncFolder({
			account: alice.account,
			store: books.store,
			identity: books.identity,
		}),
	);
	expect(first.made).toBe(true);
	expect(first.report.pushed.sort()).toEqual([
		'books/dune.md',
		'covers/dune.jpg',
		'epicenter.json',
	]);
	const { folder } = first;

	expectOk(
		await shareFolder(alice.account, { folder, email: bob.account.email }),
	);
	// Unaccepted, it is invisible among Bob's folders, and waits for him.
	const waiting = expectOk(
		await listHome({ root: bob.root, account: bob.account }),
	);
	expect(waiting.folders).toEqual([]);
	expect(waiting.elsewhere).toEqual([]);
	expect(waiting.pending.map((share) => [share.folder, share.title])).toEqual([
		[folder, 'Reading list'],
	]);

	const accepted = expectOk(
		await acceptIntoHome({ account: bob.account, root: bob.root, folder }),
	);
	expect(accepted.local.name).toBe('Reading list');
	expect(
		await readFile(join(accepted.local.path, 'books/dune.md'), 'utf8'),
	).toBe(note('Dune'));
	const bobs = expectOk(
		await listHome({ root: bob.root, account: bob.account }),
	);
	expect(bobs.pending).toEqual([]);
	expect(bobs.folders).toMatchObject([
		{ name: 'Reading list', title: 'Reading list', state: 'shared', folder },
	]);
	expect(bobs.folders[0]?.members?.map(({ email }) => email)).toEqual([
		alice.account.email,
		bob.account.email,
	]);
	const alices = expectOk(
		await listHome({ root: alice.root, account: alice.account }),
	);
	expect(alices.folders.map(({ name, state }) => [name, state])).toEqual([
		['books', 'shared'],
		['scratch', 'local'],
	]);
}, 120_000);

test('a first sync joins the folder its manifest names when the person holds it, and makes one when they do not', async () => {
	const alice = await person('join-alice');
	const carol = await person('join-carol');
	const desk = await folderWith(alice.home, 'notes', { 'a.md': note('A') });
	const { folder } = synced(
		await syncFolder({
			account: alice.account,
			store: desk.store,
			identity: desk.identity,
		}),
	);
	// The folder reaches another computer with its manifest naming the
	// folder and nothing agreed, as a hand-made copy of `.epicenter` would.
	const manifest = JSON.stringify({ folder, commit: null, files: {} });
	const laptop = await folderWith(alice.home, 'notes-laptop', {
		'b.md': note('B'),
		'.epicenter/synced.json': manifest,
	});
	const joined = synced(
		await syncFolder({
			account: alice.account,
			store: laptop.store,
			identity: laptop.identity,
		}),
	);
	expect(joined).toMatchObject({ folder, made: false });
	expect(await readFile(join(laptop.path, 'a.md'), 'utf8')).toBe(note('A'));
	// Carol holds no such folder: her first sync makes her own.
	const hers = await folderWith(carol.home, 'notes', {
		'c.md': note('C'),
		'.epicenter/synced.json': manifest,
	});
	const made = synced(
		await syncFolder({
			account: carol.account,
			store: hers.store,
			identity: hers.identity,
		}),
	);
	expect(made.made).toBe(true);
	expect(made.folder).not.toBe(folder);
	expect(made.report.pushed).toEqual(['c.md']);
}, 120_000);

test('a copied folder sends nothing until the person says it is new, and the original keeps syncing as itself', async () => {
	const alice = await person('copy-alice');
	const original = await folderWith(alice.home, 'Diary', {
		'days/one.md': note('One'),
	});
	const { folder } = synced(
		await syncFolder({
			account: alice.account,
			store: original.store,
			identity: original.identity,
		}),
	);
	const repository = folderRepository(alice.account, folder);
	const head = expectOk(await repository.changes(null)).commit;

	// A Finder duplicate: the same files and manifest, in another directory.
	const copyPath = join(alice.home, 'Epicenter', 'Diary copy');
	await cp(original.path, copyPath, { recursive: true });
	await writeFile(join(copyPath, 'days/private.md'), note('Private'));
	const copy = expectOk(await localFolder(copyPath));
	expect(
		expectOk(
			await syncFolder({
				account: alice.account,
				store: copy.store,
				identity: copy.identity,
			}),
		),
	).toEqual({ kind: 'copy', copyOf: folder });
	expect(expectOk(await repository.changes(null)).commit).toBe(head);
	const home = expectOk(
		await listHome({ root: alice.root, account: alice.account }),
	);
	expect(
		home.folders.map(({ name, state, copyOf }) => [name, state, copyOf]),
	).toEqual([
		['Diary', 'synced', null],
		['Diary copy', 'local', folder],
	]);

	const answered = synced(
		await syncFolder({
			account: alice.account,
			store: copy.store,
			identity: copy.identity,
			copy: 'new',
		}),
	);
	expect(answered.made).toBe(true);
	expect(answered.folder).not.toBe(folder);
	expect(answered.report.pushed.sort()).toEqual([
		'days/one.md',
		'days/private.md',
	]);
	// The original never saw the copy's private note.
	expect(expectOk(await repository.changes(null)).commit).toBe(head);
	expect(
		expectOk(await repository.tree(head as string)).map(({ path }) => path),
	).not.toContain('days/private.md');
	// Moved within its disk, a folder keeps its identity, and syncs as itself.
	const moved = join(alice.home, 'Epicenter', 'Diary moved');
	await rename(original.path, moved);
	const again = expectOk(await localFolder(moved));
	expect(
		synced(
			await syncFolder({
				account: alice.account,
				store: again.store,
				identity: again.identity,
			}),
		).folder,
	).toBe(folder);
}, 120_000);

/**
 * A repository whose first commit waits until `release` resolves, so two
 * syncs of one folder can be made to overlap at their commits.
 */
function held(repository: Repository, release: Promise<void>): Repository {
	let first = true;
	return {
		...repository,
		async commit(writes) {
			if (first) {
				first = false;
				await release;
			}
			return repository.commit(writes);
		},
	};
}

test('two syncs of one folder at once lose no edit: the slower re-runs after its commit or its manifest is refused', async () => {
	const alice = await person('two-syncers');
	const desk = await folderWith(alice.home, 'Studio', {
		'notes/a.md': note('A', 'one\ntwo\nthree\n'),
		'notes/b.md': note('B'),
	});
	const { folder } = synced(
		await syncFolder({
			account: alice.account,
			store: desk.store,
			identity: desk.identity,
		}),
	);
	// Another computer changes a's first line and adds c; it lands first.
	const laptop = await scratch('epicenter-laptop-');
	roots.push(laptop);
	await mkdir(join(laptop, '.epicenter'), { recursive: true });
	await writeFile(
		join(laptop, '.epicenter/synced.json'),
		JSON.stringify({ folder, commit: null, files: {} }),
	);
	const laptopStore = nodeStore(laptop);
	const remote = () => folderRepository(alice.account, folder);
	expectOk(
		await sync({
			local: laptopStore,
			remote: remote(),
			manifest: storeManifest(laptopStore),
		}),
	);
	await writeFile(join(laptop, 'notes/a.md'), note('A', 'ONE\ntwo\nthree\n'));
	await writeFile(join(laptop, 'notes/c.md'), note('C'));
	expectOk(
		await sync({
			local: laptopStore,
			remote: remote(),
			manifest: storeManifest(laptopStore),
		}),
	);

	// Here, a's last line and b change, and two programs (an app and the
	// Epicenter app, say) sync this one folder at once.
	await writeFile(
		join(desk.path, 'notes/a.md'),
		note('A', 'one\ntwo\nTHREE\n'),
	);
	await writeFile(join(desk.path, 'notes/b.md'), note('B', 'edited here\n'));
	let release = () => {};
	const fast = new Promise<void>((resolve) => {
		release = resolve;
	});
	const slow = sync({
		local: nodeStore(desk.path),
		remote: held(remote(), fast),
		manifest: storeManifest(nodeStore(desk.path)),
	});
	const quick = sync({
		local: nodeStore(desk.path),
		remote: remote(),
		manifest: storeManifest(nodeStore(desk.path)),
	});
	const quickReport = expectOk(await quick);
	release();
	const slowReport = expectOk(await slow);
	expect(quickReport.outcome).toBe('synced');
	expect(slowReport.outcome).toBe('synced');
	// The slow one found the repository or the manifest moved, and ran again.
	expect(slowReport.passes).toBeGreaterThan(1);

	const merged = note('A', 'ONE\ntwo\nTHREE\n');
	expect(await readFile(join(desk.path, 'notes/a.md'), 'utf8')).toBe(merged);
	expect(await readFile(join(desk.path, 'notes/b.md'), 'utf8')).toBe(
		note('B', 'edited here\n'),
	);
	expect(await readFile(join(desk.path, 'notes/c.md'), 'utf8')).toBe(note('C'));
	// The server holds every edit, and the laptop takes them.
	expectOk(
		await sync({
			local: laptopStore,
			remote: remote(),
			manifest: storeManifest(laptopStore),
		}),
	);
	expect(await readFile(join(laptop, 'notes/a.md'), 'utf8')).toBe(merged);
	expect(await readFile(join(laptop, 'notes/b.md'), 'utf8')).toBe(
		note('B', 'edited here\n'),
	);
	// A sync after both changes nothing: they agreed.
	const after = synced(
		await syncFolder({
			account: alice.account,
			store: desk.store,
			identity: desk.identity,
		}),
	);
	expect(after.report).toMatchObject({ pulled: [], pushed: [], merged: [] });
}, 120_000);

test('one request finds which folders moved, and only those sync', async () => {
	const alice = await person('every');
	const still = await folderWith(alice.home, 'Still', { 'a.md': note('A') });
	const busy = await folderWith(alice.home, 'Busy', { 'b.md': note('B') });
	const edited = await folderWith(alice.home, 'Edited', { 'c.md': note('C') });
	await folderWith(alice.home, 'Never synced', { 'd.md': note('D') });
	for (const local of [still, busy, edited])
		synced(
			await syncFolder({
				account: alice.account,
				store: local.store,
				identity: local.identity,
			}),
		);
	// Busy moves on the server; Edited changes here.
	const busyId = JSON.parse(
		await readFile(join(busy.path, '.epicenter/synced.json'), 'utf8'),
	).folder as string;
	const other = await scratch('epicenter-other-');
	roots.push(other);
	await mkdir(join(other, '.epicenter'), { recursive: true });
	await writeFile(
		join(other, '.epicenter/synced.json'),
		JSON.stringify({ folder: busyId, commit: null, files: {} }),
	);
	const otherStore = nodeStore(other);
	expectOk(
		await sync({
			local: otherStore,
			remote: folderRepository(alice.account, busyId),
			manifest: storeManifest(otherStore),
		}),
	);
	await writeFile(join(other, 'b2.md'), note('B2'));
	expectOk(
		await sync({
			local: otherStore,
			remote: folderRepository(alice.account, busyId),
			manifest: storeManifest(otherStore),
		}),
	);
	await writeFile(join(edited.path, 'c.md'), note('C', 'edited\n'));

	// Every request the round sends, by method and path.
	const sent: string[] = [];
	const counted = {
		...alice.account,
		fetch(input: Request | string | URL, init?: RequestInit) {
			const url = new URL(input instanceof Request ? input.url : input);
			sent.push(`${init?.method ?? 'GET'} ${url.pathname}`);
			return alice.account.fetch(input, init);
		},
	};
	const stillId = JSON.parse(
		await readFile(join(still.path, '.epicenter/synced.json'), 'utf8'),
	).folder as string;
	const every = expectOk(
		await syncEvery({ account: counted, root: alice.root }),
	);
	expect(
		every.map(({ name, result, waiting }) => [
			name,
			waiting
				? 'waiting'
				: result === undefined
					? 'still'
					: expectOk(result).kind,
		]),
	).toEqual([
		['Busy', 'synced'],
		['Edited', 'synced'],
		['Never synced', 'waiting'],
		['Still', 'still'],
	]);
	// One answer named where every folder is: Still was never asked about.
	expect(sent.filter((request) => request.endsWith('/folders'))).toEqual([
		'GET /git/folders',
	]);
	expect(sent.some((request) => request.includes(stillId))).toBe(false);
	expect(await readFile(join(busy.path, 'b2.md'), 'utf8')).toBe(note('B2'));
	expect(
		expectOk(await listFolders(alice.account)).folders.map(({ id }) => id),
	).toHaveLength(3);
	// Nothing moved since: the next round sends that one request and nothing else.
	sent.length = 0;
	const next = expectOk(
		await syncEvery({ account: counted, root: alice.root }),
	);
	expect(next.every(({ result }) => result === undefined)).toBe(true);
	expect(sent).toEqual(['GET /git/folders']);
}, 120_000);

test('kept in sync, a change here reaches the server and a change there arrives, each folder marked', async () => {
	const alice = await person('kept');
	const notes = await folderWith(alice.home, 'Notes', { 'a.md': note('A') });
	await folderWith(alice.home, 'Local only', { 'b.md': note('B') });
	const first = synced(
		await syncFolder({
			account: alice.account,
			store: notes.store,
			identity: notes.identity,
		}),
	);
	const kept = keepEverySynced({
		account: alice.account,
		root: alice.root,
		afterChangeMs: 50,
		checkEveryMs: 200,
	});
	/** Wait until `ready` holds of the loop's state. */
	const until = (ready: (state: KeptState) => boolean) =>
		new Promise<KeptState>((resolve) => {
			const check = () => {
				const state = kept.state();
				if (!ready(state)) return;
				stop();
				resolve(state);
			};
			const stop = kept.subscribe(check);
			check();
		});
	try {
		const markOf = (state: KeptState, name: string) =>
			state.marks.get(join(alice.home, 'Epicenter', name))?.mark;
		// A watch may report a file written just before it started, which a
		// round after the burst settles: wait for the mark, not the first round.
		const settled = await until(
			(state) => state.last !== null && markOf(state, 'Notes') === 'synced',
		);
		expect(markOf(settled, 'Local only')).toBe('waiting');

		// A change here is heard, marked waiting, and synced after the burst.
		await writeFile(join(notes.path, 'a.md'), note('A', 'edited here\n'));
		await until((state) => markOf(state, 'Notes') === 'waiting');
		await until((state) => markOf(state, 'Notes') === 'synced');
		const remote = folderRepository(alice.account, first.folder);
		const [file] = expectOk(await remote.read(['a.md']));
		expect(
			file !== undefined &&
				!('gone' in file) &&
				new TextDecoder().decode(file.bytes),
		).toBe(note('A', 'edited here\n'));

		// A change on the server arrives at the next check.
		expectOk(
			await remote.put('c.md', new TextEncoder().encode(note('C')), null),
		);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const there = await readFile(join(notes.path, 'c.md'), 'utf8').catch(
				() => null,
			);
			if (there !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(await readFile(join(notes.path, 'c.md'), 'utf8')).toBe(note('C'));
	} finally {
		kept[Symbol.dispose]();
	}
}, 120_000);
