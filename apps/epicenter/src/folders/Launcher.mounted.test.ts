/**
 * The launcher renders one native folder list and opens rows by their IDs.
 * Pending handoffs survive listener startup, default labels survive forgetting
 * bookmarks, and focusing refreshes folders located outside the watched root.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { FolderListing } from '../ui/bindings.gen';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);
describe.skipIf(!browser)('folder launcher startup', async () => {
	if (!browser) return;
	await import('../../../../packages/svelte/src/svelte-dom.test-support.js');
	const { flushSync, mount, unmount } = await import('svelte');
	let subscribed!: (stop: () => void) => void;
	let pending: string[] = [];
	let reads = 0;
	let listing: FolderListing = { folders: [], problems: [] };
	let focused!: (event: { payload: boolean }) => void;
	const calls: string[] = [];
	mock.module('@tauri-apps/api/webviewWindow', () => ({
		getCurrentWebviewWindow: () => ({
			onFocusChanged: (listener: typeof focused) => {
				focused = listener;
				return Promise.resolve(() => {});
			},
			listen: (name: string) =>
				name === 'epicenter://folder-openings-changed'
					? new Promise<() => void>((resolve) => {
							subscribed = resolve;
						})
					: Promise.resolve(() => {}),
		}),
	}));
	mock.module('../ui/bindings.gen', () => ({
		commands: {
			listDataFolders: async () => listing,
			pendingFolderOpenings: async () => {
				reads++;
				return pending;
			},
			openFolderEditor: async (id: string) => {
				calls.push(`edit:${id}`);
				return { data: null, error: null };
			},
			forgetFolderBookmarks: async (id: string) => {
				calls.push(`forget:${id}`);
				listing = {
					...listing,
					folders: listing.folders.flatMap((folder) =>
						folder.id !== id
							? [folder]
							: folder.defaultFor !== null
								? [{ ...folder, bookmarks: [] }]
								: [],
					),
				};
				return { data: null, error: null };
			},
		},
	}));
	const { default: App } = await import('./App.svelte');
	test('reads pending requests after the native listener is registered', async () => {
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		try {
			flushSync();
			for (let n = 0; n < 10; n++) {
				await Bun.sleep(0);
				flushSync();
			}
			expect(reads).toBe(0);
			pending = ['/tmp/request-during-subscription'];
			subscribed(() => {});
			for (
				let n = 0;
				n < 100 && !target.textContent?.includes(pending[0]!);
				n++
			) {
				await Bun.sleep(5);
				flushSync();
			}
			expect(target.textContent).toContain(pending[0]!);
			expect(reads).toBe(1);
		} finally {
			await unmount(view);
			target.remove();
		}
	});

	test('one folder list shows paths and defaults, opens by ID, and retains a root default after forgetting its bookmark', async () => {
		pending = [];
		calls.length = 0;
		listing = {
			problems: [],
			folders: [
				{
					id: 'folder:work',
					title: 'Todos',
					path: '/Epicenter/so.epicenter.todos',
					protected: false,
					defaultFor: 'Todos',
					bookmarks: ['/Epicenter/so.epicenter.todos'],
					temporary: false,
					problem: null,
				},
				{
					id: 'folder:personal',
					title: 'Notes',
					path: '/Personal/Notes',
					protected: true,
					defaultFor: null,
					bookmarks: [],
					temporary: false,
					problem: null,
				},
			],
		};
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		try {
			for (let n = 0; n < 15; n++) {
				await Bun.sleep(0);
				flushSync();
			}
			subscribed(() => {});
			const rows = () =>
				target.querySelectorAll('ul[aria-label="Folders"] > li');
			expect(rows().length).toBe(2);
			expect(target.querySelector('[aria-label="Opened folders"]')).toBeNull();
			expect(rows()[0]!.textContent).toContain('/Epicenter/so.epicenter.todos');
			expect(rows()[0]!.textContent).toContain('Default for Todos');
			expect(rows()[1]!.textContent).toContain('/Personal/Notes');
			expect(rows()[1]!.textContent).not.toContain('Default for');
			expect(rows()[0]!.textContent).toContain('Open with…');
			expect(rows()[1]!.textContent).not.toContain('Open with…');
			expect(
				(rows()[1]!.querySelector('button') as HTMLButtonElement).disabled,
			).toBe(false);
			(rows()[1]!.querySelector('button') as HTMLButtonElement).click();
			for (let n = 0; n < 10; n++) {
				await Bun.sleep(0);
				flushSync();
			}
			expect(calls).toContain('edit:folder:personal');
			const forget = [...rows()[0]!.querySelectorAll('button')].find((button) =>
				button.textContent?.includes('Forget bookmark'),
			)!;
			forget.click();
			for (let n = 0; n < 10; n++) {
				await Bun.sleep(0);
				flushSync();
			}
			expect(calls).toContain('forget:folder:work');
			expect(rows().length).toBe(2);
			expect(rows()[0]!.textContent).toContain('Default for Todos');
			expect(rows()[0]!.textContent).not.toContain('Forget bookmark');
		} finally {
			await unmount(view);
			target.remove();
		}
	});

	test('an unavailable bookmark refreshes on focus and can be forgotten without opening it', async () => {
		pending = [];
		calls.length = 0;
		listing = {
			problems: [],
			folders: [
				{
					id: 'folder:missing',
					title: 'Missing',
					path: '/Gone/Missing',
					protected: false,
					defaultFor: null,
					bookmarks: ['/Gone/Missing'],
					temporary: false,
					problem: 'This folder is not there.',
				},
			],
		};
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		try {
			for (let n = 0; n < 15; n++) {
				await Bun.sleep(0);
				flushSync();
			}
			subscribed(() => {});
			const row = target.querySelector('ul[aria-label="Folders"] > li')!;
			expect(row.textContent).toContain('/Gone/Missing');
			expect(row.textContent).toContain('This folder is not there.');
			expect((row.querySelector('button') as HTMLButtonElement).disabled).toBe(
				true,
			);
			listing = {
				...listing,
				folders: listing.folders.map((folder) => ({
					...folder,
					problem: null,
				})),
			};
			focused({ payload: true });
			for (let n = 0; n < 10; n++) {
				await Bun.sleep(0);
				flushSync();
			}
			expect((row.querySelector('button') as HTMLButtonElement).disabled).toBe(
				false,
			);
			expect(row.textContent).not.toContain('This folder is not there.');
			[...row.querySelectorAll('button')]
				.find((button) => button.textContent?.includes('Forget bookmark'))!
				.click();
			for (let n = 0; n < 10; n++) {
				await Bun.sleep(0);
				flushSync();
			}
			expect(calls).toEqual(['forget:folder:missing']);
			expect(target.textContent).toContain('No folders yet.');
		} finally {
			await unmount(view);
			target.remove();
		}
	});
});
