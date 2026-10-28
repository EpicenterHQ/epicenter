/**
 * Honeycrisp Page DOM Tests
 *
 * Mounts the real page in jsdom over the repository engine running in this
 * process, with a scripted server that seeds files and delivers other
 * devices' changes (`repository.test-support.ts`). A second client of the
 * same engine stands in for another tab.
 *
 * Key behaviors:
 * - A new note's title and body persist across close and reopen, and every field stays
 * - A change from elsewhere updates the open note without replacing its controls
 * - A note that does not read as one is listed for repair and opens as its text
 * - A write the engine refuses is reported, and the controls follow the stored note
 * - Deleting a folder moves its notes out in the same batch
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { button, type } from '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { type Device, folderText, noteText, openDevice, until as poll } from '../lib/repository.test-support.js';

// SAFETY: jsdom has no layout; the empty list supplies only the geometry these tests need.
Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
// SAFETY: jsdom has no layout; this rectangle stands for an unmeasured range.
Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
const { flushSync, mount, unmount } = await import('svelte');
const { confirmationDialog } = await import('@epicenter/ui/confirmation-dialog');
const PageHost = (await import('../lib/page-host.test-support.svelte')).default;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanups.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

const NOTE = 'section[aria-label="Note"]';
const TITLE = `${NOTE} input[aria-label="Title"]`;
const SOURCE = `${NOTE} textarea[aria-label="Markdown source"]`;
const LIST = 'section[aria-label="Notes"]';

const until = (check: () => boolean, what: string) => poll(check, what, flushSync);

async function device(files: Record<string, string> = {}) {
	const opened = await openDevice(files);
	cleanups.push(() => opened.close());
	return opened;
}

async function openPage(on: Device) {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(PageHost, { target, props: { open: async () => Ok(on.tab()) } });
	let mounted = true;
	const close = async () => {
		if (!mounted) return;
		mounted = false;
		await unmount(component);
		target.remove();
	};
	cleanups.push(close);
	await until(() => target.querySelector(LIST) !== null, 'the notes list');
	const get = <T extends Element>(selector: string) => {
		const found = target.querySelector<T>(selector);
		if (!found) throw new Error(`Missing ${selector}`);
		return found;
	};
	const text = (selector: string) => target.querySelector(selector)?.textContent ?? '';
	return { target, get, text, close };
}

async function openNote(page: Awaited<ReturnType<typeof openPage>>, path: string) {
	await until(() => page.target.querySelector(`[data-note="${path}"]`) !== null, `${path} in the list`);
	page.get<HTMLButtonElement>(`[data-note="${path}"]`).click();
	await until(() => page.target.querySelector(TITLE) !== null, `${path} to open`);
}

test("a new note's title and body persist across close and reopen", async () => {
	const on = await device();
	const page = await openPage(on);
	page.get<HTMLButtonElement>('button[aria-label="New note"]').click();
	await until(() => page.target.querySelector(TITLE) !== null, 'the new note');
	type(page.get<HTMLInputElement>(TITLE), 'Groceries');
	await until(() => page.text(LIST).includes('Groceries'), 'the title in the list');
	button(page.target, 'Source').click();
	flushSync();
	type(page.get<HTMLTextAreaElement>(SOURCE), 'Milk\n');
	await until(() => page.text(LIST).includes('Milk'), 'the body in the list');
	expect(page.get('[data-testid="status-summary"]').getAttribute('aria-label')).toContain('On this device');
	await page.close();

	const [note] = await on.tab().notes.list();
	expect(note).toMatchObject({ valid: true, body: 'Milk\n', fields: { title: 'Groceries', pinned: false, folderId: null, deletedAt: null } });
	const reopened = await openPage(on);
	await until(() => reopened.text(LIST).includes('Groceries'), 'the reopened note');
	expect(reopened.text(LIST)).toContain('Milk');
});

test('a change from elsewhere updates the open note without replacing its controls', async () => {
	const on = await device({ 'notes/a.md': noteText({ title: 'Alpha' }) });
	const page = await openPage(on);
	await openNote(page, 'notes/a.md');
	const title = page.get<HTMLInputElement>(TITLE);
	expect(title.value).toBe('Alpha');
	await on.theirs('notes/a.md', noteText({ title: 'Beta' }));
	await until(() => page.get<HTMLInputElement>(TITLE).value === 'Beta', 'their title');
	expect(page.get(TITLE)).toBe(title);

	type(title, 'Gamma');
	flushSync();
	// A key Honeycrisp does not name stays as its writer left it.
	await until(() => on.text('notes/a.md')?.includes('title: Gamma') ?? false, 'the typed title');
	expect(on.text('notes/a.md')).toContain('owner:\n  name: one\n  tags: [two]\n');
});

test('a note that does not read as one is listed for repair and opens as its text', async () => {
	const on = await device({ 'notes/a.md': 'plain text\n', 'folders/f.md': 'not a folder\n' });
	const page = await openPage(on);
	await until(() => page.text(LIST).includes('Needs repair'), 'the repair listing');
	expect(page.text(LIST)).toContain('folders/f.md');
	page.get<HTMLButtonElement>('[data-note="notes/a.md"]').click();
	await until(() => page.target.querySelector('pre[aria-label="Text of a.md"]') !== null, 'the text view');
	expect(page.text('pre[aria-label="Text of a.md"]')).toBe('plain text\n');
	expect(page.target.querySelector('[data-testid="row-issues"]')).not.toBeNull();
	expect(on.text('notes/a.md')).toBe('plain text\n');
});

test('a write the engine refuses is reported, and the controls follow the stored note', async () => {
	const on = await device({ 'notes/a.md': noteText({ title: 'Disk' }) });
	const page = await openPage(on);
	await openNote(page, 'notes/a.md');
	on.refuseWrites(true);
	type(page.get<HTMLInputElement>(TITLE), 'Typed');
	await until(() => document.body.textContent?.includes('Could not save the title') ?? false, 'the title error');
	await until(() => page.get<HTMLInputElement>(TITLE).value === 'Disk', 'the stored title');
	expect(on.text('notes/a.md')).toBe(noteText({ title: 'Disk' }));
});

test('deleting a folder moves its notes out in the same batch', async () => {
	const on = await device({
		'folders/work.md': folderText('Work'),
		'notes/a.md': noteText({ title: 'In work', folderId: 'work' }),
	});
	const page = await openPage(on);
	await until(() => page.text('nav[aria-label="Folders"]').includes('Work'), 'the folder');
	page.get<HTMLButtonElement>('button[aria-label="Actions for Work"]').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
	await until(() => document.querySelector('[role="menuitem"]') !== null, 'the folder menu');
	const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent?.trim() === 'Delete…');
	if (!(item instanceof HTMLElement)) throw new Error('No Delete… item');
	item.click();
	await confirmationDialog.confirm();
	await until(() => on.text('folders/work.md') === null, 'the folder deleted');
	expect(on.text('notes/a.md')).toContain('folderId: null');
	const outbox = await on.repo.query<{ changes: string }>('SELECT changes FROM "epicenter/outbox"');
	expect(outbox).toHaveLength(1);
	expect(JSON.parse(outbox[0]?.changes ?? '[]')).toHaveLength(2);
});
