/** Requests arriving before listener installation must appear after it settles. */
import { describe, expect, mock, test } from 'bun:test';

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
	mock.module('@tauri-apps/api/webviewWindow', () => ({
		getCurrentWebviewWindow: () => ({
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
			listDataFolders: async () => ({ data: [], error: null }),
			pendingFolderOpenings: async () => {
				reads++;
				return pending;
			},
			listRememberedFolders: async () => ({ folders: [], problem: null }),
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
});
