/**
 * Browser folder scopes: one captured address per channel, owner, and folder
 * ID, each its own OPFS directory, Web Locks, and hint channel.
 *
 * Key behaviors:
 * - Omitted scope and explicit release Local are one folder
 * - Channels and authority/principal pairs keep separate bytes, locks, and hints
 * - A scoped folder starts beside the Local folder of its ID without reading
 *   or changing it
 * - The account is captured before hashing, and invalid identities refuse
 *   before anything is created
 */
import { afterEach, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type BrowserFolderOptions,
	defineFolder,
	type Folder,
	openFolder,
} from './browser.js';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
} from './browser-storage.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();
const id = 'so.epicenter.scopetest';
const definition = defineFolder({
	kv: {},
	tables: {},
});
const folders: Folder<typeof definition>[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0)) await folder.close();
});

function environment() {
	const names: string[] = [];
	class ObservedChannel extends BroadcastChannel {
		constructor(name: string) {
			super(name);
			names.push(name);
		}
	}
	return {
		...createTestStorage({ BroadcastChannel: ObservedChannel }),
		names,
	};
}

async function open(
	storage: ReturnType<typeof environment>,
	scope?: BrowserFolderOptions['scope'],
) {
	const folder = expectOk(
		await openFolder({
			id,
			definition,
			browser: { ...browserStorage(storage), scope },
		}),
	);
	folders.push(folder);
	return folder;
}

test('omitted scope and explicit release Local are one folder, with one hint channel', async () => {
	const storage = environment();
	const first = await open(storage);
	expectOk(await first.files.create('saved.txt', 'local'));
	await first.git.commit();
	const committed = expectOk(await first.git.log(10));
	await first.close();
	const reopened = await open(storage, { channel: 'release' });
	expect(reopened.location).toEqual(first.location);
	expect(reopened.location).toEqual({
		kind: 'opfs',
		directory: `Epicenter/local/${id}`,
	});
	expect(
		new TextDecoder().decode(
			expectOk(await reopened.files.read('saved.txt')).bytes,
		),
	).toBe('local');
	const { data: history, error: historyError } = await reopened.git.log(10);
	expect(historyError).toBeNull();
	expect(history).toEqual(committed);
	expect(new Set(storage.names).size).toBe(1);
});

test('channels and authority/principal pairs retain separate bytes, locks, and hints', async () => {
	const storage = environment();
	const lockNames = new Set<string>();
	const request = navigator.locks.request;
	navigator.locks.request = new Proxy(request, {
		apply(target, receiver, args) {
			lockNames.add(args[0]);
			return Reflect.apply(target, receiver, args);
		},
	});
	const alice = asPrincipalId('alice');
	const scopes: BrowserFolderOptions['scope'][] = [
		{
			channel: 'release',
			account: { authorityId: 'https://one.example', principalId: alice },
		},
		{
			channel: 'development',
			account: { authorityId: 'https://one.example', principalId: alice },
		},
		{
			channel: 'release',
			account: { authorityId: 'https://two.example', principalId: alice },
		},
		{
			channel: 'release',
			account: {
				authorityId: 'https://one.example',
				principalId: asPrincipalId('bob'),
			},
		},
		{ channel: 'development' },
		{ channel: 'release' },
	];
	try {
		for (const [index, scope] of scopes.entries()) {
			const folder = await open(storage, scope);
			expectOk(await folder.files.create('saved.txt', String(index)));
			await folder.git.commit();
		}
	} finally {
		navigator.locks.request = request;
	}
	// Each scope has its own open, files, and Git locks.
	expect(lockNames.size).toBe(scopes.length * 3);
	expect(new Set(storage.names).size).toBe(scopes.length);
	expect(
		new Set(folders.map((folder) => JSON.stringify(folder.location))).size,
	).toBe(scopes.length);
	for (const [index, scope] of scopes.entries()) {
		const folder = await open(storage, scope);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('saved.txt')).bytes,
			),
		).toBe(String(index));
	}
	// A peer hears a save in its own scope; the other account does not hear it.
	const peer = folders[scopes.length]!;
	let crossed = false;
	folders[2]!.onFilesChanged(() => {
		crossed = true;
	});
	const heard = new Promise<void>((resolve) =>
		peer.onFilesChanged(() => resolve()),
	);
	expectOk(await folders[0]!.files.create('new.txt', 'new'));
	await heard;
	expect(crossed).toBe(false);
});

test('a scoped folder starts with its definition beside a Local folder of the same ID, and Local is left as it was', async () => {
	const storage = environment();
	const local = await open(storage);
	expectOk(await local.files.create('saved.txt', 'local'));
	await local.git.commit();
	await local.close();
	const before = opfsOf(storage).files(`Epicenter/local/${id}`);

	const development = await open(storage, { channel: 'development' });
	const account = await open(storage, {
		channel: 'release',
		account: {
			authorityId: 'https://one.example',
			principalId: asPrincipalId('alice'),
		},
	});
	for (const scoped of [development, account]) {
		expect(expectOk(await scoped.files.list())).toEqual({
			files: [{ path: 'epicenter.json', size: 77 }],
			directories: [],
		});
		expect(expectOk(await scoped.git.log(10))).toEqual([]);
	}
	expect(opfsOf(storage).files(`Epicenter/local/${id}`)).toEqual(before);
});

test('account identity is captured before async hashing and remains fixed', async () => {
	const storage = environment();
	const account = {
		authorityId: 'https://one.example',
		principalId: asPrincipalId('alice'),
	};
	const opening = open(storage, { channel: 'release', account });
	account.authorityId = 'https://two.example';
	const captured = await opening;
	expectOk(await captured.files.create('saved.txt', 'first account'));
	const original = await open(storage, {
		channel: 'release',
		account: {
			authorityId: 'https://one.example',
			principalId: asPrincipalId('alice'),
		},
	});
	expect(original.location).toEqual(captured.location);
	expect(
		new TextDecoder().decode(
			expectOk(await original.files.read('saved.txt')).bytes,
		),
	).toBe('first account');
});

test('invalid account identity or channel refuses before creating storage', async () => {
	const storage = environment();
	for (const scope of [
		{
			channel: 'release',
			account: { authorityId: '', principalId: asPrincipalId('alice') },
		},
		{ channel: 'staging' },
	] as BrowserFolderOptions['scope'][]) {
		const error = expectErr(
			await openFolder({
				id,
				definition,
				browser: { ...browserStorage(storage), scope },
			}),
		);
		expect(error.name).toBe('InvalidBrowserScope');
	}
	expect(opfsOf(storage).directories()).toEqual([]);
});
