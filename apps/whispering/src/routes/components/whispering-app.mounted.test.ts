/** The real FolderApp and WhisperingApp root: route continuity and writes before folder release. */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { SaveError } from '@epicenter/folder';
import type { Whispering } from '../../lib/whispering.svelte.js';
import type { WhisperingContext } from '../../lib/folder.js';
import type {
	OpenWhisperingFolder,
	WhisperingFolder,
	Workspace,
} from '../../lib/workspace/types.js';
import {
	desktop,
	nativeWindow,
} from '../../../../../packages/svelte/src/tauri-window.test-support.js';

const { mount, unmount, flushSync } = await import('svelte');
const { openTestWorkspace, deferred, eventually } = await import(
	'../../lib/workspace.test-support.js'
);
const { pageState } = await import('../page-state.test-support.svelte.js');
const Root = (await import('./test-fixtures/WhisperingRoot.svelte')).default;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
	nativeWindow.reset();
});

async function render(
	options: {
		change?: (folder: WhisperingFolder, workspace: Workspace) => void;
		opener?: (open: OpenWhisperingFolder) => OpenWhisperingFolder;
	} = {},
) {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	options.change?.(test.folder, test.workspace);
	const page = pageState({ route: 'home' });
	const seen: { whispering: Whispering; context: WhisperingContext }[] = [];
	const target = document.createElement('main');
	document.body.append(target);
	const root = mount(Root, {
		target,
		props: {
			open: options.opener?.(test.open) ?? test.open,
			workspace: test.workspace,
			page,
			report: (whispering, context) => seen.push({ whispering, context }),
		},
	});
	let removed = false;
	async function destroy() {
		if (removed) return;
		removed = true;
		await unmount(root);
	}
	cleanups.push(async () => {
		await destroy();
		await eventually(() => test.closes === 1);
	});
	async function ready() {
		await eventually(() => {
			flushSync();
			return seen.length > 0;
		});
		return seen[0]!;
	}
	return { test, target, page, seen, ready, destroy };
}

test('route changes share one opened folder and keep recording', async () => {
	const app = await render();
	const first = await app.ready();
	expect(first.context.folder).toBe(app.test.folder);
	expect(first.whispering.library.connections?.transcription).toBeDefined();
	await first.whispering.library.startRecording();
	app.page.route = 'recordings';
	flushSync();
	expect(app.target.querySelector('[data-testid="route"]')?.textContent).toBe(
		'recordings',
	);
	expect(app.seen[1]?.whispering).toBe(first.whispering);
	expect(first.whispering.library.recorder.phase).toBe('recording');
	expect(app.test.opens).toBe(1);
});

test('unmount finishes the recording row before closing the folder exactly once', async () => {
	let atClose = '';
	let recordingPath = '';
	const app = await render({
		change(folder) {
			const close = folder.close;
			folder.close = async () => {
				atClose = await Bun.file(`${app.test.root}/${recordingPath}`).text();
				return await close();
			};
		},
	});
	const { whispering } = await app.ready();
	await whispering.library.startRecording();
	// Save completion no longer waits for the display queries to catch up.
	const rows = await readdir(`${app.test.root}/recordings`);
	expect(rows).toHaveLength(1);
	recordingPath = `recordings/${rows[0]}`;
	await app.destroy();
	await eventually(() => app.test.closes === 1);
	expect(atClose).toContain('durationMs:');
	expect(app.test.closes).toBe(1);
});

test('unmount waits for an accepted file write before closing', async () => {
	const gate = deferred<void>();
	const begun = deferred<void>();
	const app = await render({
		change(folder) {
			const write = folder.files.write;
			folder.files.write = async (...args) => {
				if (args[0] === 'kept.md') {
					begun.resolve();
					await gate.promise;
				}
				return write(...args);
			};
		},
	});
	const { whispering } = await app.ready();
	const creating = whispering.library.createFile('', 'kept.md');
	await begun.promise;
	await app.destroy();
	expect(app.test.closes).toBe(0);
	gate.resolve();
	expect(await creating).toBeUndefined();
	await eventually(() => app.test.closes === 1);
	expect(await Bun.file(`${app.test.root}/kept.md`).exists()).toBe(true);
});

test('unmount during opening closes once without starting the product', async () => {
	const gate = deferred<void>();
	const app = await render({
		opener: (open) => async () => {
			await gate.promise;
			return open();
		},
	});
	await app.destroy();
	gate.resolve();
	await eventually(() => app.test.closes === 1);
	expect(app.seen).toHaveLength(0);
	expect(await readdir(app.test.root)).toEqual([]);
});

test('unmount closes during a held first listing and starts no later reads', async () => {
	const gate = deferred<void>();
	const begun = deferred<void>();
	let listings = 0;
	let connections = 0;
	let microphones = 0;
	const app = await render({
		change(folder, workspace) {
			const read = workspace.connections.read;
			workspace.connections.read = () => {
				connections++;
				return read();
			};
			const microphone = workspace.preferences.microphone;
			workspace.preferences.microphone = () => {
				microphones++;
				return microphone();
			};
			const list = folder.files.list;
			folder.files.list = async () => {
				listings++;
				begun.resolve();
				await gate.promise;
				return list();
			};
		},
	});
	await begun.promise;
	await app.destroy();
	await eventually(() => app.test.closes === 1);
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 100));
	flushSync();
	expect(app.seen).toHaveLength(0);
	expect(await readdir(app.test.root)).toEqual(['.gitignore']);
	expect(connections).toBe(0);
	expect(microphones).toBe(0);
	expect(listings).toBe(1);
	expect(app.test.closes).toBe(1);
});

test('unmount waits for exclusion maintenance before closing', async () => {
	const gate = deferred<void>();
	const begun = deferred<void>();
	const app = await render({
		change(folder) {
			const write = folder.files.write;
			folder.files.write = async (...args) => {
				if (args[0] === '.gitignore') {
					begun.resolve();
					await gate.promise;
				}
				return write(...args);
			};
		},
	});
	await begun.promise;
	await app.destroy();
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(app.test.closes).toBe(0);
	gate.resolve();
	await eventually(() => app.test.closes === 1);
	expect(await readdir(app.test.root)).toEqual(['.gitignore']);
	expect(app.seen).toHaveLength(0);
});

test('startup failure shows the original error and unmount closes once', async () => {
	const app = await render({
		change(folder) {
			folder.files.list = async () => {
				throw new Error('the first listing was lost');
			};
		},
	});
	await eventually(() => {
		flushSync();
		return (
			app.target.textContent?.includes('Whispering could not start') === true
		);
	});
	expect(app.target.querySelector('[role="alert"]')?.textContent).toContain(
		'the first listing was lost',
	);
	await app.destroy();
	await eventually(() => app.test.closes === 1);
});

test('a refused exclusion write is visible in the shell', async () => {
	const app = await render({
		change(folder) {
			const write = folder.files.write;
			folder.files.write = async (...args) =>
				args[0] === '.gitignore'
					? SaveError.StorageFailed({
							cause: new Error('ignore file is read-only'),
						})
					: write(...args);
		},
	});
	await app.ready();
	expect(app.target.textContent).toContain(
		'Audio exclusion could not be confirmed at startup',
	);
	expect(app.target.textContent).toContain('ignore file is read-only');
});

test('the page waits for the desktop close listener before starting', async () => {
	const gate = deferred<void>();
	nativeWindow.registration = gate.promise;
	desktop(true);
	const app = await render();
	await eventually(() => app.test.opens === 1);
	flushSync();
	expect(app.seen).toHaveLength(0);
	expect(nativeWindow.listeners).toBe(0);
	expect(await readdir(app.test.root)).toEqual([]);
	gate.resolve();
	await app.ready();
	expect(nativeWindow.listeners).toBe(1);
});

test('a failed desktop close listener shows refusal and closes once', async () => {
	nativeWindow.refuseRegistration = true;
	desktop(true);
	const app = await render();
	await eventually(() => {
		flushSync();
		return app.target.querySelector('[role="alert"]') !== null;
	});
	expect(app.target.querySelector('[role="alert"]')?.textContent).toContain(
		'Close listener could not be installed',
	);
	expect(app.seen).toHaveLength(0);
	expect(await readdir(app.test.root)).toEqual([]);
	await app.destroy();
	await eventually(() => app.test.closes === 1);
	expect(nativeWindow.listeners).toBe(0);
});
