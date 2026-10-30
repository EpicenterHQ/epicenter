/**
 * The Folders window over a fake shell: the synced folders the CLI lists,
 * each with its last round, the requests an `epicenter://init` link queued,
 * and the service's state, with each action one shell command.
 *
 * Key behaviors:
 * - It reads only after its change listener is registered, and reads again
 *   on each change event
 * - Each row says its round in the CLI's words; Sync now runs one round and
 *   says so while it runs
 * - A request is set up or dismissed by its path
 * - A stopped service is said, with a way to start it again
 */
import { describe, expect, mock, test } from 'bun:test';
import type {
	SyncedFolder,
	SyncedFolderListing,
	SyncRound,
} from '../ui/bindings.gen';

const browser = Bun.resolveSync('svelte', import.meta.dir).endsWith(
	'index-client.js',
);
describe.skipIf(!browser)('folders window', async () => {
	if (!browser) return;
	await import('../../../../packages/svelte/src/svelte-dom.test-support.js');
	const { flushSync, mount, unmount } = await import('svelte');

	let subscribed!: (stop: () => void) => void;
	let changed!: () => void;
	let listing: SyncedFolderListing;
	let reads = 0;
	const calls: string[] = [];
	let finishSync: (() => void) | undefined;

	mock.module('@tauri-apps/api/webviewWindow', () => ({
		getCurrentWebviewWindow: () => ({
			onFocusChanged: () => Promise.resolve(() => {}),
			listen: (name: string, listener: () => void) => {
				expect(name).toBe('epicenter://synced-folders-changed');
				changed = listener;
				return new Promise<() => void>((resolve) => {
					subscribed = resolve;
				});
			},
		}),
	}));
	const ok = <T>(data: T) => ({ data, error: null });
	mock.module('../ui/bindings.gen', () => ({
		commands: {
			syncedFolders: async () => {
				reads++;
				return ok(listing);
			},
			syncFolderNow: async (path: string) => {
				calls.push(`sync:${path}`);
				await new Promise<void>((resolve) => {
					finishSync = resolve;
				});
				return ok(round({ folder: path }));
			},
			acceptFolderSetup: async (path: string) => {
				calls.push(`setup:${path}`);
				listing = { ...listing, setups: [] };
				return ok({ folder: path, changed: [], warnings: ['no command link'] });
			},
			dismissFolderSetup: async (path: string) => {
				calls.push(`dismiss:${path}`);
				listing = { ...listing, setups: [] };
			},
			restartSyncService: async () => {
				calls.push('restart');
				listing = { ...listing, service: { state: 'running' } };
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

	function round(overrides: Partial<SyncRound> = {}): SyncRound {
		return {
			folder: '/f/notes',
			status: 'synced',
			head: 'abc',
			notes: [],
			message: null,
			endedAt: Date.now(),
			...overrides,
		};
	}

	function folder(name: string, last: SyncRound | null): SyncedFolder {
		return {
			path: `/f/${name}`,
			name,
			remote: `https://git.epicenter.so/me/${name}.git`,
			changes: 0,
			ahead: 0,
			behind: 0,
			problem: null,
			last,
		};
	}

	async function open() {
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(App, { target });
		await settle();
		return {
			target,
			row: (name: string) =>
				target.querySelector(`[aria-label="${name}"]`) as HTMLElement,
			button: (scope: ParentNode, text: string) =>
				[...scope.querySelectorAll('button')].find(
					(button) => button.textContent?.trim() === text,
				) as HTMLButtonElement,
			async close() {
				await unmount(view);
				target.remove();
			},
		};
	}

	test('reads after its listener is registered, and again on each change', async () => {
		reads = 0;
		listing = {
			folders: [],
			service: { state: 'running' },
			setups: [],
		};
		const window = await open();
		try {
			expect(reads).toBe(0);
			subscribed(() => {});
			await settle();
			expect(reads).toBe(1);
			expect(window.target.textContent).toContain('No folders sync yet');
			listing = {
				...listing,
				folders: [folder('notes', round())],
			};
			changed();
			await settle();
			expect(reads).toBe(2);
			expect(window.row('notes').textContent).toContain('Synced just now');
			expect(window.row('notes').textContent).toContain('me/notes');
		} finally {
			await window.close();
		}
	});

	test('each row says its round in the CLI words, and Sync now says it runs', async () => {
		calls.length = 0;
		listing = {
			folders: [
				folder('notes', round()),
				folder(
					'audio',
					round({ status: 'retry', message: 'index.lock is held (3 s old)' }),
				),
				folder(
					'drafts',
					round({
						status: 'stopped',
						message: 'the remote main was rewritten',
					}),
				),
				folder('fresh', null),
			],
			service: { state: 'running' },
			setups: [],
		};
		const window = await open();
		try {
			subscribed(() => {});
			await settle();
			expect(window.row('audio').textContent).toContain('Will try again');
			expect(window.row('audio').textContent).toContain(
				'index.lock is held (3 s old)',
			);
			expect(window.row('drafts').textContent).toContain('Stopped');
			expect(window.row('fresh').textContent).toContain(
				'Waiting for the first sync',
			);

			window.button(window.row('notes'), 'Sync now').click();
			await settle();
			expect(calls).toEqual(['sync:/f/notes']);
			expect(window.row('notes').textContent).toContain('Syncing…');
			expect(window.button(window.row('notes'), 'Sync now').disabled).toBe(
				true,
			);
			finishSync?.();
			await settle();
			expect(window.row('notes').textContent).not.toContain('Syncing…');
		} finally {
			await window.close();
		}
	});

	test('a request from a link is set up or dismissed by its path', async () => {
		calls.length = 0;
		const request = {
			path: '/Users/me/Recorder',
			contract: 'https://recorder.example/contract.json',
		};
		listing = { folders: [], service: { state: 'running' }, setups: [request] };
		const window = await open();
		try {
			subscribed(() => {});
			await settle();
			const card = window.target.querySelector(
				'[aria-label="Requests to sync folders"]',
			) as HTMLElement;
			expect(card.textContent).toContain(request.path);
			expect(card.textContent).toContain(request.contract);
			window.button(card, 'Set up').click();
			await settle();
			expect(calls).toEqual([`setup:${request.path}`]);
			expect(window.target.textContent).toContain('no command link');
			expect(
				window.target.querySelector('[aria-label="Requests to sync folders"]'),
			).toBeNull();

			listing = { ...listing, setups: [request] };
			changed();
			await settle();
			window
				.button(
					window.target.querySelector(
						'[aria-label="Requests to sync folders"]',
					) as HTMLElement,
					'Dismiss',
				)
				.click();
			await settle();
			expect(calls).toEqual([
				`setup:${request.path}`,
				`dismiss:${request.path}`,
			]);
		} finally {
			await window.close();
		}
	});

	test('a stopped service is said, and starts again', async () => {
		calls.length = 0;
		listing = {
			folders: [],
			service: { state: 'stopped', reason: 'bun: command not found' },
			setups: [],
		};
		const window = await open();
		try {
			subscribed(() => {});
			await settle();
			expect(window.target.textContent).toContain('Syncing is paused');
			expect(window.target.textContent).toContain('bun: command not found');
			window.button(window.target, 'Start syncing again').click();
			await settle();
			expect(calls).toEqual(['restart']);
			expect(window.target.textContent).not.toContain('Syncing is paused');
		} finally {
			await window.close();
		}
	});
});
