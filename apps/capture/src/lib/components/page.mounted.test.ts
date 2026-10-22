/**
 * Mounted Capture Page Tests
 *
 * The real Capture page, as the layout mounts it, in jsdom over an
 * in-memory IndexedDB. The page opens this browser's local folder through
 * `<FolderApp>`; a second handle
 * of the same profile reads what it saved.
 *
 * Key behaviors:
 * - An earlier OPFS folder does not block the current IndexedDB folder
 * - A fresh browser opens an empty timeline whose header offers no Save
 *   version, Sync, or Connect
 * - Text not added yet writes nothing and never holds a reload; a capture
 *   added here stays saved; later held edits are not submitted by close
 * - A draft an earlier version saved resumes, holds a reload while unsaved,
 *   and is removed by an explicit discard
 * - Close does not submit held Edit as text input
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { captureTables } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

type Navigation = { willUnload: boolean; cancel(): void };
/** The `beforeNavigate` hooks of the mounted page. */
const hooks = new Set<(navigation: Navigation) => void>();
const { onDestroy } = await import('svelte');
mock.module('$app/navigation', () => ({
	beforeNavigate(hook: (navigation: Navigation) => void) {
		hooks.add(hook);
		onDestroy(() => hooks.delete(hook));
	},
}));
/** A reload or a closed tab, as SvelteKit asks the hooks; answers whether it goes ahead. */
function reload() {
	let cancelled = false;
	for (const hook of hooks)
		hook({ willUnload: true, cancel: () => (cancelled = true) });
	return !cancelled;
}

const { flushSync, mount, unmount } = await import('svelte');
const { default: PageHost } = await import('./fixtures/PageHost.svelte');
const { default: PageLeavingHost } = await import(
	'./fixtures/PageLeavingHost.svelte'
);

setWide(true);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
	Reflect.deleteProperty(navigator, 'storage');
});

/** A fresh browser profile, with `opfs` as its origin private file system, if any. */
function freshProfile(opfs?: { getDirectory(): Promise<unknown> }) {
	globalThis.indexedDB = new IDBFactory();
	if (opfs !== undefined)
		Object.defineProperty(navigator, 'storage', {
			value: opfs,
			configurable: true,
		});
}

/** An OPFS root holding the directories `names`, recording each lookup's arguments. */
function opfsWith(...names: string[]) {
	const calls: unknown[][] = [];
	const directory = {
		async *values() {
			for (const name of names) yield { kind: 'directory', name };
		},
		async getDirectoryHandle(...args: unknown[]) {
			calls.push(args);
			if (names.includes(args[0] as string)) return directory;
			throw new DOMException('Not found', 'NotFoundError');
		},
	};
	return { getDirectory: async () => directory, calls };
}

/** Mount the page; `close` unmounts it, which closes its folder. */
function mountPage(host: typeof PageHost | typeof PageLeavingHost = PageHost) {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(host, { target });
	let mounted = true;
	const close = async () => {
		if (!mounted) return;
		mounted = false;
		await unmount(view);
		target.remove();
	};
	cleanup.push(close);
	return { target, close, text: () => target.textContent ?? '' };
}

async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

test('an earlier OPFS folder does not block the current timeline', async () => {
	const opfs = opfsWith('so.epicenter.capture');
	freshProfile(opfs);
	const page = mountPage();
	await until(() => page.text().includes('No captures yet'), 'the timeline');
	expect(opfs.calls).toEqual([]);
});

test('a fresh browser opens an empty timeline with no Save version, Sync, or Connect', async () => {
	freshProfile();
	const page = mountPage();
	await until(() => page.text().includes('No captures yet'), 'the timeline');
	const labels = [...page.target.querySelectorAll('button')].map((button) =>
		button.textContent?.trim(),
	);
	expect(labels).not.toContain('Save version');
	expect(labels.some((label) => /^(Sync|Connect)/.test(label ?? ''))).toBe(
		false,
	);
	expect(page.target.querySelector('[aria-label="Saving"]')?.textContent).toBe(
		'Saved',
	);
});

test('unsubmitted text never writes; close preserves Add but drops later held edits', async () => {
	freshProfile();
	const page = mountPage();
	await until(() => page.text().includes('No captures yet'), 'the timeline');

	type(document.getElementById('new-capture'), 'Kept in this browser');
	expect(reload()).toBe(true);
	{
		// Another handle of the profile: nothing was written for the typing.
		const folder = expectOk(await openFolder({ tables: captureTables }));
		expect(expectOk(await folder.tables.captures.list())).toEqual([]);
		folder.close();
	}

	flushSync();
	click(document, 'Add capture');
	await until(
		() => document.getElementById('new-thought') !== null,
		'the new capture to open',
	);
	type(document.getElementById('new-thought'), 'not added yet');
	expect(reload()).toBe(true);
	type(document.getElementById('capture-text'), 'Kept in this browser, edited');
	expect(reload()).toBe(false);
	await page.close();

	// Close leaves the last saved capture unchanged.
	const folder = expectOk(await openFolder({ tables: captureTables }));
	cleanup.push(() => folder.close());
	const listed = async () => expectOk(await folder.tables.captures.list());

	const rows = await listed();
	expect(rows).toHaveLength(1);
	expect(rows[0]?.issues).toBeNull();
	expect(rows[0]?.body).toBe('\nKept in this browser\n\n## Thoughts\n');
});

test('close does not submit held Edit as text input', async () => {
	freshProfile();
	const file = '---\ncapturedAt: 2026-10-04T20:49:23Z\n---\n\nBefore\n';
	{
		const folder = expectOk(await openFolder({ tables: captureTables }));
		expectOk(await folder.files.write('captures/one.md', file));
		folder.close();
	}
	const page = mountPage();
	await until(() => page.text().includes('Before'), 'the timeline');
	page.target
		.querySelector<HTMLButtonElement>('[aria-label="Timeline captures"] button')
		?.click();
	await until(() => page.text().includes('Edit as text'), 'the capture');
	click(page.target, 'Edit as text');
	const contents = 'textarea[aria-label^="Contents of"]';
	await until(() => page.target.querySelector(contents) !== null, 'the text');
	type(page.target.querySelector(contents), file.replace('Before', 'After'));
	expect(reload()).toBe(false);
	await page.close();

	const folder = expectOk(await openFolder({ tables: captureTables }));
	cleanup.push(() => folder.close());
	const read = async () =>
		(await expectOk(
			await folder.files.read('captures/one.md'),
		)?.content.text()) ?? '';

	expect(await read()).toBe(file);
});

test('a failed text save stays visible while mounted and close does not retry it', async () => {
	freshProfile();
	const path = 'captures/one.md';
	const file = '---\ncapturedAt: 2026-10-04T20:49:23Z\n---\n\nBefore\n';
	const draft = file.replace('Before', 'Typed but not saved');
	{
		const folder = expectOk(await openFolder({ tables: captureTables }));
		expectOk(await folder.files.write(path, file));
		folder.close();
	}
	const page = mountPage(PageLeavingHost);
	await until(() => page.text().includes('Before'), 'the timeline');
	page.target
		.querySelector<HTMLButtonElement>('[aria-label="Timeline captures"] button')
		?.click();
	await until(() => page.text().includes('Edit as text'), 'the capture');
	click(page.target, 'Edit as text');
	const contents = 'textarea[aria-label^="Contents of"]';
	await until(() => page.target.querySelector(contents) !== null, 'the text');
	type(page.target.querySelector(contents), draft);

	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	cleanup.push(() => {
		IDBObjectStore.prototype.put = put;
	});
	page.target.querySelector(contents)?.dispatchEvent(new FocusEvent('blur'));
	await until(() => page.text().includes('Not saved'), 'the save failure');
	expect(page.target.querySelector<HTMLTextAreaElement>(contents)?.value).toBe(draft);
	click(page.target, 'Leave page');
	await until(() => page.target.querySelector(contents) === null, 'page unmount');
	expect(document.querySelector('[data-testid="unsaved-text"]')).toBeNull();
	const folder = expectOk(await openFolder({ tables: captureTables }));
	try {
		expect(await expectOk(await folder.files.read(path))?.content.text()).toBe(file);
	} finally {
		folder.close();
	}

});

test('a draft an earlier version saved resumes from Drafts, saves across a restart, and explicit discard removes it', async () => {
	freshProfile();
	const raw = '## Thoughts\n\n- belongs to my paste\n\n```ts';
	{
		const folder = expectOk(await openFolder({ tables: captureTables }));
		expectOk(
			await folder.files.write(
				'captures/draft.md',
				`---\ncapturedAt: 2026-10-04T20:49:23Z\ndraft: true\n---\n`,
			),
		);
		folder.close();
	}
	const page = mountPage();
	await until(
		() =>
			page.target.querySelector('[aria-label="Draft captures"] button') !==
			null,
		'the draft',
	);
	page.target
		.querySelector<HTMLButtonElement>('[aria-label="Draft captures"] button')
		?.click();
	await until(
		() =>
			document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label^="Contents of"]',
			) !== null,
		'the draft view',
	);
	const draft = `---\ncapturedAt: 2026-10-04T20:49:23Z\ndraft: true\n---\n${raw}`;
	type(
		document.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label^="Contents of"]',
		),
		draft,
	);
	expect(reload()).toBe(false);
	document
		.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Contents of"]')
		?.dispatchEvent(new FocusEvent('blur'));
	await until(
		() =>
			page.target.querySelector('[aria-label="Saving"]')?.textContent ===
			'Saved',
		'the saved draft',
	);
	expect(reload()).toBe(true);
	await page.close();
	// The same profile, a new mounted page and Folder handle.
	const resumed = mountPage();
	await until(
		() =>
			resumed.target.querySelector('[aria-label="Draft captures"] button') !==
			null,
		'the recovered draft',
	);
	resumed.target
		.querySelector<HTMLButtonElement>('[aria-label="Draft captures"] button')
		?.click();
	await until(
		() =>
			document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label^="Contents of"]',
			) !== null,
		'the resumed draft',
	);
	expect(
		(
			document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label^="Contents of"]',
			) as HTMLTextAreaElement
		).value,
	).toBe(draft);
	click(document, 'Discard draft…');
	await until(
		() => document.body.textContent?.includes('Discard this draft?') ?? false,
		'discard confirmation',
	);
	click(document, 'Discard draft');
	await until(
		() => resumed.text().includes('No captures yet'),
		'the empty timeline',
	);
	await resumed.close();
	const again = mountPage();
	await until(
		() => again.text().includes('No captures yet'),
		'the empty timeline after restart',
	);
	expect(
		again.target.querySelector('[aria-label="Draft captures"]'),
	).toBeNull();
});
