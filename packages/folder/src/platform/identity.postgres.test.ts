/**
 * Which directory is which folder (ADR-0822), end to end: each computer an
 * Epicenter folder in Bun, and the real server on a disposable Postgres
 * (`startRepositoryServer`). Every scenario is one a reviewer found could
 * push deletions or lose an edit when a record is trusted for the wrong
 * directory. Requires initdb and pg_ctl on PATH.
 *
 * Key behaviors:
 * - A copy stays local; deleting the original deletes nothing on the server
 * - Swapped names, and a rename beside a copy, follow each directory's identity
 * - A migration (every inode new) keeps a folder held alone syncing from its
 *   agreed state, and offers a shared one, selected, in the question
 * - A new private folder named like an idle shared one, with its files,
 *   stays unbound
 * - An inode reused where there is no birth time proves nothing
 * - A drive mounted again (another device number) keeps its folders
 * - An app's folder renamed is followed; its usual path made again is a
 *   folder of its own, and nothing is deleted
 * - An older backup restored in place stops at the deletion guard
 * - A lost record finds its folder again instead of making a second one
 * - A folder Git keeps never syncs; an Epicenter folder inside a file-sync
 *   service is refused
 * - An old in-folder manifest is imported once, its recordings recovered
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	cp,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { isHiddenPath } from '@epicenter/definition/contract';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { startRepositoryServer } from '../../../server/src/test-helpers/repository-server.js';
import { acceptShare, listFolders, shareFolder } from '../remote/folders.js';
import { folderRepository } from '../remote/repository.js';
import { scratch } from '../scratch.test-support.js';
import type { KnownApp } from './apps.js';
import { listHome } from './epicenter-folder.js';
import { identify } from './identify.js';
import {
	cleanUp,
	computer,
	contract,
	note,
	person,
	statSeam,
	synced,
} from './platform.postgres.test-support.js';
import { syncEvery } from './sync-folder.js';

let server: Awaited<ReturnType<typeof startRepositoryServer>>;

beforeAll(async () => {
	server = await startRepositoryServer();
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await cleanUp();
});

/** The server's head and its files' paths, for asserting nothing changed. */
async function serverState(
	account: Parameters<typeof folderRepository>[0],
	folder: string,
) {
	const repository = folderRepository(account, folder);
	const { cursor: head, files } = expectOk(await repository.files());
	const paths = files
		.map(({ path }) => path)
		.filter((path) => !isHiddenPath(path))
		.sort();
	return { head, paths };
}

test('a copy, edited, with its original deleted, deletes nothing on the server and joins it only when the person syncs it', async () => {
	const alice = await person(server, 'copy');
	await alice.desk.write('Diary', {
		'epicenter.json': contract('Diary'),
		'days/one.md': note('One'),
		'days/two.md': note('Two'),
	});
	const { folder } = synced(await alice.desk.sync('Diary'));
	const before = await serverState(alice.account, folder);

	// A Finder duplicate, edited, and then the original deleted.
	await cp(
		join(alice.desk.path, 'Diary'),
		join(alice.desk.path, 'Diary copy'),
		{
			recursive: true,
		},
	);
	await alice.desk.write('Diary copy', { 'days/three.md': note('Three') });
	await rm(join(alice.desk.path, 'Diary'), { recursive: true });

	const every = expectOk(
		await syncEvery({ account: alice.account, root: alice.desk.root }),
	);
	expect(every.folders.map(({ name, waiting }) => [name, waiting])).toEqual([
		['Diary copy', 'local'],
	]);
	expect(await serverState(alice.account, folder)).toEqual(before);

	// The person syncs the copy: its title matches the one folder she holds
	// alone, so it joins that folder from first contact, which deletes nothing.
	const home = expectOk(
		await listHome({ root: alice.desk.root, account: alice.account }),
	);
	expect(home.folders[0]?.question).toMatchObject({
		silent: folder,
		candidates: [{ folder: { id: folder }, matchedBy: 'title', alone: true }],
	});
	const joined = synced(await alice.desk.sync('Diary copy'));
	expect(joined).toMatchObject({ folder, joined: true, made: false });
	expect((await serverState(alice.account, folder)).paths).toEqual([
		'days/one.md',
		'days/three.md',
		'days/two.md',
		'epicenter.json',
	]);
}, 120_000);

test('two folders that swap names each follow their own identity', async () => {
	const alice = await person(server, 'swap');
	for (const name of ['Work', 'Home'])
		await alice.desk.write(name, {
			'epicenter.json': contract(name),
			[`${name}.md`]: note(name),
		});
	const work = synced(await alice.desk.sync('Work')).folder;
	const home = synced(await alice.desk.sync('Home')).folder;
	const at = (name: string) => join(alice.desk.path, name);
	await rename(at('Work'), at('swap'));
	await rename(at('Home'), at('Work'));
	await rename(at('swap'), at('Home'));

	expect(await alice.desk.boundTo('Home')).toBe(work);
	expect(await alice.desk.boundTo('Work')).toBe(home);
	// An edit in the directory now named Work reaches the folder it always was.
	await alice.desk.write('Work', { 'Home.md': note('Home', 'edited\n') });
	const ran = synced(await alice.desk.sync('Work'));
	expect(ran).toMatchObject({ folder: home, report: { pushed: ['Home.md'] } });
	expect((await serverState(alice.account, work)).paths).toEqual([
		'Work.md',
		'epicenter.json',
	]);
}, 120_000);

test('a folder renamed while a copy takes its old name: the renamed one is the folder, the copy is unbound', async () => {
	const alice = await person(server, 'rename-copy');
	await alice.desk.write('Recipes', {
		'epicenter.json': contract('Recipes'),
		'soup.md': note('Soup'),
	});
	const { folder } = synced(await alice.desk.sync('Recipes'));
	await rename(
		join(alice.desk.path, 'Recipes'),
		join(alice.desk.path, 'Cooking'),
	);
	// The copy has the record's name and exactly its files, but the record is
	// already the renamed directory's.
	await cp(join(alice.desk.path, 'Cooking'), join(alice.desk.path, 'Recipes'), {
		recursive: true,
	});
	const found = expectOk(
		await identify({ root: alice.desk.root, account: alice.account }),
	);
	expect(
		found.bound.map(({ local, record, proof }) => [
			local.name,
			record.folder,
			proof,
		]),
	).toEqual([['Cooking', folder, 'identity']]);
	expect(found.unbound.map(({ local }) => local.name)).toEqual(['Recipes']);
	// The record now names the directory by its new name.
	expect(found.bound[0]?.record.name).toBe('Cooking');
}, 120_000);

/** A new computer with `from`'s whole Epicenter folder copied over: every inode is new. */
async function migrated(
	from: Awaited<ReturnType<typeof computer>>,
	label: string,
) {
	const next = await computer(from.account, label);
	await rm(next.path, { recursive: true });
	await cp(from.path, next.path, { recursive: true });
	return next;
}

test('a migration keeps a folder held alone syncing from its agreed state, and asks about a shared one, offered selected', async () => {
	const alice = await person(server, 'migrate-alice');
	const bob = await person(server, 'migrate-bob');
	await alice.desk.write('Mine', {
		'epicenter.json': contract('Mine'),
		'keep.md': note('Keep'),
		'gone.md': note('Gone'),
	});
	await alice.desk.write('Ours', {
		'epicenter.json': contract('Ours'),
		'plan.md': note('Plan'),
	});
	const mine = synced(await alice.desk.sync('Mine')).folder;
	const ours = synced(await alice.desk.sync('Ours')).folder;
	expectOk(
		await shareFolder(alice.account, {
			folder: ours,
			email: bob.account.email,
		}),
	);
	expectOk(await acceptShare(bob.account, { folder: ours }));

	const laptop = await migrated(alice.desk, 'migrate-laptop');
	// Meanwhile the old computer deletes a note, which the server holds.
	await rm(join(alice.desk.path, 'Mine/gone.md'));
	synced(await alice.desk.sync('Mine'));

	const found = expectOk(
		await identify({ root: laptop.root, account: alice.account }),
	);
	expect(
		found.bound.map(({ local, record, proof }) => [
			local.name,
			record.folder,
			proof,
		]),
	).toEqual([['Mine', mine, 'files']]);
	// The record now names the new directory, so the next look proves it by identity.
	const again = expectOk(
		await identify({ root: laptop.root, account: alice.account }),
	);
	expect(again.bound.map(({ proof }) => proof)).toEqual(['identity']);
	// Synced from the agreed state, the deletion arrives rather than coming back.
	const ran = synced(await laptop.sync('Mine'));
	expect(ran.report.pulled).toEqual(['gone.md']);
	expect(await readdir(join(laptop.path, 'Mine'))).not.toContain('gone.md');
	expect((await serverState(alice.account, mine)).paths).not.toContain(
		'gone.md',
	);

	// The shared folder waits, offered selected, and never joins silently.
	const every = expectOk(
		await syncEvery({ account: alice.account, root: laptop.root }),
	);
	expect(every.folders.find(({ name }) => name === 'Ours')?.waiting).toBe(
		'local',
	);
	const asked = expectOk(await laptop.sync('Ours'));
	expect(asked).toMatchObject({
		kind: 'question',
		question: {
			preselected: ours,
			silent: null,
			candidates: [{ folder: { id: ours }, alone: false }],
		},
	});
	expect(
		synced(await laptop.sync('Ours', { answer: { join: ours } })),
	).toMatchObject({ folder: ours, joined: true });
}, 120_000);

test('an idle shared folder deleted here, and a new private one with its name and identical epicenter.json, stays unbound', async () => {
	const alice = await person(server, 'inbox-alice');
	const bob = await person(server, 'inbox-bob');
	await alice.desk.write('Inbox', { 'epicenter.json': contract('Inbox') });
	const shared = synced(await alice.desk.sync('Inbox')).folder;
	expectOk(
		await shareFolder(alice.account, {
			folder: shared,
			email: bob.account.email,
		}),
	);
	expectOk(await acceptShare(bob.account, { folder: shared }));
	const before = await serverState(alice.account, shared);

	await rm(join(alice.desk.path, 'Inbox'), { recursive: true });
	await alice.desk.write('Inbox', { 'epicenter.json': contract('Inbox') });

	expect(await alice.desk.boundTo('Inbox')).toBeNull();
	const every = expectOk(
		await syncEvery({ account: alice.account, root: alice.desk.root }),
	);
	expect(every.folders.map(({ name, waiting }) => [name, waiting])).toEqual([
		['Inbox', 'local'],
	]);
	// Asked to sync it, she is asked which it is: the shared one is offered,
	// selected, never joined without her answer.
	expect(expectOk(await alice.desk.sync('Inbox'))).toMatchObject({
		kind: 'question',
		question: { preselected: shared, silent: null },
	});
	expect(await serverState(alice.account, shared)).toEqual(before);
	// Answered as a new folder, it is one, and the shared one never hears of it.
	await alice.desk.write('Inbox', { 'private.md': note('Private') });
	const own = synced(
		await alice.desk.sync('Inbox', { answer: { create: true } }),
	);
	expect(own.made).toBe(true);
	expect(own.folder).not.toBe(shared);
	expect(await serverState(alice.account, shared)).toEqual(before);
}, 120_000);

test('an inode reused where the file system records no birth time proves nothing', async () => {
	const { read, chosen } = statSeam();
	const account = await server.signIn('inode-reuse');
	const desk = await computer(account, 'inode-reuse', { stat: read });
	chosen.set('Notes', { ino: 4242n, birthtimeNs: 0n });
	await desk.write('Notes', {
		'epicenter.json': contract('Notes'),
		'a.md': note('A'),
	});
	const { folder } = synced(await desk.sync('Notes'));
	const before = await serverState(account, folder);
	// The record keeps the inode, with no birth time.
	const records = expectOk(await expectOk(await desk.root.records()).list());
	expect(records.map(({ record }) => [record.inode, record.birthtime])).toEqual(
		[['4242', null]],
	);
	// Deleted; a new, empty folder gets the old inode.
	await rm(join(desk.path, 'Notes'), { recursive: true });
	chosen.delete('Notes');
	chosen.set('Other', { ino: 4242n, birthtimeNs: 0n });
	await desk.write('Other', { 'b.md': note('B') });
	expect(await desk.boundTo('Other')).toBeNull();
	const every = expectOk(await syncEvery({ account, root: desk.root }));
	expect(every.folders.map(({ name, waiting }) => [name, waiting])).toEqual([
		['Other', 'local'],
	]);
	expect(await serverState(account, folder)).toEqual(before);
}, 120_000);

test('a drive mounted again keeps its folders: the device number is no part of an identity', async () => {
	const account = await server.signIn('remount');
	const desk = await computer(account, 'remount');
	await desk.write('Photos', {
		'epicenter.json': contract('Photos'),
		'a.md': note('A'),
	});
	const { folder } = synced(await desk.sync('Photos'));
	const [held] = expectOk(await expectOk(await desk.root.records()).list());
	expect(Object.keys(held?.record ?? {}).sort()).toEqual([
		'birthtime',
		'cursor',
		'files',
		'folder',
		'inode',
		'name',
	]);
	// The same directory with another device number, as a remount gives it.
	const { read } = statSeam();
	const remounted = {
		...desk,
		root: (await import('../device/node-root.js')).epicenterRoot(desk.path, {
			stat: async (path) =>
				Object.assign(await read(path), { dev: BigInt(Date.now()) }),
		}),
	};
	const found = expectOk(await identify({ root: remounted.root, account }));
	expect(
		found.bound.map(({ record, proof }) => [record.folder, proof]),
	).toEqual([[folder, 'identity']]);
}, 120_000);

const WHISPERING: KnownApp = {
	client: 'so.epicenter.whispering',
	name: 'whispering',
};

test("an app's folder renamed is followed; its usual path made again is a folder of its own, and nothing is deleted", async () => {
	const account = await server.signIn('whispering');
	const desk = await computer(account, 'whispering');
	await desk.write('whispering', {
		'recordings/one.md': note('One'),
		'recordings/two.md': note('Two'),
	});
	// The app made it: the Epicenter app syncs it as if the person had chosen to.
	const first = expectOk(
		await syncEvery({ account, root: desk.root, apps: [WHISPERING] }),
	);
	const made = expectOk(first.folders[0]?.result as never) as {
		kind: string;
		folder: string;
		made: boolean;
	};
	expect(made).toMatchObject({ kind: 'synced', made: true });
	const folder = made.folder;
	expect(
		expectOk(await listFolders(account)).folders.find(({ id }) => id === folder)
			?.apps,
	).toEqual([WHISPERING.client]);
	const before = await serverState(account, folder);

	// The person renames it; the app, not finding it, makes its usual path again.
	await rename(join(desk.path, 'whispering'), join(desk.path, 'Voice notes'));
	await desk.write('whispering', { 'recordings/three.md': note('Three') });
	const after = expectOk(
		await syncEvery({ account, root: desk.root, apps: [WHISPERING] }),
	);
	expect(await desk.boundTo('Voice notes')).toBe(folder);
	expect(await serverState(account, folder)).toEqual(before);
	const fresh = after.folders.find(({ name }) => name === 'whispering');
	expect(expectOk(fresh?.result as never)).toMatchObject({
		kind: 'synced',
		made: true,
	});
	expect(await desk.boundTo('whispering')).not.toBe(folder);
}, 120_000);

test('an older backup restored in place stops at the deletion guard, until the person says what the deletions are', async () => {
	const account = await server.signIn('backup');
	const desk = await computer(account, 'backup');
	const files: Record<string, string> = { 'epicenter.json': contract('Log') };
	for (let day = 1; day <= 30; day++)
		files[`days/${String(day).padStart(2, '0')}.md`] = note(`Day ${day}`);
	await desk.write('Log', files);
	const { folder } = synced(await desk.sync('Log'));
	const before = await serverState(account, folder);

	// A backup from day 8, restored over the same directory.
	const restore = async () => {
		for (let day = 9; day <= 30; day++)
			await rm(join(desk.path, `Log/days/${String(day).padStart(2, '0')}.md`), {
				force: true,
			});
	};
	await restore();
	const stopped = expectOk(await desk.sync('Log'));
	if (stopped.kind !== 'synced') throw new Error('expected a sync');
	expect(stopped.report.outcome).toBe('deletions');
	expect(stopped.report.deletions).toHaveLength(22);
	expect(stopped.report.pushed).toEqual([]);
	expect(await serverState(account, folder)).toEqual(before);

	// Brought back from the server.
	const restored = expectOk(await desk.sync('Log', { deletions: 'restore' }));
	if (restored.kind !== 'synced') throw new Error('expected a sync');
	expect(restored.report.pulled).toHaveLength(22);
	expect(await readdir(join(desk.path, 'Log/days'))).toHaveLength(30);
	expect(await serverState(account, folder)).toEqual(before);

	// Or, said to be meant, deleted there.
	await restore();
	const pushed = expectOk(await desk.sync('Log', { deletions: 'push' }));
	if (pushed.kind !== 'synced') throw new Error('expected a sync');
	expect(pushed.report.outcome).toBe('synced');
	expect((await serverState(account, folder)).paths).toHaveLength(9);
}, 120_000);

test('a lost record finds its folder again by name instead of making a second one', async () => {
	const account = await server.signIn('lost-record');
	const desk = await computer(account, 'lost-record');
	// No epicenter.json: making the folder titles it with the directory's name.
	await desk.write('Journal', { 'a.md': note('A') });
	const first = synced(await desk.sync('Journal'));
	expect(first.made).toBe(true);
	expect(
		JSON.parse(
			await readFile(join(desk.path, 'Journal/epicenter.json'), 'utf8'),
		),
	).toEqual({ title: 'Journal' });
	await rm(join(desk.path, '.epicenter'), { recursive: true });
	await desk.write('Journal', { 'b.md': note('B') });

	const again = synced(await desk.sync('Journal'));
	expect(again).toMatchObject({
		folder: first.folder,
		joined: true,
		made: false,
	});
	expect(expectOk(await listFolders(account)).folders).toHaveLength(1);
}, 120_000);

test('a folder Git keeps never syncs, a link into a working tree included', async () => {
	const account = await server.signIn('git-kept');
	const desk = await computer(account, 'git-kept');
	await desk.write('Code', {
		'.git/HEAD': 'ref: refs/heads/main\n',
		'a.md': note('A'),
	});
	const elsewhere = await scratch('epicenter-repo-');
	await mkdir(join(elsewhere, '.git'));
	await mkdir(join(elsewhere, 'docs'));
	await writeFile(join(elsewhere, 'docs/readme.md'), note('Docs'));
	await symlink(join(elsewhere, 'docs'), join(desk.path, 'Docs'));
	expect(expectOk(await desk.sync('Code'))).toEqual({ kind: 'git' });
	expect(expectOk(await desk.sync('Docs'))).toEqual({ kind: 'git' });
	const home = expectOk(await listHome({ root: desk.root, account }));
	expect(home.folders.map(({ name, state }) => [name, state])).toEqual([
		['Code', 'git'],
		['Docs', 'git'],
	]);
	const every = expectOk(await syncEvery({ account, root: desk.root }));
	expect(every.folders.map(({ waiting }) => waiting)).toEqual(['git', 'git']);
	expect(expectOk(await listFolders(account)).folders).toEqual([]);
	await rm(elsewhere, { recursive: true, force: true });
}, 120_000);

test('an Epicenter folder inside a file-sync service is refused, and one that only might be is warned about', async () => {
	const account = await server.signIn('file-sync');
	const icloud = await computer(account, 'icloud', {
		under: 'Library/Mobile Documents/com~apple~CloudDocs',
	});
	await icloud.write('Notes', { 'a.md': note('A') });
	expect(expectErr(await icloud.sync('Notes')).message).toContain(
		'iCloud Drive',
	);
	expect(
		expectErr(await syncEvery({ account, root: icloud.root })).message,
	).toContain('iCloud Drive');
	expect(
		expectOk(await listHome({ root: icloud.root })).fileSync,
	).toMatchObject({ refused: expect.stringContaining('iCloud Drive') });
	expect(expectOk(await listFolders(account)).folders).toEqual([]);

	const maybe = await computer(account, 'maybe', {
		under: 'old dropbox backup',
	});
	const every = expectOk(await syncEvery({ account, root: maybe.root }));
	expect(every.warning).toContain('names a file-sync service');
}, 120_000);

test('an old in-folder manifest is imported once: a record for the directory it synced in, and its recordings recovered first', async () => {
	const account = await server.signIn('import');
	const desk = await computer(account, 'import');
	await desk.write('Old', {
		'epicenter.json': contract('Old'),
		'a.md': note('A'),
	});
	// Sync it, then turn its record back into the in-folder manifest an older build kept.
	const { folder } = synced(await desk.sync('Old'));
	const records = expectOk(await desk.root.records());
	const [held] = expectOk(await records.list());
	if (held === undefined) throw new Error('expected a record');
	const old = join(desk.path, 'Old/.epicenter');
	await mkdir(join(old, 'recordings/recordings'), { recursive: true });
	await mkdir(join(old, 'saves'), { recursive: true });
	await writeFile(
		join(old, 'synced.json'),
		JSON.stringify({
			folder,
			root: { device: '1', inode: held.record.inode },
			commit: held.record.cursor,
			files: held.record.files,
		}),
	);
	await writeFile(join(old, 'hashes.json'), '{}');
	const take = join(old, 'recordings/recordings/take.webm');
	await writeFile(take, 'audio');
	await writeFile(join(old, 'saves/stale'), 'half');
	const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
	await utimes(take, hourAgo, hourAgo);
	await utimes(join(old, 'saves/stale'), hourAgo, hourAgo);
	await rm(join(desk.path, '.epicenter'), { recursive: true });
	// A copy of it elsewhere in the Epicenter folder: its manifest names another inode.
	await cp(join(desk.path, 'Old'), join(desk.path, 'Old copy'), {
		recursive: true,
	});

	const found = expectOk(await identify({ root: desk.root, account }));
	expect(
		found.bound.map(({ local, record }) => [local.name, record.folder]),
	).toEqual([['Old', folder]]);
	expect(found.unbound.map(({ local }) => local.name)).toEqual(['Old copy']);
	// The recording is beside its final path, under a recording's reserved name.
	const recovered = await readdir(join(desk.path, 'Old/recordings'));
	expect(recovered).toHaveLength(1);
	expect(recovered[0]).toMatch(/^\.ep-[0-9a-z]{8}-take\.recording$/);
	expect(
		await readFile(
			join(desk.path, 'Old/recordings', recovered[0] as string),
			'utf8',
		),
	).toBe('audio');
	// The next look finds nothing of the old layout left.
	expectOk(await identify({ root: desk.root, account }));
	for (const name of ['Old', 'Old copy']) {
		expect(await readdir(join(desk.path, name))).not.toContain('.epicenter');
		// Each copy of the recording is recovered, never deleted.
		expect(await readdir(join(desk.path, name, 'recordings'))).toHaveLength(1);
	}
	// It syncs from the agreed state it imported: nothing to send.
	expect(synced(await desk.sync('Old')).report).toMatchObject({
		pushed: [],
		pulled: [],
	});
}, 120_000);
