/**
 * Page Tests
 *
 * Mounts the real Honeycrisp page in jsdom, as the layout mounts it, over an
 * in-memory IndexedDB: `<FolderApp>` opens
 * `openFolder({ tables: honeycrispTables })` and `HoneycrispApp` renders inside
 * it. A second handle of the same profile stands in for another tab and
 * reads what was stored.
 *
 * Key behaviors:
 * - A new note, its title, and its text persist across close and reopen;
 *   closing sends typing still waiting for its pause
 * - Leaving the page is held back while typing is not saved
 * - A note that does not read as one is listed for repair, repaired as its
 *   file, and opens as a note
 * - The header says where notes are kept and offers no Save version, Sync,
 *   or Connect
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import 'fake-indexeddb/auto';
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	blur,
	button,
	type,
} from '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { honeycrispTables } from '../lib/data.js';

// jsdom has no layout; ProseMirror measures the cursor and gets no boxes.
Range.prototype.getClientRects ??= () =>
	[] as unknown as ReturnType<Range['getClientRects']>;
Range.prototype.getBoundingClientRect ??= () =>
	({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

/** `$app/navigation` outside SvelteKit: the page's leave guards, asked by `leave()`. */
const guards = new Set<(navigation: { cancel(): void }) => void>();
mock.module('$app/navigation', () => ({
	beforeNavigate(guard: (navigation: { cancel(): void }) => void) {
		guards.add(guard);
	},
}));
/** The browser leaves the page, as on a reload; answers whether a guard held it back. */
function leave() {
	let held = false;
	for (const guard of guards) guard({ cancel: () => (held = true) });
	return held;
}

const { flushSync, mount, unmount } = await import('svelte');
const { default: PageHost } = await import(
	'../lib/page-host.test-support.svelte'
);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
	guards.clear();
});

const NOTE = 'section[aria-label="Note"]';
const TITLE = `${NOTE} input[aria-label="Title"]`;
const SOURCE = `${NOTE} textarea[aria-label="Markdown source"]`;
const LIST = 'section[aria-label="Notes"]';

/** Another tab of this profile; closed when the test ends. */
async function otherTab() {
	const folder = expectOk(await openFolder({ tables: honeycrispTables }));
	cleanup.push(() => folder.close());
	return folder;
}

/** The file's text as another tab reads it. */
async function stored(path: string) {
	const read = expectOk(await (await otherTab()).files.read(path));
	return read && (await read.content.text());
}

/** Wait until `check` holds, letting saves, reads, and effects run. */
async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 600; tries++) {
		flushSync();
		try {
			if (check()) return;
		} catch {
			// Not rendered yet.
		}
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** Mount the page and wait until it lists the notes; `close` unmounts it, which closes its folder. */
async function openPage() {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target });
	let mounted = true;
	const close = () => {
		if (!mounted) return;
		mounted = false;
		void unmount(view);
		target.remove();
		guards.clear();
	};
	cleanup.push(close);
	const get = <T extends Element = HTMLInputElement>(selector: string): T => {
		const element = target.querySelector(selector);
		if (element === null) throw new Error(`Nothing matches '${selector}'`);
		return element as unknown as T;
	};
	const text = (selector: string) =>
		target.querySelector(selector)?.textContent ?? '';
	await until(() => target.querySelector(LIST) !== null, 'the note list');
	return { target, close, get, text };
}

test('a new note, its title, and its text persist across close and reopen', async () => {
	globalThis.indexedDB = new IDBFactory();
	const first = await openPage();
	expect(first.text(LIST)).toContain('No notes here yet');
	expect(
		first.get('[data-testid="status-summary"]').getAttribute('aria-label'),
	).toContain('Saved on this device');
	for (const absent of ['Save version', 'Sync', 'Connect'])
		expect(() => button(first.target, absent)).toThrow();

	first
		.get('button[aria-label="New note"]')
		.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await until(() => first.target.querySelector(TITLE) !== null, 'the new note');

	type(first.get(TITLE), 'Groceries');
	flushSync();
	// Typed and not yet saved: a reload is held back.
	expect(leave()).toBe(true);
	blur(first.get(TITLE));
	await until(
		() => /Saved to/.test(first.text('[data-testid="write-status"]')),
		'the title',
	);
	expect(leave()).toBe(false);
	await until(() => first.text(LIST).includes('Groceries'), 'the list');

	// Typed and closed before its pause: closing saves it.
	button(first.target, 'Source').dispatchEvent(
		new MouseEvent('click', { bubbles: true }),
	);
	flushSync();
	type(first.get<HTMLTextAreaElement>(SOURCE), 'Milk\n');
	first.close();
	const tab = await otherTab();
	for (let tries = 0; ; tries++) {
		const [note] = expectOk(await tab.tables.notes.list());
		if (note?.body === 'Milk\n') break;
		if (tries > 400) throw new Error('The text was not stored on close');
		await Bun.sleep(5);
	}

	const second = await openPage();
	await until(
		() => second.text(LIST).includes('Groceries'),
		'the note after reopening',
	);
	expect(second.text(LIST)).toContain('Milk');
});

test('a note that does not read as one is repaired as its file and opens as a note', async () => {
	globalThis.indexedDB = new IDBFactory();
	const tab = await otherTab();
	const broken =
		'---\ntitle: Broken\nfolderId: null\npinned: maybe\ncreatedAt: "2026-10-01T00:00:00.000Z"\ndeletedAt: null\n---\nText\n';
	expectOk(await tab.files.write('notes/broken.md', null, broken));
	const page = await openPage();
	await until(
		() => page.text(LIST).includes('Needs repair'),
		'the repair list',
	);

	page
		.get('[data-note="notes/broken.md"]')
		.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	const contents = 'textarea[aria-label="Contents of broken.md"]';
	await until(() => page.target.querySelector(contents) !== null, 'the file');
	expect(page.text('[data-testid="row-issues"]')).toContain('Needs repair');

	type(
		page.get<HTMLTextAreaElement>(contents),
		broken.replace('maybe', 'false'),
	);
	blur(page.get(contents));
	await until(
		() => page.target.querySelector('[data-testid="row-issues"]') === null,
		'the repair',
	);
	expect(await stored('notes/broken.md')).toBe(
		broken.replace('maybe', 'false'),
	);

	button(page.target, 'Open as note').dispatchEvent(
		new MouseEvent('click', { bubbles: true }),
	);
	await until(() => page.get(TITLE).value === 'Broken', 'the note');
	expect(page.text(LIST)).not.toContain('Needs repair');
});

test('failed whole-file input survives Open as note and another tab deleting the file', async () => {
	globalThis.indexedDB = new IDBFactory();
	const tab = await otherTab();
	const source =
		'---\ntitle: Alpha\nfolderId: null\npinned: false\ncreatedAt: "2026-10-01T00:00:00.000Z"\ndeletedAt: null\n---\nBody\n';
	expectOk(await tab.files.write('notes/a.md', null, source));
	const page = await openPage();
	page
		.get('[data-note="notes/a.md"]')
		.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await until(() => page.target.querySelector(TITLE) !== null, 'the note');
	button(page.target, 'Edit as file').click();
	const selector = 'textarea[aria-label="Contents of a.md"]';
	await until(() => page.target.querySelector(selector) !== null, 'the file');
	const put = IDBObjectStore.prototype.put;
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Full', 'QuotaExceededError');
	};
	const changed = source.replace('Body', 'Keep this text');
	type(page.get<HTMLTextAreaElement>(selector), changed);
	blur(page.get(selector));
	await until(
		() => page.text('[data-testid="write-status"]').includes('Not saved'),
		'the failed save',
	);
	button(page.target, 'Open as note').click();
	await until(
		() => page.text('[data-testid="write-status"]').includes('Not saved'),
		'the refused mode switch',
	);
	expect(page.target.querySelector(TITLE)).toBeNull();
	expect(page.get<HTMLTextAreaElement>(selector).value).toBe(changed);
	IDBObjectStore.prototype.put = put;
	expect(expectOk(await tab.files.delete('notes/a.md', source)).deleted).toBe(
		true,
	);
	await until(
		() => !page.text(LIST).includes('Alpha'),
		'the external deletion',
	);
	expect(page.get<HTMLTextAreaElement>(selector).value).toBe(changed);
	button(page.target, 'Discard changes').click();
	await until(
		() => page.target.querySelector(selector) === null,
		'discarding the failed text',
	);
});
