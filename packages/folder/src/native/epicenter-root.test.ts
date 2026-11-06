/**
 * Epicenter Root Tests
 *
 * `epicenterRoot()` from `@epicenter/folder/tauri`: the Epicenter folder over
 * a stand-in folder plugin, as the Epicenter app's window reaches it.
 *
 * Key behaviors:
 * - A listing names each folder with its path and identity, opening its
 *   root once; one whose root does not open is unreadable, with why
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
const identity = (inode: string) => ({ device: '1', inode });

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
			const name = body?.root?.Folder ?? '';
			if (refuseOpen.has(name))
				throw {
					name: 'Refused',
					folder: `/Users/me/Epicenter/${name}`,
					reason: 'it holds every Epicenter folder',
				};
			return `/Users/me/Epicenter/${name}`;
		}
		if (command === 'plugin:epicenter-folder|make_epicenter_folder')
			return { name: body?.name, identity: identity('9') };
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
		.map(({ body }) => (body as { root: { Folder: string } }).root.Folder);

test('a listing opens each folder once and names one that does not open', async () => {
	listing = {
		path: '/Users/me/Epicenter',
		folders: [
			{ name: 'Notes', identity: identity('1') },
			{ name: 'Recipes', identity: identity('2') },
			{ name: 'Everything', identity: identity('3') },
		],
		unreadable: [{ name: 'Gone', reason: 'it links to a folder that is gone' }],
	};
	refuseOpen = new Set(['Everything']);
	const root = epicenterRoot();
	expect(root.path).toBe('');
	const listed = expectOk(await root.list());
	expect(root.path).toBe('/Users/me/Epicenter');
	expect(
		listed.folders.map(({ name, path, identity }) => ({
			name,
			path,
			identity,
		})),
	).toEqual([
		{
			name: 'Notes',
			path: '/Users/me/Epicenter/Notes',
			identity: identity('1'),
		},
		{
			name: 'Recipes',
			path: '/Users/me/Epicenter/Recipes',
			identity: identity('2'),
		},
	]);
	expect(listed.unreadable.map(({ name }) => name)).toEqual([
		'Gone',
		'Everything',
	]);
	expect(listed.unreadable[1]?.reason).toContain(
		'holds every Epicenter folder',
	);
	expect(opens()).toEqual(['Notes', 'Recipes', 'Everything']);

	// The same folders open nothing again; one replaced opens again.
	asked.length = 0;
	refuseOpen = new Set(['Everything']);
	listing = {
		path: '/Users/me/Epicenter',
		folders: [
			{ name: 'Notes', identity: identity('1') },
			{ name: 'Recipes', identity: identity('7') },
		],
		unreadable: [],
	};
	expectOk(await root.list());
	expect(opens()).toEqual(['Recipes']);
});

test("each folder's store hears its own changes and names its root", async () => {
	listing = {
		path: '/Users/me/Epicenter',
		folders: [
			{ name: 'Notes', identity: identity('1') },
			{ name: 'Recipes', identity: identity('2') },
		],
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
	]);
});
