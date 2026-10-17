/**
 * Folder App Mounted Tests
 *
 * Mounts the real `<FolderApp>` in jsdom over a browser folder on the
 * in-memory OPFS stand-in, with the toaster an app layout mounts.
 *
 * Key behaviors:
 * - The loading screen shows until the folder opens; then the children
 *   render and read the opened folder with `getFolder()`
 * - A folder that cannot open is the refusal screen, worded for the
 *   refusal, and nothing renders the children
 * - A failed save is one toast that offers the unsaved text to copy, and
 *   stays up
 * - Unmounting closes the folder: a write after it is refused `Closed`
 *
 * Run with `bun run test`.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { defineFolder, defineTable, field } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import {
	browserStorage,
	createTestStorage,
} from '../../folder/src/browser-storage.test-support.js';
import type { FolderContext } from './folder-context.js';
import { click } from './svelte-dom.test-support.js';
import { ActionError } from './write-failure.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createFolderContext } = await import('./folder-context.js');
const { default: FolderAppHost } = await import(
	'./fixtures/FolderAppHost.svelte'
);

const definition = defineFolder({
	title: 'Notes',
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

let count = 0;

/** Mount the root over `browser`; answers the context once a child reads it. */
function mountApp(browser: Parameters<typeof browserStorage>[0] | undefined) {
	const opened = Promise.withResolvers<FolderContext<typeof definition>>();
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(FolderAppHost, {
		target,
		props: {
			app: { id: `so.epicenter.app-test-${count++}`, title: 'Notes' },
			definition,
			browser: browser === undefined ? undefined : browserStorage(browser),
			onFolder: (context) =>
				opened.resolve(context as unknown as FolderContext<typeof definition>),
		},
	});
	let mounted = true;
	const remove = () => {
		if (!mounted) return;
		mounted = false;
		unmount(component);
		target.remove();
	};
	cleanup.push(remove);
	return { target, opened: opened.promise, remove };
}

/** Wait until `check` holds, letting effects and timers run between tries. */
async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 200; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

test('the loading screen shows until the folder opens, then the children read it', async () => {
	const storage = createTestStorage();
	const gate = Promise.withResolvers<void>();
	const opfs = storage.opfs;
	const held = {
		...storage,
		opfs: {
			...opfs,
			getDirectory: async () => {
				await gate.promise;
				return opfs.getDirectory();
			},
		},
	};
	const { target, opened } = mountApp(held);
	flushSync();
	expect(target.textContent).toContain('Opening Notes…');
	expect(target.querySelector('[data-testid="opened"]')).toBeNull();

	gate.resolve();
	const context = await opened;
	cleanup.push(() => context.close());
	await until(
		() => target.querySelector('[data-testid="opened"]') !== null,
		'the children',
	);
	expect(target.textContent).not.toContain('Opening Notes…');
	expect(context.isOwn).toBe(true);
	expect(
		target.querySelector('[data-testid="opened"]')?.textContent,
	).toStartWith('so.epicenter.app-test-');
	// The page's one query client is the one the context holds.
	expect(context.queryClient.getDefaultOptions().queries?.staleTime).toBe(
		Number.POSITIVE_INFINITY,
	);
	expect(context.queryClient.getDefaultOptions().queries?.retry).toBe(false);
});

test('a folder that cannot open is the refusal screen, worded for it, with no children', async () => {
	// jsdom has no origin private file system.
	const { target } = mountApp(undefined);
	await until(
		() => target.textContent?.includes('could not open its folder') ?? false,
		'the refusal',
	);
	expect(target.textContent).toContain('Notes could not open its folder');
	expect(target.querySelector('[role="alert"]')?.textContent).toBe(
		"This browser cannot keep Notes's files: navigator.storage.getDirectory is not available here. Open Notes in a current browser.",
	);
	// Opening again would meet the same browser.
	expect(target.textContent).not.toContain('Try again');
	expect(target.querySelector('[data-testid="opened"]')).toBeNull();
});

/** The clipboard answers `writeText` with `answer`; answers what it took. */
function clipboard(answer: 'takes' | 'refuses') {
	const copied: string[] = [];
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				if (answer === 'refuses') throw new Error('Clipboard access denied');
				copied.push(text);
			},
		},
	});
	return copied;
}

/** Whether a toast saying `path` did not save is up. */
const toastFor = (path: string) =>
	document.body.textContent?.includes(`Could not save ${path}`) ?? false;

/** Wait until the toast for `path` is gone, letting its exit animation end. */
async function gone(path: string) {
	await until(() => !toastFor(path), `the toast for ${path} to close`);
}

/** Wait a while and say whether the toast for `path` is still up. */
async function stillUp(path: string) {
	for (let tries = 0; tries < 60; tries++) {
		flushSync();
		await Bun.sleep(5);
	}
	return toastFor(path);
}

const deleted = ActionError.NotStarted({
	reason: 'The note was deleted elsewhere, so your edit was not saved.',
}).error;

test('a failed save is one toast that offers the unsaved text, and closes once the clipboard took it', async () => {
	const copied = clipboard('takes');
	const { opened } = mountApp(createTestStorage());
	const context = await opened;
	cleanup.push(() => context.close());

	context.writeFailed({
		path: 'notes/a.md',
		error: deleted,
		unsaved: 'What I typed',
	});
	await until(() => toastFor('notes/a.md'), 'the toast');
	expect(document.body.textContent).toContain(
		'The note was deleted elsewhere, so your edit was not saved.',
	);
	click(document.body, 'Copy your text');
	await gone('notes/a.md');
	expect(copied).toEqual(['What I typed']);
});

test('a copy the clipboard refuses keeps the toast up, with the text to select', async () => {
	clipboard('refuses');
	const { opened } = mountApp(createTestStorage());
	const context = await opened;
	cleanup.push(() => context.close());

	context.writeFailed({
		path: 'notes/b.md',
		error: deleted,
		unsaved: 'Only here',
	});
	await until(() => toastFor('notes/b.md'), 'the toast');
	// A second click while the first copy runs starts none.
	click(document.body, 'Copy your text');
	click(document.body, 'Copy your text');
	await until(
		() => document.querySelector('[data-testid="unsaved-text"]') !== null,
		'the text to select',
	);
	expect(await stillUp('notes/b.md')).toBe(true);
	const box = document.querySelector<HTMLTextAreaElement>(
		'[data-testid="unsaved-text"]',
	);
	expect(box?.value).toBe('Only here');
	expect(
		document.querySelectorAll('[data-testid="unsaved-text"]'),
	).toHaveLength(1);
	expect(document.body.textContent).toContain('Copying did not work');
	// Copying again stays possible.
	expect(document.body.textContent).toContain('Copy your text');
});

test('Save again that starts no save keeps the text offered', async () => {
	clipboard('takes');
	const { opened } = mountApp(createTestStorage());
	const context = await opened;
	cleanup.push(() => context.close());
	let asked = 0;

	context.writeFailed({
		path: 'notes/c.md',
		error: deleted,
		unsaved: 'Typed body',
		retry: () => {
			asked++;
			return false;
		},
	});
	await until(() => toastFor('notes/c.md'), 'the toast');
	click(document.body, 'Save again');
	expect(asked).toBe(1);
	expect(await stillUp('notes/c.md')).toBe(true);
	expect(document.body.textContent).toContain('Copy your text');
	// Nothing to save again any more: only the text is offered.
	expect(document.body.textContent).not.toContain('Save again');
});

test('Save again that starts a save closes the toast', async () => {
	const { opened } = mountApp(createTestStorage());
	const context = await opened;
	cleanup.push(() => context.close());

	context.writeFailed({
		path: 'notes/d.md',
		error: deleted,
		unsaved: '',
		retry: () => true,
	});
	await until(() => toastFor('notes/d.md'), 'the toast');
	click(document.body, 'Save again');
	await gone('notes/d.md');
});

test('unmounting closes the folder once its writes land', async () => {
	const { opened, remove } = mountApp(createTestStorage());
	const context = await opened;
	const write = context.folder.tables.notes.create(
		{ fields: { title: 'Kept' }, body: '' },
		{ stem: 'kept' },
	);
	remove();
	// The write admitted before the page went away lands.
	expect((await write).error).toBeNull();
	let refusal: string | undefined;
	await until(() => {
		void context.folder.tables.notes
			.create({ fields: { title: 'Late' }, body: '' }, { stem: 'late' })
			.then(({ error }) => {
				refusal = error?.name;
			});
		return refusal === 'Closed';
	}, 'the folder to close');
	expect(refusal).toBe('Closed');
});

test('close fences the edit layer when it is called, and releases the folder once it settled', async () => {
	const { data: folder, error } = await openFolder({
		app: `so.epicenter.app-test-${count++}`,
		definition,
		browser: browserStorage(createTestStorage()),
	});
	if (error !== null) throw new Error(error.message);
	const context = createFolderContext(folder);
	const closing = context.close();
	expect(context.edits.fenced).toBe(true);
	expect(context.close()).toBe(closing);
	await closing;
	expect(folder.signal.aborted).toBe(true);
});
