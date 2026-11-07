/**
 * The platform's folder operations end to end (ADR-0811, ADR-0819,
 * ADR-0822): each person's Epicenter folder a directory in Bun, and the real
 * server on a disposable Postgres with the disk blob store
 * (`startRepositoryServer`), every person signed in as the CLI is, reaching
 * every folder they hold. Requires initdb and pg_ctl on PATH.
 *
 * Key behaviors:
 * - The home lists each folder with its title and state
 * - A share lands in the other person's Epicenter folder once accepted
 * - A folder's record is kept at the Epicenter folder's root, never in it
 * - Two syncs of one folder at once lose no edit (ADR-0819)
 * - One request finds which folders moved, and only those sync
 * - Kept in sync, each folder carries its mark
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { startRepositoryServer } from '../../../server/src/test-helpers/repository-server.js';
import { localFolder } from '../device/node-root.js';
import { listFolders, shareFolder } from '../remote/folders.js';
import { folderRepository } from '../remote/repository.js';
import type { Repository } from '../sync/repository.js';
import { sync } from '../sync/sync.js';
import { listHome } from './epicenter-folder.js';
import { initFolder } from './init.js';
import { type KeptState, keepEverySynced } from './keep-synced.js';
import {
	cleanUp,
	computer,
	contract,
	note,
	person,
	synced,
} from './platform.postgres.test-support.js';
import { recordsIn } from './records.js';
import { acceptIntoHome, syncEvery } from './sync-folder.js';

let server: Awaited<ReturnType<typeof startRepositoryServer>>;

beforeAll(async () => {
	server = await startRepositoryServer();
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await cleanUp();
});

test('init proposes a contract; a first sync makes the folder; a share lands in the other Epicenter folder once accepted; the home shows each state', async () => {
	const alice = await person(server, 'home-alice');
	const bob = await person(server, 'home-bob');
	await alice.desk.write('books', {
		'books/dune.md': note('Dune'),
		'covers/dune.jpg': 'jpeg bytes',
	});
	const books = expectOk(await localFolder(join(alice.desk.path, 'books')));
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
	await alice.desk.write('scratch', { 'notes/a.md': note('A') });

	// Before syncing, both folders are local.
	const before = expectOk(await listHome({ root: alice.desk.root }));
	expect(
		before.folders.map(({ name, title, state }) => [name, title, state]),
	).toEqual([
		['books', 'Reading list', 'local'],
		['scratch', null, 'local'],
	]);

	const first = synced(await alice.desk.sync('books'));
	expect(first.made).toBe(true);
	expect(first.report.pushed.sort()).toEqual([
		'books/dune.md',
		'covers/dune.jpg',
		'epicenter.json',
	]);
	const { folder } = first;
	// Its record is at the Epicenter folder's root; the folder holds only its files.
	expect(await readdir(join(alice.desk.path, '.epicenter', 'synced'))).toEqual(
		[`${folder}.json`],
	);
	expect((await readdir(books.path)).sort()).toEqual([
		'books',
		'covers',
		'epicenter.json',
	]);

	expectOk(
		await shareFolder(alice.account, { folder, email: bob.account.email }),
	);
	// Unaccepted, it is invisible among Bob's folders, and waits for him.
	const waiting = expectOk(
		await listHome({ root: bob.desk.root, account: bob.account }),
	);
	expect(waiting.folders).toEqual([]);
	expect(waiting.elsewhere).toEqual([]);
	expect(waiting.pending.map((share) => [share.folder, share.title])).toEqual([
		[folder, 'Reading list'],
	]);

	const accepted = expectOk(
		await acceptIntoHome({
			account: bob.account,
			root: bob.desk.root,
			folder,
		}),
	);
	expect(accepted.local.name).toBe('Reading list');
	expect(
		await readFile(join(accepted.local.path, 'books/dune.md'), 'utf8'),
	).toBe(note('Dune'));
	const bobs = expectOk(
		await listHome({ root: bob.desk.root, account: bob.account }),
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
		await listHome({ root: alice.desk.root, account: alice.account }),
	);
	expect(alices.folders.map(({ name, state }) => [name, state])).toEqual([
		['books', 'shared'],
		['scratch', 'local'],
	]);
}, 120_000);

/**
 * A repository whose first append waits until `release` resolves, so two
 * syncs of one folder can be made to overlap at their appends.
 */
function held(repository: Repository, release: Promise<void>): Repository {
	let first = true;
	return {
		...repository,
		async append(writes) {
			if (first) {
				first = false;
				await release;
			}
			return repository.append(writes);
		},
	};
}

test('two syncs of one folder at once lose no edit: the slower re-runs after its append or its record is refused', async () => {
	const alice = await person(server, 'two-syncers');
	await alice.desk.write('Studio', {
		'epicenter.json': contract('Studio'),
		'notes/a.md': note('A', 'one\ntwo\nthree\n'),
		'notes/b.md': note('B'),
	});
	const { folder } = synced(await alice.desk.sync('Studio'));
	// Another computer of hers joins it, changes a's first line and adds c; it lands first.
	const laptop = await computer(alice.account, 'two-syncers-laptop');
	await laptop.write('Studio', { 'epicenter.json': contract('Studio') });
	expect(synced(await laptop.sync('Studio')).joined).toBe(true);
	await laptop.write('Studio', {
		'notes/a.md': note('A', 'ONE\ntwo\nthree\n'),
		'notes/c.md': note('C'),
	});
	synced(await laptop.sync('Studio'));

	// Here, a's last line and b change, and two programs (the CLI and the
	// Epicenter app, say) sync this one folder at once.
	const desk = join(alice.desk.path, 'Studio');
	await writeFile(join(desk, 'notes/a.md'), note('A', 'one\ntwo\nTHREE\n'));
	await writeFile(join(desk, 'notes/b.md'), note('B', 'edited here\n'));
	const records = expectOk(await alice.desk.root.records());
	const local = expectOk(await localFolder(desk));
	const remote = () => folderRepository(alice.account, folder);
	let release = () => {};
	const fast = new Promise<void>((resolve) => {
		release = resolve;
	});
	const slow = sync({
		local: local.store,
		remote: held(remote(), fast),
		manifest: records.manifest(folder),
	});
	const quick = sync({
		local: local.store,
		remote: remote(),
		manifest: recordsIn(records.store).manifest(folder),
	});
	const quickReport = expectOk(await quick);
	release();
	const slowReport = expectOk(await slow);
	expect(quickReport.outcome).toBe('synced');
	expect(slowReport.outcome).toBe('synced');
	// The slow one found the repository or the record moved, and ran again.
	expect(slowReport.passes).toBeGreaterThan(1);

	const merged = note('A', 'ONE\ntwo\nTHREE\n');
	expect(await readFile(join(desk, 'notes/a.md'), 'utf8')).toBe(merged);
	expect(await readFile(join(desk, 'notes/b.md'), 'utf8')).toBe(
		note('B', 'edited here\n'),
	);
	expect(await readFile(join(desk, 'notes/c.md'), 'utf8')).toBe(note('C'));
	// The server holds every edit, and the laptop takes them.
	synced(await laptop.sync('Studio'));
	expect(
		await readFile(join(laptop.path, 'Studio/notes/a.md'), 'utf8'),
	).toBe(merged);
	// A sync after both changes nothing: they agreed, and the record names the folder still.
	const after = synced(await alice.desk.sync('Studio'));
	expect(after.report).toMatchObject({ pulled: [], pushed: [], merged: [] });
	expect(await alice.desk.boundTo('Studio')).toBe(folder);
}, 120_000);

test('one request finds which folders moved, and only those sync', async () => {
	const alice = await person(server, 'every');
	for (const name of ['Still', 'Busy', 'Edited', 'Never synced'])
		await alice.desk.write(name, {
			'epicenter.json': contract(name),
			[`${name}.md`]: note(name),
		});
	for (const name of ['Still', 'Busy', 'Edited'])
		synced(await alice.desk.sync(name));
	const busyId = (await alice.desk.boundTo('Busy')) as string;
	const stillId = (await alice.desk.boundTo('Still')) as string;
	// Busy moves on the server, from her laptop; Edited changes here.
	const laptop = await computer(alice.account, 'every-laptop');
	await laptop.write('Busy', { 'epicenter.json': contract('Busy') });
	synced(await laptop.sync('Busy'));
	await laptop.write('Busy', { 'b2.md': note('B2') });
	synced(await laptop.sync('Busy'));
	await alice.desk.write('Edited', { 'Edited.md': note('Edited', 'edited\n') });

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
	const every = expectOk(
		await syncEvery({ account: counted, root: alice.desk.root }),
	);
	expect(
		every.folders.map(({ name, result, waiting }) => [
			name,
			waiting ??
				(result === undefined ? 'still' : expectOk(result).kind),
		]),
	).toEqual([
		['Busy', 'synced'],
		['Edited', 'synced'],
		['Never synced', 'local'],
		['Still', 'still'],
	]);
	// One answer named where every folder is: Still was never asked about.
	expect(sent.filter((request) => request.endsWith('/folders'))).toEqual([
		'GET /folders',
	]);
	expect(sent.some((request) => request.includes(stillId))).toBe(false);
	expect(
		await readFile(join(alice.desk.path, 'Busy/b2.md'), 'utf8'),
	).toBe(note('B2'));
	expect(
		expectOk(await listFolders(alice.account)).folders.map(({ id }) => id),
	).toContain(busyId);
	// Nothing moved since: the next round sends that one request and nothing
	// else, a folder not synced here that no app made included.
	sent.length = 0;
	const next = expectOk(
		await syncEvery({ account: counted, root: alice.desk.root }),
	);
	expect(next.folders.every(({ result }) => result === undefined)).toBe(true);
	expect(sent).toEqual(['GET /folders']);
}, 120_000);

test('kept in sync, a change here reaches the server and a change there arrives, each folder marked', async () => {
	const alice = await person(server, 'kept');
	await alice.desk.write('Notes', {
		'epicenter.json': contract('Notes'),
		'a.md': note('A'),
	});
	await alice.desk.write('Local only', { 'b.md': note('B') });
	const first = synced(await alice.desk.sync('Notes'));
	const notes = join(alice.desk.path, 'Notes');
	const kept = keepEverySynced({
		account: alice.account,
		root: alice.desk.root,
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
			state.marks.get(join(alice.desk.path, name))?.mark;
		// A watch may report a file written just before it started, which a
		// round after the burst settles: wait for the mark, not the first round.
		const settled = await until(
			(state) => state.last !== null && markOf(state, 'Notes') === 'synced',
		);
		expect(markOf(settled, 'Local only')).toBe('waiting');

		// A change here is heard, marked waiting, and synced after the burst.
		await writeFile(join(notes, 'a.md'), note('A', 'edited here\n'));
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
			const there = await readFile(join(notes, 'c.md'), 'utf8').catch(
				() => null,
			);
			if (there !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(await readFile(join(notes, 'c.md'), 'utf8')).toBe(note('C'));
	} finally {
		kept[Symbol.dispose]();
	}
}, 120_000);
