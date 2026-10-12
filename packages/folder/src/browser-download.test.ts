/**
 * Browser download: a Local or account folder made from remote history
 * before anything opens it, over the in-memory OPFS stand-in and a real
 * `git http-backend` behind a captured transport. Not GitHub, and not a
 * browser's OPFS.
 *
 * Key behaviors:
 * - Opening first publishes `epicenter.json` as an unrelated root; a
 *   download first lands the remote's exact files and history, and opening
 *   then records publication on top of them
 * - A download that fails or stops publishes nothing and is never marked
 *   ready: the opener refuses it, and downloading again finishes it,
 *   recovering an interrupted fast-forward on the way
 * - An existing folder, its history, its uncommitted files, and leftovers of
 *   another remote are refused unchanged, origin included
 * - A remote without the branch leaves an unborn `main`
 * - The open lock is held throughout: an opener of the same address waits
 *   and opens what landed; a second download is refused
 * - Aborting cancels the transfer; account, principal, and Local stay apart
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type DownloadFolderOptions,
	defineFolder,
	defineTable,
	downloadFolder,
	field,
	type HttpFetch,
	openFolder,
} from './browser.js';
import {
	browserStorage,
	createTestStorage,
	type TestStorage,
} from './browser-storage.test-support.js';
import {
	createBareRemote,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();

const id = 'com.bradenwong.zhongwen';
const canonical = 'https://github.com/example/zhongwen-data.git';
const remote = { url: canonical, branch: 'main' };
const author = { name: 'Alice', email: 'alice@example.test' };
const alice = {
	authorityId: 'https://api.epicenter.test',
	principalId: asPrincipalId('alice'),
};
const scope = { channel: 'release', account: alice } as const;
const definition = defineFolder({
	kv: { language: field.string() },
	tables: {
		entries: defineTable({ fields: { expression: field.string() } }),
	},
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What another app version committed and pushed. */
const REMOTE_FILES = {
	'epicenter.json': '{\n  "kv": {},\n  "tables": {}\n}\n',
	'kv.json': '{"language":"Chinese"}\n',
	'entries/ni-hao.md': '---\nexpression: 你好\n---\nHello.\n',
	'entries/xie-xie.md': '---\nexpression: 谢谢\n---\nThanks.\n',
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A bare remote served through `git http-backend`, and the captured
 * transport that routes the canonical URL to it. `gate` holds a request
 * until it resolves; `fail` answers one instead of the server.
 */
async function fixture() {
	const root = await scratch('folder-download-');
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const bare = await createBareRemote(root);
	const serveGit = await gitHttpFetch(root);
	const requests: Request[] = [];
	const transport = {
		gate: undefined as ((request: Request) => Promise<void>) | undefined,
		fail: undefined as ((request: Request) => Response | undefined) | undefined,
	};
	const httpFetch: HttpFetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		const url = new URL(request.url);
		const path = url.origin + url.pathname;
		expect(path.startsWith(canonical)).toBe(true);
		await transport.gate?.(request);
		const failed = transport.fail?.(request);
		if (failed !== undefined) return failed;
		return serveGit(
			new Request(
				`http://git.test/remote.git${path.slice(canonical.length)}${url.search}`,
				request,
			),
		);
	};
	return { root, bare, httpFetch, requests, transport };
}

/** Commit `files` from a native checkout and push them to `main`. */
async function push(
	root: string,
	bare: string,
	files: Record<string, string>,
	message: string,
): Promise<string> {
	const work = join(root, 'native');
	await git(root, 'clone', '--quiet', bare, work).catch(() => undefined);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(work, path)), { recursive: true });
		await writeFile(join(work, path), text);
	}
	await git(work, 'add', '-A');
	await git(work, 'commit', '--quiet', '-m', message);
	await git(work, 'push', '--quiet', 'origin', 'HEAD:main');
	return git(bare, 'rev-parse', 'main');
}

/** The two-commit history another device pushed. */
async function seeded(root: string, bare: string) {
	const first = await push(
		root,
		bare,
		{
			'epicenter.json': REMOTE_FILES['epicenter.json'],
			'kv.json': REMOTE_FILES['kv.json'],
			'entries/ni-hao.md': REMOTE_FILES['entries/ni-hao.md'],
		},
		'First entry',
	);
	const head = await push(
		root,
		bare,
		{ 'entries/xie-xie.md': REMOTE_FILES['entries/xie-xie.md'] },
		'Second entry',
	);
	return { first, head };
}

function download(
	storage: TestStorage,
	options: Partial<DownloadFolderOptions> &
		Pick<DownloadFolderOptions, 'httpFetch'>,
) {
	return downloadFolder({
		id,
		scope,
		remote,
		...browserStorage(storage),
		...options,
	});
}

async function open(
	storage: TestStorage,
	httpFetch: HttpFetch,
	options: {
		scope?: DownloadFolderOptions['scope'];
		remote?: typeof remote;
		createIfMissing?: boolean;
	} = {},
) {
	const opened = await openFolder({
		id,
		definition,
		browser: {
			scope,
			author,
			remote,
			httpFetch,
			...browserStorage(storage),
			...options,
		},
	});
	if (opened.error === null) cleanups.push(() => opened.data.close());
	return opened;
}

/** Every file below `directory`, `.git` included, as text. */
const everything = (storage: TestStorage, directory: string) =>
	Object.fromEntries(
		[...storage.opfs.files(directory)].map(([path, bytes]) => [
			path,
			decoder.decode(bytes),
		]),
	);

/** The folder's files outside `.git`, as text. */
const folderFiles = (storage: TestStorage, directory: string) =>
	Object.fromEntries(
		Object.entries(everything(storage, directory)).filter(
			([path]) => !path.startsWith('.git/'),
		),
	);

const MARKER = '.git/epicenter-folder.json';

const marker = (storage: TestStorage, directory: string) =>
	everything(storage, directory)[MARKER];

/** The address `directory` belongs to, for Alice's release folder `id`. */
const addressOf = (directory: string) =>
	JSON.stringify(['release', 'accounts', directory.split('/')[2], id]);

/** The marker text of a pending download into `directory`. */
const receipt = (
	directory: string,
	pending: { url: string; branch: string } = remote,
	address = addressOf(directory),
) => JSON.stringify({ download: { address, remote: pending } });

const ready = (directory: string) =>
	JSON.stringify({ address: addressOf(directory) });

/** The account directory a download of `id` uses, found without writing. */
async function directoryOf(storage: TestStorage, httpFetch: HttpFetch) {
	const absent = expectErr(
		await open(storage, httpFetch, { createIfMissing: false }),
	);
	expect(absent.name).toBe('Absent');
	return (absent as { directory: string }).directory;
}

test('opening first publishes epicenter.json as an unrelated root; downloading first opens the remote history', async () => {
	const { root, bare, httpFetch, requests } = await fixture();
	const { first, head } = await seeded(root, bare);

	// The defect: another profile opens before getting the remote, and its
	// published epicenter.json becomes a root the remote does not share.
	const early = expectOk(await open(createTestStorage(), httpFetch));
	await early.git.commit();
	expect(expectOk(await early.git.fetch()).oid).toBe(head);
	const unrelated = expectErr(await early.git.mergeIncoming());
	expect(unrelated).toMatchObject({ name: 'UnsupportedHistory', bases: 0 });

	const storage = createTestStorage();
	const originalFetch = globalThis.fetch;
	requests.length = 0;
	const landed = expectOk(await download(storage, { httpFetch }));
	expect(landed.head).toBe(head);
	const { directory } = landed.location as { directory: string };
	expect(directory).toMatch(/^Epicenter\/accounts\/[0-9a-f]{64}\//);
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
	expect(JSON.parse(marker(storage, directory) ?? 'null')).toEqual({
		address: JSON.stringify([
			'release',
			'accounts',
			directory.split('/')[2],
			id,
		]),
	});
	expect(requests.length).toBeGreaterThan(0);
	expect(
		requests.every((request) => request.url.startsWith(`${canonical}/`)),
	).toBe(true);
	expect(globalThis.fetch).toBe(originalFetch);

	const folder = expectOk(await open(storage, httpFetch));
	expect(folder.location).toEqual(landed.location);
	expect(expectOk(await folder.kv.get())?.values.language).toBe('Chinese');
	// Opening replaced the other version's description and committed it on top.
	const published = decoder.decode(
		expectOk(await folder.files.read('epicenter.json')).bytes,
	);
	expect(published).not.toBe(REMOTE_FILES['epicenter.json']);
	await folder.git.commit();
	const [publication, ...history] = expectOk(await folder.git.log(10));
	expect(history.map((commit) => commit.oid)).toEqual([head, first]);
	expect(publication!.parents).toEqual([head]);
	expect(expectOk(await folder.git.fetch()).oid).toBe(head);
	expect(expectOk(await folder.git.pullFastForward()).status).toBe('ahead');
	expect((await folder.git.push()).status).toBe('pushed');
	expect(await git(bare, 'rev-parse', 'main^')).toBe(head);
});

test('account startup that does not create finds nothing, writes nothing, and opens what Download lands', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { first, head } = await seeded(root, bare);
	const storage = createTestStorage();
	const existing = { createIfMissing: false };

	const absent = expectErr(await open(storage, httpFetch, existing));
	expect(absent.name).toBe('Absent');
	const { directory } = absent as { directory: string };
	expect(directory).toMatch(/^Epicenter\/accounts\/[0-9a-f]{64}\//);
	expect(storage.opfs.files().size).toBe(0);
	expect(storage.opfs.directories()).toEqual([]);

	expect(expectOk(await download(storage, { httpFetch })).head).toBe(head);
	const folder = expectOk(await open(storage, httpFetch, existing));
	expect(folder.location).toEqual({ kind: 'opfs', directory });
	const history = expectOk(await folder.git.log(10)).map((c) => c.oid);
	expect(history).toEqual([head, first]);
	// Opening an existing folder still publishes its description.
	expect(
		decoder.decode(expectOk(await folder.files.read('epicenter.json')).bytes),
	).not.toBe(REMOTE_FILES['epicenter.json']);
});

test('opening without creating refuses a failed download as Unavailable, not Absent', async () => {
	const { root, bare, httpFetch, transport } = await fixture();
	await seeded(root, bare);
	const storage = createTestStorage();
	transport.fail = () => new Response('unavailable', { status: 503 });
	const failed = expectErr(await download(storage, { httpFetch }));
	const { directory } = failed as { directory: string };
	const before = everything(storage, directory);
	const refused = expectErr(
		await open(storage, httpFetch, { createIfMissing: false }),
	);
	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('unfinished download');
	expect(everything(storage, directory)).toEqual(before);
});

test('a failed download publishes nothing, the opener refuses it, and downloading again finishes it', async () => {
	const { root, bare, httpFetch, transport } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	transport.fail = (request) =>
		request.url.endsWith('/git-upload-pack')
			? new Response('session expired', { status: 401 })
			: undefined;

	const failed = expectErr(await download(storage, { httpFetch }));
	expect(failed.name).toBe('Incomplete');
	const { directory } = failed as { directory: string };
	expect(folderFiles(storage, directory)).toEqual({});
	expect(marker(storage, directory)).toBe(receipt(directory));
	// Retained, not reset: the Git state the download began with stays.
	expect(everything(storage, directory)['.git/config']).toContain(canonical);

	const refused = expectErr(await open(storage, httpFetch));
	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('unfinished download');
	expect(folderFiles(storage, directory)).toEqual({});

	transport.fail = undefined;
	expect(expectOk(await download(storage, { httpFetch })).head).toBe(head);
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
	const folder = expectOk(await open(storage, httpFetch));
	expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(head);
});

test('an interrupted fast-forward stays pending until downloading again recovers it', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	storage.opfs.faults.write = (path) =>
		path.endsWith('/entries/xie-xie.md') ? 'fail' : undefined;

	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	const { directory } = stopped as { directory: string };
	const left = everything(storage, directory);
	expect(left['.git/epicenter-incoming.json']).toContain(head);
	expect(left['.git/refs/heads/main']).toBeUndefined();
	expect(marker(storage, directory)).toBe(receipt(directory));
	expect(left['entries/xie-xie.md']).toBeUndefined();
	// Files land in path order, so the declaration after the failed entry waits too.
	expect(left['epicenter.json']).toBeUndefined();
	expect(expectErr(await open(storage, httpFetch)).name).toBe('Unavailable');

	storage.opfs.faults.write = undefined;
	expect(expectOk(await download(storage, { httpFetch })).head).toBe(head);
	const finished = everything(storage, directory);
	expect(finished['.git/epicenter-incoming.json']).toBeUndefined();
	expect(finished['.git/refs/heads/main']?.trim()).toBe(head);
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
});

test('a file left in neither state is named, and downloading again writes nothing until it is removed', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	// A close that never published leaves the new file empty, as a tab that
	// closed mid-write does.
	storage.opfs.faults.close = (path) =>
		path.endsWith('/entries/xie-xie.md') ? 'fail' : undefined;
	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	const { directory } = stopped as { directory: string };
	storage.opfs.faults.close = undefined;
	expect(everything(storage, directory)['entries/xie-xie.md']).toBe('');
	const before = everything(storage, directory);

	const refused = expectErr(await download(storage, { httpFetch }));
	expect(refused.name).toBe('Incomplete');
	expect(refused.message).toContain('entries/xie-xie.md');
	expect(everything(storage, directory)).toEqual(before);
	expect(expectErr(await open(storage, httpFetch)).name).toBe('Unavailable');

	// The repair is outside the folder API: remove the named path.
	storage.opfs.drop(`${directory}/entries/xie-xie.md`);
	expect(expectOk(await download(storage, { httpFetch })).head).toBe(head);
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
});

test('an existing folder, its history, and its uncommitted files are refused unchanged', async () => {
	const { root, bare, httpFetch } = await fixture();
	await seeded(root, bare);
	const storage = createTestStorage();
	const other = 'https://legacy-credential@github.com/example/elsewhere.git';
	const local = expectOk(
		await open(storage, httpFetch, { remote: { url: other, branch: 'main' } }),
	);
	expectOk(await local.files.create('entries/mine.md', 'Committed.\n'));
	await local.git.commit();
	expectOk(await local.files.create('entries/draft.md', 'Saved.\n'));
	await local.close();
	const { directory } = local.location as { directory: string };
	const before = everything(storage, directory);

	const refused = expectErr(await download(storage, { httpFetch }));
	expect(refused).toMatchObject({
		name: 'Exists',
		directory,
		reason: 'is this folder',
		origin: other,
	});
	expect(refused.message).not.toContain('legacy-credential');
	expect(refused.message).not.toContain(other);
	expect(everything(storage, directory)).toEqual(before);
});

test('leftovers of a download from another remote are refused, and their origin is kept', async () => {
	const { root, bare, httpFetch, transport } = await fixture();
	await seeded(root, bare);
	const storage = createTestStorage();
	transport.fail = () => new Response('unavailable', { status: 503 });
	const failed = expectErr(await download(storage, { httpFetch }));
	expect(failed.name).toBe('Incomplete');
	const { directory } = failed as { directory: string };
	const before = everything(storage, directory);

	transport.fail = undefined;
	const elsewhere = { url: `${canonical}/../elsewhere.git`, branch: 'main' };
	const refused = expectErr(
		await download(storage, { httpFetch, remote: elsewhere }),
	);
	expect(refused).toMatchObject({ name: 'Exists', origin: canonical });
	expect(refused.message).toContain(`unfinished download for`);
	expect(refused.message).toContain(`of ${canonical} (branch main)`);
	expect(everything(storage, directory)).toEqual(before);
});

test('a remote without the branch leaves an unborn main that opening and pushing start', async () => {
	const { bare, httpFetch } = await fixture();
	const storage = createTestStorage();

	const landed = expectOk(await download(storage, { httpFetch }));
	expect(landed.head).toBeUndefined();
	const { directory } = landed.location as { directory: string };
	expect(folderFiles(storage, directory)).toEqual({});
	expect(marker(storage, directory)).toBeDefined();
	expect(
		everything(storage, directory)['.git/refs/heads/main'],
	).toBeUndefined();

	const folder = expectOk(await open(storage, httpFetch));
	await folder.git.commit();
	const [committed, ...earlier] = expectOk(await folder.git.log(10));
	expect(earlier).toEqual([]);
	expect(committed!.parents).toEqual([]);
	expect((await folder.git.push()).status).toBe('pushed');
	expect(await git(bare, 'rev-parse', 'main')).toBe(committed!.oid);
});

test('a fetched head the remote no longer advertises is refused, kept, and replaced by the next fresh fetch', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { head: stale } = await seeded(root, bare);
	const storage = createTestStorage();
	// The first attempt fetches, then stops before its update is admitted.
	storage.opfs.faults.write = (path) =>
		path.endsWith('/.git/epicenter-incoming.json') ? 'fail' : undefined;
	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	storage.opfs.faults.write = undefined;
	const { directory } = stopped as { directory: string };
	const tracking = '.git/refs/remotes/origin/main';
	expect(everything(storage, directory)[tracking]?.trim()).toBe(stale);
	expect(
		everything(storage, directory)['.git/refs/heads/main'],
	).toBeUndefined();

	// The remote loses its branch. A fresh fetch advertises none.
	await git(bare, 'update-ref', '-d', 'refs/heads/main');
	const before = everything(storage, directory);
	const refused = expectErr(await download(storage, { httpFetch }));
	expect(refused.name).toBe('Incomplete');
	expect(refused.message).toContain(stale);
	expect(refused.message).toContain('no longer advertises');
	expect(marker(storage, directory)).toBe(receipt(directory));
	expect(everything(storage, directory)).toEqual(before);
	expect(expectErr(await open(storage, httpFetch)).name).toBe('Unavailable');

	// Once the remote has the branch again, the fresh head replaces the
	// cached one and lands; the stale commit is not adopted.
	const fresh = await push(
		root,
		bare,
		{ 'entries/zai-jian.md': '---\nexpression: 再见\n---\nBye.\n' },
		'After the branch came back',
	);
	expect(expectOk(await download(storage, { httpFetch })).head).toBe(fresh);
	expect(everything(storage, directory)[tracking]?.trim()).toBe(fresh);
	const folder = expectOk(await open(storage, httpFetch));
	expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(fresh);
});

test('an opener of the same address waits for the download and opens what landed; a second download is refused', async () => {
	const { root, bare, httpFetch, transport } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	transport.gate = async () => {
		entered();
		await released;
	};

	const first = download(storage, { httpFetch });
	await started;
	const settled: string[] = [];
	const opening = open(storage, httpFetch).then((result) => {
		settled.push('open');
		return result;
	});
	const second = download(storage, { httpFetch }).then((result) => {
		settled.push('download');
		return result;
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(settled).toEqual([]);

	transport.gate = undefined;
	release();
	expect(expectOk(await first).head).toBe(head);
	const folder = expectOk(await opening);
	expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(head);
	expect(expectErr(await second)).toMatchObject({
		name: 'Exists',
		reason: 'is this folder',
		origin: canonical,
	});
});

test('Git state or files without a pending record are refused unchanged, whatever their origin', async () => {
	const { httpFetch } = await fixture(); // an empty remote
	const config = `[remote "origin"]\n\turl = ${canonical}\n`;
	const cases: [string, Record<string, string>, string | undefined][] = [
		['.git/foreign-note', { '.git/foreign-note': 'kept' }, undefined],
		['.git/config', { '.git/config': config, 'found.txt': 'found' }, canonical],
	];
	for (const [occupant, files, origin] of cases) {
		const storage = createTestStorage();
		const directory = await directoryOf(storage, httpFetch);
		for (const [path, text] of Object.entries(files))
			storage.opfs.put(`${directory}/${path}`, encoder.encode(text));
		const before = everything(storage, directory);
		const refused = expectErr(await download(storage, { httpFetch }));
		expect(refused).toMatchObject({ name: 'Exists', origin });
		expect(refused.message).toContain(`'${occupant}' without a ready marker`);
		expect(everything(storage, directory)).toEqual(before);
	}
});

test('a pending record beside a file it did not write stays pending on an empty remote', async () => {
	const { httpFetch } = await fixture();
	const storage = createTestStorage();
	const directory = await directoryOf(storage, httpFetch);
	storage.opfs.put(
		`${directory}/${MARKER}`,
		encoder.encode(receipt(directory)),
	);
	storage.opfs.put(`${directory}/found.txt`, encoder.encode('found'));

	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	expect(stopped.message).toContain("'found.txt'");
	expect(marker(storage, directory)).toBe(receipt(directory));
	expect(folderFiles(storage, directory)).toEqual({ 'found.txt': 'found' });
	const refused = expectErr(
		await open(storage, httpFetch, { createIfMissing: false }),
	);
	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('unfinished download');
});

test('a pending record for another address, URL, or branch is refused unchanged', async () => {
	const { root, bare, httpFetch } = await fixture();
	await seeded(root, bare);
	for (const record of [
		(directory: string) =>
			receipt(directory, { url: `${canonical}.old`, branch: 'main' }),
		(directory: string) =>
			receipt(directory, { url: canonical, branch: 'trunk' }),
		(directory: string) =>
			receipt(
				directory,
				remote,
				JSON.stringify(['development', 'accounts', 'a'.repeat(64), id]),
			),
	]) {
		const storage = createTestStorage();
		const directory = await directoryOf(storage, httpFetch);
		storage.opfs.put(
			`${directory}/${MARKER}`,
			encoder.encode(record(directory)),
		);
		const before = everything(storage, directory);
		const refused = expectErr(await download(storage, { httpFetch }));
		expect(refused.name).toBe('Exists');
		expect(refused.message).toContain('unfinished download for');
		expect(everything(storage, directory)).toEqual(before);
	}
});

/** Interrupt the `nth` close of the marker below `directory` with `fault`. */
function faultMarker(
	storage: TestStorage,
	directory: string,
	nth: number,
	fault: 'fail' | 'lost',
) {
	let closes = 0;
	storage.opfs.faults.close = (path) =>
		path === `${directory}/${MARKER}` && ++closes === nth ? fault : undefined;
}

test('a pending record that never published leaves nothing to own; downloading again starts over', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	const directory = await directoryOf(storage, httpFetch);
	faultMarker(storage, directory, 1, 'fail');

	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	expect(stopped.message).toContain('nothing else was written');
	expect(marker(storage, directory) ?? '').toBe('');
	expect(Object.keys(everything(storage, directory))).toEqual(
		marker(storage, directory) === undefined ? [] : [MARKER],
	);
	expect(
		expectErr(await open(storage, httpFetch, { createIfMissing: false })).name,
	).toBe('Absent');

	storage.opfs.faults.close = undefined;
	expect(expectOk(await download(storage, { httpFetch })).head).toBe(head);
	expect(marker(storage, directory)).toBe(ready(directory));
});

test('a pending record that published unconfirmed is owned; the opener refuses it and downloading again finishes it', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	const directory = await directoryOf(storage, httpFetch);
	faultMarker(storage, directory, 1, 'lost');

	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	expect(Object.keys(everything(storage, directory))).toEqual([MARKER]);
	expect(marker(storage, directory)).toBe(receipt(directory));
	// No top-level address: an opener that knows only ready markers refuses it.
	expect(
		JSON.parse(marker(storage, directory) ?? '{}').address,
	).toBeUndefined();
	const refused = expectErr(
		await open(storage, httpFetch, { createIfMissing: false }),
	);
	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('unfinished download');

	storage.opfs.faults.close = undefined;
	expect(expectOk(await download(storage, { httpFetch })).head).toBe(head);
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
});

test('a ready marker that failed to publish keeps the record; downloading again marks it ready', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	const directory = await directoryOf(storage, httpFetch);
	faultMarker(storage, directory, 2, 'fail');

	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	expect(stopped.message).toContain('may be ready');
	expect(marker(storage, directory)).toBe(receipt(directory));
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
	expect(
		expectErr(await open(storage, httpFetch, { createIfMissing: false })).name,
	).toBe('Unavailable');

	storage.opfs.faults.close = undefined;
	expect(expectOk(await download(storage, { httpFetch })).head).toBe(head);
	expect(marker(storage, directory)).toBe(ready(directory));
});

test('a ready marker that published unconfirmed is a ready folder; opening without creating shows it and downloading again is Exists', async () => {
	const { root, bare, httpFetch } = await fixture();
	const { first, head } = await seeded(root, bare);
	const storage = createTestStorage();
	const directory = await directoryOf(storage, httpFetch);
	faultMarker(storage, directory, 2, 'lost');

	const stopped = expectErr(await download(storage, { httpFetch }));
	expect(stopped.name).toBe('Incomplete');
	expect(stopped.message).toContain('may be ready');
	expect(marker(storage, directory)).toBe(ready(directory));
	storage.opfs.faults.close = undefined;

	const folder = expectOk(
		await open(storage, httpFetch, { createIfMissing: false }),
	);
	const history = expectOk(await folder.git.log(10)).map((c) => c.oid);
	expect(history).toEqual([head, first]);
	expect(expectErr(await download(storage, { httpFetch }))).toMatchObject({
		name: 'Exists',
		reason: 'is this folder',
	});
});

test('aborting cancels the transfer and reports the download incomplete', async () => {
	const { root, bare, httpFetch, transport } = await fixture();
	await seeded(root, bare);
	const storage = createTestStorage();
	const controller = new AbortController();
	let cancelled = false;
	transport.gate = (request) =>
		new Promise((_resolve, reject) => {
			request.signal.addEventListener('abort', () => {
				cancelled = true;
				reject(request.signal.reason);
			});
			controller.abort(new Error('The person left'));
		});

	const stopped = expectErr(
		await download(storage, { httpFetch, signal: controller.signal }),
	);
	expect(stopped.name).toBe('Incomplete');
	expect(stopped.message).toContain('The person left');
	expect(cancelled).toBe(true);
	const { directory } = stopped as { directory: string };
	expect(marker(storage, directory)).toBe(receipt(directory));
	expect(folderFiles(storage, directory)).toEqual({});
});

test('a download needs an explicit scope, and accounts, principals, and Local stay apart', async () => {
	const { root, bare, httpFetch } = await fixture();
	await seeded(root, bare);
	const storage = createTestStorage();

	const anonymous = expectErr(
		await download(storage, {
			httpFetch,
			scope: undefined as unknown as DownloadFolderOptions['scope'],
		}),
	);
	expect(anonymous.name).toBe('InvalidBrowserScope');
	expect(storage.opfs.files().size).toBe(0);

	const local = expectOk(
		await download(storage, {
			httpFetch,
			scope: { channel: 'release' },
		}),
	);
	const localDirectory = (local.location as { directory: string }).directory;
	expect(localDirectory).toBe(`Epicenter/local/${id}`);
	expect(folderFiles(storage, localDirectory)).toEqual(REMOTE_FILES);

	const landed = expectOk(await download(storage, { httpFetch }));
	const bob = {
		channel: 'release',
		account: { ...alice, principalId: asPrincipalId('bob') },
	} as const;
	const other = expectOk(await open(storage, httpFetch, { scope: bob }));
	expect(other.location).not.toEqual(landed.location);
	expect(other.location).not.toEqual(local.location);
	expect(landed.location).not.toEqual(local.location);
	expect(expectOk(await other.git.log(1))).toEqual([]);
	expect(
		[...storage.opfs.files()]
			.filter(([path]) => path.endsWith('/kv.json'))
			.map(([path]) => path),
	).toEqual([
		`${localDirectory}/kv.json`,
		`${(landed.location as { directory: string }).directory}/kv.json`,
	]);
});

test('Local download lands remote history before definition publication and refuses a ready folder unchanged', async () => {
	const { root, bare, httpFetch, requests } = await fixture();
	const { first, head } = await seeded(root, bare);
	const storage = createTestStorage();
	const localScope = { channel: 'release' } as const;
	const landed = expectOk(
		await download(storage, { httpFetch, scope: localScope }),
	);
	const directory = (landed.location as { directory: string }).directory;
	expect(landed.head).toBe(head);
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
	expect(JSON.parse(marker(storage, directory) ?? 'null')).toEqual({
		address: JSON.stringify(['release', 'local', null, id]),
	});
	const folder = expectOk(
		await open(storage, httpFetch, {
			scope: localScope,
			createIfMissing: false,
		}),
	);
	await folder.git.commit();
	const [publication, ...history] = expectOk(await folder.git.log(10));
	expect(history.map((commit) => commit.oid)).toEqual([head, first]);
	expect(publication!.parents).toEqual([head]);
	const before = everything(storage, directory);
	requests.length = 0;
	const refused = expectErr(
		await download(storage, { httpFetch, scope: localScope }),
	);
	expect(refused).toMatchObject({
		name: 'Exists',
		reason: 'is this folder',
		origin: canonical,
	});
	expect(requests).toEqual([]);
	expect(everything(storage, directory)).toEqual(before);
});

test('an incomplete Local download retains its history, refuses opening, and retries the same recipe', async () => {
	const { root, bare, httpFetch, transport } = await fixture();
	const { head } = await seeded(root, bare);
	const storage = createTestStorage();
	const localScope = { channel: 'development' } as const;
	transport.fail = () => new Response('Unavailable', { status: 503 });
	const stopped = expectErr(
		await download(storage, { httpFetch, scope: localScope }),
	);
	expect(stopped.name).toBe('Incomplete');
	const directory = (stopped as { directory: string }).directory;
	expect(directory).toBe(`Epicenter Dev/local/${id}`);
	const before = everything(storage, directory);
	expect(folderFiles(storage, directory)).toEqual({});
	expect(
		expectErr(await open(storage, httpFetch, { scope: localScope })).name,
	).toBe('Unavailable');
	expect(everything(storage, directory)).toEqual(before);
	transport.fail = undefined;
	const landed = expectOk(
		await download(storage, { httpFetch, scope: localScope }),
	);
	expect(landed.head).toBe(head);
	expect(folderFiles(storage, directory)).toEqual(REMOTE_FILES);
});

test('the captured transport carries the credential; the folder stores only the canonical origin', async () => {
	const { root, bare, httpFetch } = await fixture();
	await seeded(root, bare);
	const storage = createTestStorage();
	const token = 'session-bound-secret';
	const authorized: HttpFetch = (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set('authorization', `Bearer ${token}`);
		return httpFetch(input, { ...init, headers });
	};
	const landed = expectOk(await download(storage, { httpFetch: authorized }));
	const { directory } = landed.location as { directory: string };
	const stored = [...storage.opfs.files()].map(([, bytes]) => bytes);
	const secret = encoder.encode(token);
	const contains = (bytes: Uint8Array) =>
		bytes.some((_, at) => secret.every((byte, i) => bytes[at + i] === byte));
	expect(stored.some(contains)).toBe(false);
	const config = everything(storage, directory)['.git/config'];
	expect(config).toContain(`url = ${canonical}`);
	expect(config).not.toContain('git.test');
});
