/**
 * Epicenter Root Tests
 *
 * `epicenterRoot()` from `@epicenter/folder/tauri`: the Epicenter folder over
 * a stand-in folder plugin, as the Epicenter app's window reaches it.
 *
 * Key behaviors:
 * - A listing names each folder with its path, identity (inode and birth
 *   time), and whether Git keeps it, opening its root once; one whose root
 *   does not open is unreadable, with why
 * - The Epicenter folder's own `.epicenter` is the root `Epicenter`, opened
 *   once, which holds the records and each folder's hash cache
 * - A folder opens again only when its identity changed
 * - Each folder's store hears only its own changes, and names its root in
 *   every command, `Folder/<name>` in a raw request's header
 * - Making a folder makes its directory, then opens it
 */
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

// Bun keeps a module mock for the rest of the run, so the stand-in stops
// claiming Tauri once this file is done.
let inTauri = true;
type Asked = { command: string; body?: unknown; headers?: unknown };
const asked: Asked[] = [];
let listing: unknown;
let refuseOpen = new Set<string>();
let heard: ((event: { payload: unknown }) => void) | undefined;
const identity = (inode: string) => ({
	inode,
	birthtime: '1700000000000000000',
});

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {},
	isTauri: () => inTauri,
	transformCallback: () => 0,
	invoke: async (
		command: string,
		body?: { root?: { Folder: string }; name?: string },
		options?: { headers?: unknown },
	) => {
		asked.push({ command, body, headers: options?.headers });
		if (command === 'plugin:epicenter-folder|list_epicenter') return listing;
		if (command === 'plugin:epicenter-folder|open_root') {
			if ((body?.root as unknown) === 'Epicenter')
				return '/Users/me/Epicenter/.epicenter';
			const name = body?.root?.Folder ?? '';
			if (refuseOpen.has(name))
				throw {
					name: 'Refused',
					folder: `/Users/me/Epicenter/${name}`,
					reason: 'it is inside a .git folder',
				};
			return `/Users/me/Epicenter/${name}`;
		}
		if (command === 'plugin:epicenter-folder|make_epicenter_folder')
			return { name: body?.name, identity: identity('9'), git: false };
		if (command === 'plugin:epicenter-folder|read_folder_file')
			throw { name: 'NotFound' };
		if (command === 'plugin:epicenter-folder|put_folder_file')
			return { landed: 'v1:1:2:3:4' };
		throw new Error(`Unexpected command ${command}`);
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: async (_name: string, callback: typeof heard) => {
		heard = callback;
		return () => {};
	},
}));

const { epicenterRoot } = await import('../tauri.js');

afterAll(() => {
	inTauri = false;
});

afterEach(() => {
	asked.length = 0;
	refuseOpen = new Set();
});

const opens = () =>
	asked
		.filter(({ command }) => command === 'plugin:epicenter-folder|open_root')
		.map(({ body }) => {
			const { root } = body as { root: { Folder: string } | string };
			return typeof root === 'string' ? root : root.Folder;
		});

test('a listing opens each folder once, names one that does not open, and lists links as outside', async () => {
	listing = {
		path: '/Users/me/Epicenter',
		git: true,
		folders: [
			{ name: 'Notes', identity: identity('1'), git: false },
			{ name: 'Recipes', identity: identity('2'), git: true },
			{ name: 'Everything', identity: identity('3'), git: false },
		],
		outside: [{ name: 'Drive', target: '/Volumes/Archive/Drive' }],
		unreadable: [{ name: 'Locked', reason: 'permission denied' }],
	};
	refuseOpen = new Set(['Everything']);
	const root = epicenterRoot();
	expect(root.path).toBe('');
	const listed = expectOk(await root.list());
	expect(root.path).toBe('/Users/me/Epicenter');
	expect(listed.git).toBe(true);
	expect(listed.outside).toEqual([
		{
			name: 'Drive',
			path: '/Users/me/Epicenter/Drive',
			target: '/Volumes/Archive/Drive',
		},
	]);
	expect(
		listed.folders.map(({ name, path, identity, git }) => ({
			name,
			path,
			identity,
			git,
		})),
	).toEqual([
		{
			name: 'Notes',
			path: '/Users/me/Epicenter/Notes',
			identity: identity('1'),
			git: false,
		},
		{
			name: 'Recipes',
			path: '/Users/me/Epicenter/Recipes',
			identity: identity('2'),
			git: true,
		},
	]);
	expect(listed.unreadable.map(({ name }) => name)).toEqual([
		'Locked',
		'Everything',
	]);
	expect(listed.unreadable[1]?.reason).toContain('inside a .git folder');
	expect(opens()).toEqual(['Epicenter', 'Notes', 'Recipes', 'Everything']);

	// The same folders open nothing again; one replaced opens again.
	asked.length = 0;
	refuseOpen = new Set(['Everything']);
	listing = {
		path: '/Users/me/Epicenter',
		git: false,
		folders: [
			{ name: 'Notes', identity: identity('1'), git: false },
			{ name: 'Recipes', identity: identity('7'), git: false },
		],
		outside: [],
		unreadable: [],
	};
	expectOk(await root.list());
	expect(opens()).toEqual(['Recipes']);
});

test("a folder's hash cache is kept in the Epicenter folder's .epicenter, by identity", async () => {
	listing = {
		path: '/Users/me/Epicenter',
		git: false,
		folders: [{ name: 'Tapes', identity: identity('5'), git: false }],
		outside: [],
		unreadable: [],
	};
	const root = epicenterRoot();
	const [tapes] = expectOk(await root.list()).folders;
	expect(tapes?.identity).toEqual(identity('5'));
	const records = expectOk(await root.records());
	expect(records.store).toBeDefined();
	await records.hashes(identity('5')).load();
	expect(
		asked
			.filter(
				({ command }) => command === 'plugin:epicenter-folder|read_folder_file',
			)
			.map(({ body }) => body),
	).toEqual([{ path: 'hashes/5-1700000000000000000.json', root: 'Epicenter' }]);
});

test("each folder's store hears its own changes and names its root", async () => {
	listing = {
		path: '/Users/me/Epicenter',
		git: false,
		folders: [
			{ name: 'Notes', identity: identity('1'), git: false },
			{ name: 'Recipes', identity: identity('2'), git: false },
		],
		outside: [],
		unreadable: [],
	};
	const listed = expectOk(await epicenterRoot().list());
	const [notes, recipes] = listed.folders;
	if (notes === undefined || recipes === undefined)
		throw new Error('the listing names both folders');
	const notesHeard: unknown[] = [];
	const recipesHeard: unknown[] = [];
	expectOk(await notes.store.watch((paths) => notesHeard.push(paths)));
	expectOk(await recipes.store.watch((paths) => recipesHeard.push(paths)));
	heard?.({ payload: { root: { Folder: 'Notes' }, paths: ['a.md'] } });
	heard?.({ payload: { root: { Folder: 'Recipes' }, paths: null } });
	heard?.({ payload: { root: 'AppData', paths: ['account.json'] } });
	expect(notesHeard).toEqual([['a.md']]);
	expect(recipesHeard).toEqual(['all']);

	expectOk(await notes.store.put('a.md', new TextEncoder().encode('hi'), null));
	const put = asked.find(
		({ command }) => command === 'plugin:epicenter-folder|put_folder_file',
	);
	expect((put?.headers as { root: string }).root).toBe(
		encodeURIComponent('Folder/Notes'),
	);
});

test('making a folder makes its directory, then opens it', async () => {
	const made = expectOk(await epicenterRoot().make('Shared notes'));
	expect(made).toMatchObject({
		name: 'Shared notes',
		path: '/Users/me/Epicenter/Shared notes',
		identity: identity('9'),
	});
	expect(asked.map(({ command }) => command)).toEqual([
		'plugin:epicenter-folder|make_epicenter_folder',
		'plugin:epicenter-folder|open_root',
		'plugin:epicenter-folder|open_root',
	]);
	expect(opens()).toEqual(['Epicenter', 'Shared notes']);
});
