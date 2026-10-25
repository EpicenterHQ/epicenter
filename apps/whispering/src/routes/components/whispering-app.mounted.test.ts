/**
 * The real OpenFolder and WhisperingApp root: route continuity, an unmount
 * that waits for no workflow, a recording left to the page's departure, and
 * a selection that follows what the folder shows.
 */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import type { Folder } from '@epicenter/folder/next';
import { expectOk } from 'wellcrafted/testing';
import { SaveError } from '../../../../../packages/folder/src/shared/errors.js';
import {
	desktop,
	nativeWindow,
} from '../../../../../packages/svelte/src/tauri-window.test-support.js';
import type { WhisperingTables } from '../../lib/definition.js';
import type { WhisperingFolder } from '../../lib/folder.js';
import type { WhisperingServices } from '../../lib/platform/types.js';
import type { Whispering } from '../../lib/whispering.svelte.js';

const { mount, unmount, flushSync } = await import('svelte');
const { openTestServices, provideServices, deferred, eventually } =
	await import('../../lib/services.test-support.js');
const { toggleSelected } = await import('../../lib/recording-collection.js');
const { pageState } = await import('../page-state.test-support.svelte.js');
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
	nativeWindow.reset();
});

async function render(
	options: {
		/** Change the opened folder, below what `<OpenFolder>` wraps, or the services. */
		change?: (
			opened: Folder<WhisperingTables>,
			services: WhisperingServices,
		) => void;
		opener?: (
			open: Awaited<ReturnType<typeof openTestServices>>['open'],
		) => Awaited<ReturnType<typeof openTestServices>>['open'];
	} = {},
) {
	const test = await openTestServices();
	cleanups.push(test.remove);
	options.change?.(test.opened, test.services);
	// `<OpenFolder>` wraps the folder it opens itself.
	provideServices('any', test.services);
	const Root = (await import('./test-fixtures/WhisperingRoot.svelte')).default;
	const page = pageState({ route: 'home' });
	const seen: { whispering: Whispering; folder: WhisperingFolder }[] = [];
	const target = document.createElement('main');
	document.body.append(target);
	const root = mount(Root, {
		target,
		props: {
			open: options.opener?.(test.open) ?? test.open,
			page,
			report: (whispering, folder) => seen.push({ whispering, folder }),
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
	expect(first.whispering.connections?.transcription).toBeDefined();
	await first.whispering.startRecording();
	app.page.route = 'recordings';
	flushSync();
	expect(app.target.querySelector('[data-testid="route"]')?.textContent).toBe(
		'recordings',
	);
	expect(app.seen[1]?.whispering).toBe(first.whispering);
	expect(app.seen[1]?.folder).toBe(first.folder);
	expect(first.whispering.recorder.phase).toBe('recording');
	await eventually(() => !first.folder.saving);
	// Recording alone adds no browser departure warning. OpenFolder asks only
	// while a write is out.
	const departure = new window.Event('beforeunload', { cancelable: true });
	expect(window.dispatchEvent(departure)).toBe(true);
	expect(app.test.opens).toBe(1);
});

test('unmount leaves a recording to the page’s departure and closes the folder exactly once', async () => {
	const app = await render();
	const { whispering } = await app.ready();
	await whispering.startRecording();
	const rows = await readdir(`${app.test.root}/recordings`);
	expect(rows).toHaveLength(1);
	await app.destroy();
	await eventually(() => app.test.closes === 1);
	// Nothing was stopped or written: the fixture writes its audio only on
	// Stop, and the row written at start has no length.
	expect(await readdir(`${app.test.root}/recordings`)).toEqual(rows);
	expect(
		await Bun.file(`${app.test.root}/recordings/${rows[0]}`).text(),
	).not.toContain('durationMs:');
	expect(app.test.closes).toBe(1);
});

test('unmount waits for no file command held before the folder', async () => {
	const gate = deferred<void>();
	const begun = deferred<void>();
	const app = await render({
		change(opened) {
			const write = opened.write;
			opened.write = async (...args) => {
				if (args[0] === 'kept.md') {
					begun.resolve();
					await gate.promise;
				}
				return write(...args);
			};
		},
	});
	const { whispering } = await app.ready();
	const creating = whispering.createFile('', 'kept.md');
	await begun.promise;
	await app.destroy();
	await eventually(() => app.test.closes === 1);
	gate.resolve();
	// The folder closed first, so it takes no new write.
	expect(await creating).toContain('closed');
	expect(app.test.closes).toBe(1);
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

test('unmount during exclusion maintenance closes without waiting for it', async () => {
	const gate = deferred<void>();
	const begun = deferred<void>();
	const app = await render({
		change(opened) {
			const write = opened.write;
			opened.write = async (...args) => {
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
	// Held above the folder, so the folder never took it.
	await eventually(() => app.test.closes === 1);
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(app.test.closes).toBe(1);
	expect(app.seen).toHaveLength(0);
});

test('startup failure shows the original error and unmount closes once', async () => {
	const app = await render({
		change(_opened, services) {
			services.recoverRecordings = async () => {
				throw new Error('the recorder could not be reached');
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
		'the recorder could not be reached',
	);
	await app.destroy();
	await eventually(() => app.test.closes === 1);
});

test('a refused exclusion write is visible in the shell', async () => {
	const app = await render({
		change(opened) {
			const write = opened.write;
			opened.write = async (...args) =>
				args[0] === '.gitignore'
					? SaveError.StorageFailed({
							cause: new Error('ignore file is read-only'),
						})
					: write(...args);
		},
	});
	await app.ready();
	await eventually(() => {
		flushSync();
		return (
			app.target.textContent?.includes(
				'Git defaults could not be checked at startup',
			) === true
		);
	});
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

test('a selected recording that left the folder is unticked once the folder shows it gone, so a new file at its path is not ticked', async () => {
	const app = await render();
	const { whispering, folder } = await app.ready();
	const { view } = whispering;
	for (const name of ['standup', 'walk'])
		expectOk(
			await folder.tables.recordings.create(name, {
				fields: {
					title: name,
					recordedAt: '2026-03-02T09:00:00.000Z' as never,
					capture: 'microphone',
				},
				body: '',
			}),
		);
	for (const name of ['standup', 'walk'])
		view.recordingSelected = toggleSelected(
			view.recordingSelected,
			`recordings/${name}.md`,
			true,
			whispering,
		);
	const row = folder.file('recordings/standup.md')?.data;

	// A search that hides a selected row unticks nothing.
	view.recordingQuery = 'walk';
	flushSync();
	expect(view.recordingSelected).toEqual([
		'recordings/standup.md',
		'recordings/walk.md',
	]);

	// Once the folder shows it gone, it is unticked.
	expectOk(await folder.delete('recordings/standup.md'));
	await eventually(() => {
		flushSync();
		return view.recordingSelected.length === 1;
	});
	expect(view.recordingSelected).toEqual(['recordings/walk.md']);

	// Another file made at that path later is another recording: it arrives unticked.
	if (typeof row !== 'string') throw new Error('Expected row text');
	expectOk(await folder.write('recordings/standup.md', row));
	view.recordingQuery = '';
	flushSync();
	expect(view.recordingSelected).toEqual(['recordings/walk.md']);
});
