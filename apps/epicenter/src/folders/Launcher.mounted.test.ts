/**
 * Mounted Folders launcher tests for grouped rows, native ID actions, and
 * pending handoffs that arrive while the native listener is registering.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { FolderListing, ListedFolder } from '../ui/bindings.gen';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);
describe.skipIf(!browser)('folder launcher', async () => {
	if (!browser) return;
	await import('../../../../packages/svelte/src/svelte-dom.test-support.js');
	const { flushSync, mount, unmount } = await import('svelte');
	let subscribed!: (stop: () => void) => void;
	let pending: string[] = [];
	let reads = 0;
	let listing: FolderListing = {
		folders: [],
		libraryName: 'Epicenter Dev',
		problems: [],
	};
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
	const okay = { data: null, error: null };
	mock.module('../ui/bindings.gen', () => ({
		commands: {
			listDataFolders: async () => listing,
			pendingFolderOpenings: async () => {
				reads++;
				return pending;
			},
			openFolderEditor: async (id: string) => {
				calls.push(`edit:${id}`);
				return { data: { rememberProblem: null }, error: null };
			},
			pinFolder: async (id: string) => {
				calls.push(`pin:${id}`);
				listing = {
					...listing,
					folders: listing.folders.map((row) =>
						row.id === id ? { ...row, group: 'pinned' } : row,
					),
				} as FolderListing;
				return okay;
			},
			unpinFolder: async (id: string) => {
				calls.push(`unpin:${id}`);
				listing = {
					...listing,
					folders: listing.folders.filter((row) => row.id !== id),
				};
				return okay;
			},
			removeRecentFolder: async (id: string) => {
				calls.push(`remove:${id}`);
				return okay;
			},
		},
	}));
	const { default: App } = await import('./App.svelte');
	async function settle() {
		for (let n = 0; n < 15; n++) {
			await Bun.sleep(0);
			flushSync();
		}
	}
	function row(
		id: string,
		group: ListedFolder['group'],
		problem: string | null = null,
	): ListedFolder {
		return {
			id,
			title: id,
			path: `/folder/${id}`,
			group,
			recent: group === 'recent',
			protected: false,
			defaultFor: null,
			temporary: false,
			problem,
		};
	}
	test('reads pending handoffs after the listener is registered', async () => {
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		try {
			await settle();
			expect(reads).toBe(0);
			pending = ['/tmp/request-during-subscription'];
			subscribed(() => {});
			await settle();
			expect(target.textContent).toContain(pending[0]!);
			expect(reads).toBe(1);
		} finally {
			await unmount(view);
			target.remove();
		}
	});

	test('groups folders by pin, library name, then recent and opens by native ID', async () => {
		pending = [];
		calls.length = 0;
		listing = {
			libraryName: 'Epicenter Dev',
			problems: [],
			folders: [
				row('one', 'pinned'),
				row('two', 'library'),
				row('three', 'recent'),
			],
		};
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		try {
			await settle();
			subscribed(() => {});
			const headings = [...target.querySelectorAll('h2')].map(
				(heading) => heading.textContent,
			);
			expect(headings.slice(0, 3)).toEqual([
				'Pinned',
				'Epicenter Dev',
				'Recent',
			]);
			const rows = target.querySelectorAll(
				'ul[aria-label="Epicenter Dev"] > li',
			);
			expect(rows).toHaveLength(1);
			(rows[0]!.querySelector('button') as HTMLButtonElement).click();
			await settle();
			expect(calls).toContain('edit:two');
			expect(rows[0]!.textContent).toContain('/folder/two');
		} finally {
			await unmount(view);
			target.remove();
		}
	});

	test('a missing pin remains visible, cannot open, and refreshes after focus', async () => {
		pending = [];
		listing = {
			libraryName: 'Epicenter Dev',
			problems: [],
			folders: [row('missing', 'pinned', 'This folder is not there.')],
		};
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		try {
			await settle();
			subscribed(() => {});
			const item = target.querySelector('ul[aria-label="Pinned"] > li')!;
			expect(item.textContent).toContain('This folder is not there.');
			expect((item.querySelector('button') as HTMLButtonElement).disabled).toBe(
				true,
			);
			listing = { ...listing, folders: [row('missing', 'pinned')] };
			focused({ payload: true });
			await settle();
			expect((item.querySelector('button') as HTMLButtonElement).disabled).toBe(
				false,
			);
		} finally {
			await unmount(view);
			target.remove();
		}
	});

	test('a missing pin can be unpinned from its contextual menu', async () => {
		pending = [];
		calls.length = 0;
		listing = {
			libraryName: 'Epicenter Dev',
			problems: [],
			folders: [row('missing', 'pinned', 'This folder is not there.')],
		};
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		try {
			await settle();
			subscribed(() => {});
			const item = target.querySelector('ul[aria-label="Pinned"] > li')!;
			(
				[...item.querySelectorAll('button')].find((button) =>
					button.textContent?.includes('Actions'),
				) as HTMLButtonElement
			).click();
			await settle();
			const unpin = [...document.querySelectorAll('[role="menuitem"]')].find(
				(item) => item.textContent?.includes('Unpin'),
			) as HTMLElement;
			expect(unpin).toBeDefined();
			unpin.click();
			await settle();
			expect(calls).toContain('unpin:missing');
			expect(target.textContent).toContain('No folders yet.');
		} finally {
			await unmount(view);
			target.remove();
		}
	});
});
