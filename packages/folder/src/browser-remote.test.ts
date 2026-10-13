/**
 * The remote a browser folder is bound to, and the read-only inspection that
 * reports it, over the in-memory OPFS stand-in. Downloads run against a real
 * `git http-backend` behind a captured transport.
 *
 * Key behaviors:
 * - `inspectFolder` tells absent, pending download, ready with no remote, and
 *   ready bound to a URL and branch, and writes nothing in any of them
 * - It follows `openFolder`'s scope and address rules and refuses what
 *   `openFolder` refuses
 * - A folder created or downloaded with a remote records its URL and branch;
 *   opening it with exactly that remote opens it, and without one opens it
 * - Another URL, another branch, or a remote for a folder that has none is
 *   refused as `RemoteMismatch` with every byte unchanged, definition included
 * - A folder an earlier version made (marker without a remote, URL in Git
 *   configuration) is bound by that URL; an ambiguous record is refused
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	downloadFolder,
	field,
	type HttpFetch,
	type InspectFolderOptions,
	inspectFolder,
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

const id = 'so.epicenter.remotetest';
const canonical = 'https://github.com/example/remote-data.git';
const remote = { url: canonical, branch: 'main' };
const author = { name: 'Alice', email: 'alice@example.test' };
const alice = {
	authorityId: 'https://api.epicenter.test',
	principalId: asPrincipalId('alice'),
};
const scope = { channel: 'release', account: alice } as const;
const definition = defineFolder({ kv: {}, tables: {} });
const otherDefinition = defineFolder({
	kv: { theme: field.string() },
	tables: {},
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every file and directory below the origin root, as a test can compare it. */
const everything = (storage: TestStorage) => ({
	files: storage.opfs.files(),
	directories: storage.opfs.directories(),
});

const inspect = (
	storage: TestStorage,
	options: { scope?: InspectFolderOptions['scope'] } = {},
) => inspectFolder({ id, scope, ...options, ...browserStorage(storage) });

async function open(
	storage: TestStorage,
	options: {
		remote?: { url: string; branch: string };
		definition?: typeof definition | typeof otherDefinition;
		httpFetch?: HttpFetch;
		createIfMissing?: boolean;
		confirmLegacyRemoteBranch?: boolean;
	} = {},
) {
	const opened = await openFolder({
		id,
		definition: options.definition ?? definition,
		browser: {
			scope,
			author,
			remote: options.remote,
			httpFetch: options.httpFetch,
			createIfMissing: options.createIfMissing,
			confirmLegacyRemoteBranch: options.confirmLegacyRemoteBranch,
			...browserStorage(storage),
		},
	});
	if (opened.error === null) cleanups.push(() => opened.data.close());
	return opened;
}

/** A ready folder made by opening with `remoteOption`, closed again. */
async function readyFolder(
	storage: TestStorage,
	remoteOption: { url: string; branch: string } | undefined,
) {
	const folder = expectOk(await open(storage, { remote: remoteOption }));
	await folder.close();
	const { directory } = folder.location as { directory: string };
	return directory;
}

const markerPath = (directory: string) =>
	`${directory}/.git/epicenter-folder.json`;
const markerOf = (storage: TestStorage, directory: string) =>
	JSON.parse(decoder.decode(storage.opfs.files().get(markerPath(directory))));

/** The address `directory` names, for Alice's release folder. */
const addressOf = (directory: string) =>
	JSON.stringify(['release', 'accounts', directory.split('/')[2], id]);

/** A bare remote behind a captured transport, and a failing one. */
async function fixture() {
	const root = await scratch('folder-remote-');
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const bare = await createBareRemote(root);
	const serveGit = await gitHttpFetch(root);
	const state = { failing: false };
	const httpFetch: HttpFetch = async (input, init) => {
		if (state.failing) return new Response('unavailable', { status: 503 });
		const request = new Request(input, init);
		const url = new URL(request.url);
		const path = url.origin + url.pathname;
		expect(path.startsWith(canonical)).toBe(true);
		return serveGit(
			new Request(
				`http://git.test/remote.git${path.slice(canonical.length)}${url.search}`,
				request,
			),
		);
	};
	const push = async (files: Record<string, string>) => {
		const work = join(root, 'native');
		await git(root, 'clone', '--quiet', bare, work).catch(() => undefined);
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(work, path)), { recursive: true });
			await writeFile(join(work, path), text);
		}
		await git(work, 'add', '-A');
		await git(work, 'commit', '--quiet', '-m', 'Remote entry');
		await git(work, 'push', '--quiet', 'origin', 'HEAD:main');
		return git(bare, 'rev-parse', 'main');
	};
	return { httpFetch, state, push };
}

test('inspection tells absent, pending, ready with no remote, and ready bound, and writes nothing', async () => {
	const { httpFetch, state } = await fixture();

	// Absent: nothing exists, and inspecting creates nothing.
	const storage = createTestStorage();
	const absent = expectOk(await inspect(storage));
	expect(absent.kind).toBe('absent');
	expect(absent.location).toMatchObject({
		kind: 'opfs',
		directory: expect.stringMatching(/^Epicenter\/accounts\/[0-9a-f]{64}\//),
	});
	expect(storage.opfs.files().size).toBe(0);
	expect(storage.opfs.directories()).toEqual([]);

	// Absent also covers what an interrupted first open leaves.
	const { directory } = absent.location as { directory: string };
	storage.opfs.put(markerPath(directory), new Uint8Array());
	const leftover = everything(storage);
	expect(expectOk(await inspect(storage)).kind).toBe('absent');
	expect(everything(storage)).toEqual(leftover);

	// Pending: a download that stopped records its remote and is not a folder.
	const pendingStorage = createTestStorage();
	state.failing = true;
	const failed = expectErr(
		await downloadFolder({
			id,
			scope,
			remote,
			httpFetch,
			...browserStorage(pendingStorage),
		}),
	);
	expect(failed.name).toBe('Incomplete');
	state.failing = false;
	const beforePending = everything(pendingStorage);
	const pending = expectOk(await inspect(pendingStorage));
	expect(pending).toMatchObject({ kind: 'pending', remote });
	expect(everything(pendingStorage)).toEqual(beforePending);

	// Ready with no remote.
	const localStorage = createTestStorage();
	await readyFolder(localStorage, undefined);
	const beforeLocal = everything(localStorage);
	const local = expectOk(await inspect(localStorage));
	expect(local.kind).toBe('ready');
	expect((local as { remote: unknown }).remote).toBeUndefined();
	expect(everything(localStorage)).toEqual(beforeLocal);

	// Ready bound to a URL and branch.
	const boundStorage = createTestStorage();
	await readyFolder(boundStorage, remote);
	const beforeBound = everything(boundStorage);
	const bound = expectOk(await inspect(boundStorage));
	expect(bound).toMatchObject({ kind: 'ready', remote });
	expect(everything(boundStorage)).toEqual(beforeBound);
});

test('inspection follows the scope and address rules of openFolder', async () => {
	const storage = createTestStorage();
	const directory = await readyFolder(storage, remote);
	expect(directory).toMatch(/^Epicenter\/accounts\/[0-9a-f]{64}\//);

	// Omitted scope is release Local, a different directory from the account's.
	const local = expectOk(
		await inspectFolder({ id, ...browserStorage(storage) }),
	);
	expect(local).toEqual({
		kind: 'absent',
		location: { kind: 'opfs', directory: `Epicenter/local/${id}` },
	});
	const development = expectOk(
		await inspect(storage, { scope: { channel: 'development' } }),
	);
	expect(development.location).toEqual({
		kind: 'opfs',
		directory: `Epicenter Dev/local/${id}`,
	});
	const bob = {
		channel: 'release',
		account: { ...alice, principalId: asPrincipalId('bob') },
	} as const;
	const other = expectOk(await inspect(storage, { scope: bob }));
	expect(other.kind).toBe('absent');
	expect(other.location).not.toEqual(expectOk(await inspect(storage)).location);

	expect(
		expectErr(await inspectFolder({ id: ' ', ...browserStorage(storage) }))
			.name,
	).toBe('InvalidId');
	expect(
		expectErr(
			await inspectFolder({
				id,
				scope: { channel: 'staging' } as never,
				...browserStorage(storage),
			}),
		).name,
	).toBe('InvalidBrowserScope');
	// No injected storage and none in this process.
	expect(expectErr(await inspectFolder({ id, scope })).name).toBe(
		'NoFileSystem',
	);

	// What openFolder refuses, inspection refuses, and writes nothing.
	for (const [marker, files] of [
		[JSON.stringify({ address: 'another' }), {}],
		[JSON.stringify({ unrelated: true }), {}],
		['', { 'notes.txt': 'mine' }],
	] as const) {
		const refusedStorage = createTestStorage();
		const refusedDirectory = (
			expectOk(await inspect(refusedStorage)).location as {
				directory: string;
			}
		).directory;
		refusedStorage.opfs.put(
			markerPath(refusedDirectory),
			encoder.encode(marker),
		);
		for (const [path, text] of Object.entries(files))
			refusedStorage.opfs.put(
				`${refusedDirectory}/${path}`,
				encoder.encode(text),
			);
		const before = everything(refusedStorage);
		const inspected = expectErr(await inspect(refusedStorage));
		expect(inspected.name).toBe('Unavailable');
		const opened = expectErr(await open(refusedStorage, { remote }));
		expect(opened.name).toBe('Unavailable');
		expect(everything(refusedStorage)).toEqual(before);
	}
});

test('a created folder records its URL and branch; the same remote opens it, and so does none', async () => {
	const storage = createTestStorage();
	const directory = await readyFolder(storage, remote);
	expect(markerOf(storage, directory)).toEqual({
		address: addressOf(directory),
		remote,
	});
	expect(
		decoder.decode(storage.opfs.files().get(`${directory}/.git/config`)),
	).toContain(`url = ${canonical}`);

	const same = expectOk(
		await open(storage, { remote, createIfMissing: false }),
	);
	expect(same.location).toEqual({ kind: 'opfs', directory });
	await same.close();
	// Opening without a remote is local work and is not refused.
	const local = expectOk(await open(storage, { createIfMissing: false }));
	await local.close();
	expect(markerOf(storage, directory)).toEqual({
		address: addressOf(directory),
		remote,
	});
	expect(expectOk(await inspect(storage))).toMatchObject({
		kind: 'ready',
		remote,
	});

	// A folder made without a remote records none.
	const plain = createTestStorage();
	const plainDirectory = await readyFolder(plain, undefined);
	expect(markerOf(plain, plainDirectory)).toEqual({
		address: addressOf(plainDirectory),
	});
});

test('another URL, another branch, or a remote for a folder with none is refused with every byte unchanged', async () => {
	const elsewhere = { url: `${canonical}.elsewhere`, branch: 'main' };
	const trunk = { url: canonical, branch: 'trunk' };
	const secret = 'https://credential@github.com/example/private.git';

	const cases: [string, { url: string; branch: string } | undefined][] = [
		['another URL', elsewhere],
		['another branch', trunk],
	];
	for (const [label, requested] of cases) {
		const storage = createTestStorage();
		await readyFolder(storage, remote);
		const before = everything(storage);
		const refused = expectErr(
			// A different definition would republish epicenter.json.
			await open(storage, {
				remote: requested,
				definition: otherDefinition,
				createIfMissing: false,
			}),
		);
		expect(refused.name, label).toBe('RemoteMismatch');
		expect(refused).toMatchObject({ stored: remote, requested });
		expect(everything(storage), label).toEqual(before);
	}

	// A folder with no remote does not acquire one by opening with it.
	const plain = createTestStorage();
	await readyFolder(plain, undefined);
	const before = everything(plain);
	const refused = expectErr(
		await open(plain, {
			remote,
			definition: otherDefinition,
			createIfMissing: false,
		}),
	);
	expect(refused).toMatchObject({
		name: 'RemoteMismatch',
		stored: undefined,
		requested: remote,
	});
	expect(everything(plain)).toEqual(before);
	expect(expectOk(await inspect(plain))).toMatchObject({ kind: 'ready' });

	// The message omits URLs: stored configuration may carry credentials.
	const credentialed = createTestStorage();
	await readyFolder(credentialed, { url: secret, branch: 'main' });
	const leak = expectErr(await open(credentialed, { remote }));
	expect(leak.name).toBe('RemoteMismatch');
	expect(leak.message).not.toContain('credential');
	expect(leak.message).not.toContain(canonical);
});

test('a pending download is not a folder: opening refuses it, inspection reports it, and downloading again makes it ready and bound', async () => {
	const { httpFetch, state, push } = await fixture();
	const head = await push({ 'kv.json': '{}\n' });
	const storage = createTestStorage();
	const download = () =>
		downloadFolder({
			id,
			scope,
			remote,
			httpFetch,
			...browserStorage(storage),
		});

	state.failing = true;
	const stopped = expectErr(await download());
	expect(stopped.name).toBe('Incomplete');
	state.failing = false;
	const before = everything(storage);

	const pending = expectOk(await inspect(storage));
	expect(pending).toMatchObject({ kind: 'pending', remote });
	// Even the exact remote does not open a folder that is not downloaded yet.
	const refused = expectErr(await open(storage, { remote, httpFetch }));
	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('unfinished download');
	expect(everything(storage)).toEqual(before);

	expect(expectOk(await download()).head).toBe(head);
	const { directory } = pending.location as { directory: string };
	expect(markerOf(storage, directory)).toEqual({
		address: addressOf(directory),
		remote,
	});
	expect(expectOk(await inspect(storage))).toMatchObject({
		kind: 'ready',
		remote,
	});
	const folder = expectOk(
		await open(storage, { remote, httpFetch, createIfMissing: false }),
	);
	expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(head);
	await folder.close();
	const downloaded = everything(storage);
	expect(
		expectErr(
			await open(storage, {
				remote: { url: canonical, branch: 'trunk' },
				httpFetch,
				createIfMissing: false,
			}),
		).name,
	).toBe('RemoteMismatch');
	expect(everything(storage)).toEqual(downloaded);
});

test('a folder an earlier version made is bound by the URL in its Git configuration', async () => {
	// The earlier marker is `{ address }` and the remote lives only in
	// `.git/config`; its branch was never recorded.
	const storage = createTestStorage();
	const directory = await readyFolder(storage, remote);
	storage.opfs.put(
		markerPath(directory),
		encoder.encode(JSON.stringify({ address: addressOf(directory) })),
	);
	const legacy = everything(storage);

	const inspected = expectOk(await inspect(storage));
	expect(inspected).toMatchObject({
		kind: 'ready',
		remote: { url: canonical, branch: undefined },
	});
	expect(everything(storage)).toEqual(legacy);

	// A URL alone cannot establish which branch older callers intended.
	for (const branch of ['main', 'trunk']) {
		const refused = expectErr(
			await open(storage, {
				remote: { url: canonical, branch },
				createIfMissing: false,
			}),
		);
		expect(refused.name).toBe('RemoteMismatch');
	}
	expect(everything(storage)).toEqual(legacy);
	// A local open remains available for inspection and repair.
	const local = expectOk(await open(storage, { createIfMissing: false }));
	await local.close();

	// An explicit destination choice records the branch once.
	const confirmed = expectOk(
		await open(storage, {
			remote,
			createIfMissing: false,
			confirmLegacyRemoteBranch: true,
		}),
	);
	await confirmed.close();
	expect(markerOf(storage, directory)).toEqual({
		address: addressOf(directory),
		remote,
	});
	expect(
		expectErr(
			await open(storage, {
				remote: { url: canonical, branch: 'trunk' },
				createIfMissing: false,
				confirmLegacyRemoteBranch: true,
			}),
		).name,
	).toBe('RemoteMismatch');

	const before = everything(storage);
	const refused = expectErr(
		await open(storage, {
			remote: { url: `${canonical}.elsewhere`, branch: 'main' },
			definition: otherDefinition,
			createIfMissing: false,
		}),
	);
	expect(refused).toMatchObject({
		name: 'RemoteMismatch',
		stored: remote,
	});
	expect(everything(storage)).toEqual(before);

	// An earlier folder with no configured remote has none.
	const plain = createTestStorage();
	const plainDirectory = await readyFolder(plain, undefined);
	plain.opfs.put(
		markerPath(plainDirectory),
		encoder.encode(JSON.stringify({ address: addressOf(plainDirectory) })),
	);
	expect((expectOk(await inspect(plain)) as { remote: unknown }).remote).toBe(
		undefined,
	);
	expect(
		expectErr(await open(plain, { remote, createIfMissing: false })).name,
	).toBe('RemoteMismatch');
});

test('a marker and configuration that disagree, or a remote that is not a pair, are refused unchanged', async () => {
	const damaged: ((directory: string) => string)[] = [
		// The marker names one remote and the configuration another.
		(directory) =>
			JSON.stringify({
				address: addressOf(directory),
				remote: { url: `${canonical}.elsewhere`, branch: 'main' },
			}),
		// A remote property that records no URL and branch.
		(directory) =>
			JSON.stringify({ address: addressOf(directory), remote: 'main' }),
		(directory) =>
			JSON.stringify({
				address: addressOf(directory),
				remote: { url: canonical },
			}),
	];
	for (const marker of damaged) {
		const storage = createTestStorage();
		const directory = await readyFolder(storage, remote);
		storage.opfs.put(markerPath(directory), encoder.encode(marker(directory)));
		const before = everything(storage);

		const inspected = expectErr(await inspect(storage));
		expect(inspected.name).toBe('Unavailable');
		const refused = expectErr(
			await open(storage, {
				remote,
				definition: otherDefinition,
				createIfMissing: false,
			}),
		);
		expect(refused.name).toBe('Unavailable');
		expect(everything(storage)).toEqual(before);
	}
});
