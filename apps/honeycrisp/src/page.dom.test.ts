/**
 * Honeycrisp Page DOM Tests
 *
 * Mounts the real page in jsdom over the repository API on a replica in
 * this process, seeded with files (`repository.test-support.ts`). A change
 * another program makes on this device, or a second repository over the same
 * replica, stands in for a change made elsewhere.
 *
 * Key behaviors:
 * - A new note's title and body persist across close and reopen, and every field stays
 * - A new note takes typing at once: its editor opens once the create is stored
 * - A change from elsewhere updates the open note without replacing its controls
 * - A note that does not read as one is listed for repair and opens straight into its source
 * - A write the replica refuses is reported, and the controls follow the stored note
 * - Deleting a folder moves its notes out in the same transaction
 */
import '../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { button, type } from '../../../packages/svelte/src/svelte-dom.test-support.js';
import { type Device, folderText, noteText, openDevice, until as poll } from './repository.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { confirmationDialog } = await import('@epicenter/ui/confirmation-dialog');
const PageHost = (await import('./page-host.test-support.svelte')).default;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanups.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

const NOTE = 'section[aria-label="Note"]';
const TITLE = `${NOTE} input[aria-label="Title"]`;
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
	const component = mount(PageHost, { target, props: { repository: on.open() } });
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
	await until(() => page.target.querySelector(`${NOTE} .cm-editor`) !== null, 'the editor, once the create is stored');
	const editor = EditorView.findFromDOM(page.get<HTMLElement>(`${NOTE} .cm-editor`));
	if (editor === null) throw new Error('No editor');
	editor.dispatch(editor.state.replaceSelection('Milk\n'), { userEvent: 'input.type' });
	await until(() => page.text(LIST).includes('Milk'), 'the body in the list');
	expect(page.get('[data-testid="status-summary"]').getAttribute('aria-label')).toContain('On this device');
	await page.close();

	const tab = on.tab();
	await until(() => tab.status().status === 'open', 'another tab');
	const [note] = tab.notes.all();
	expect(note).toMatchObject({ valid: true, body: 'Milk\n', fields: { title: 'Groceries', pinned: false, folderId: null, deletedAt: null } });
	const reopened = await openPage(on);
	await until(() => reopened.text(LIST).includes('Groceries'), 'the reopened note');
	expect(reopened.text(LIST)).toContain('Milk');
});

test('a new note takes typing at once, and keeps it once its create is stored', async () => {
	const on = await device();
	const page = await openPage(on);
	page.get<HTMLButtonElement>('button[aria-label="New note"]').click();
	await until(() => page.target.querySelector(`${NOTE} .cm-editor`) !== null, 'the new note’s editor');
	const editor = EditorView.findFromDOM(page.get<HTMLElement>(`${NOTE} .cm-editor`));
	if (editor === null) throw new Error('No editor');
	editor.dispatch(editor.state.replaceSelection('First line'), { userEvent: 'input.type' });
	const path = page.get('[data-note]').getAttribute('data-note') ?? '';
	await until(() => on.text(path)?.endsWith('---\nFirst line') ?? false, 'the typing stored');
	expect(page.text(LIST)).toContain('First line');
});

test('a change from elsewhere updates the open note without replacing its controls', async () => {
	const on = await device({ 'notes/a.md': noteText({ title: 'Alpha' }) });
	const page = await openPage(on);
	await openNote(page, 'notes/a.md');
	const title = page.get<HTMLInputElement>(TITLE);
	expect(title.value).toBe('Alpha');
	on.theirs('notes/a.md', noteText({ title: 'Beta' }));
	await until(() => page.get<HTMLInputElement>(TITLE).value === 'Beta', 'their title');
	expect(page.get(TITLE)).toBe(title);

	type(title, 'Gamma');
	flushSync();
	// A key Honeycrisp does not name stays as its writer left it.
	await until(() => on.text('notes/a.md')?.includes('title: Gamma') ?? false, 'the typed title');
	expect(on.text('notes/a.md')).toContain('owner:\n  name: one\n  tags: [two]\n');
});

test('a note that does not read as one is listed for repair and opens straight into its source', async () => {
	const on = await device({ 'notes/a.md': 'plain text\n', 'folders/f.md': 'not a folder\n' });
	const page = await openPage(on);
	await until(() => page.text(LIST).includes('Needs repair'), 'the repair listing');
	expect(page.text(LIST)).toContain('folders/f.md');
	page.get<HTMLButtonElement>('[data-note="notes/a.md"]').click();
	const SOURCE = '[aria-label="Source of a.md"]';
	await until(() => page.target.querySelector(SOURCE) !== null, 'the source editor');
	expect(page.text(SOURCE)).toBe('plain text');
	await until(() => page.text('[data-testid="editor-status"]').includes("Doesn't match the schema"), 'the schema status');
	expect(on.text('notes/a.md')).toBe('plain text\n');
});

test('a write the replica refuses is reported, and the controls follow the stored note', async () => {
	const on = await device({ 'notes/a.md': noteText({ title: 'Disk' }) });
	const page = await openPage(on);
	await openNote(page, 'notes/a.md');
	on.refuseWrites(true);
	type(page.get<HTMLInputElement>(TITLE), 'Typed');
	await until(() => document.body.textContent?.includes('Could not save the title') ?? false, 'the title error');
	await until(() => page.get<HTMLInputElement>(TITLE).value === 'Disk', 'the stored title');
	expect(on.text('notes/a.md')).toBe(noteText({ title: 'Disk' }));
});

test('deleting a folder moves its notes out in the same transaction', async () => {
	const on = await device({
		'folders/work.md': folderText('Work'),
		'notes/a.md': noteText({ title: 'In work', folderId: 'work' }),
	});
	const page = await openPage(on);
	const tab = on.tab();
	await until(() => tab.status().status === 'open', 'another tab');
	const before = tab.revision();
	await until(() => page.text('nav[aria-label="Folders"]').includes('Work'), 'the folder');
	page.get<HTMLButtonElement>('button[aria-label="Actions for Work"]').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
	await until(() => document.querySelector('[role="menuitem"]') !== null, 'the folder menu');
	const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent?.trim() === 'Delete…');
	if (!(item instanceof HTMLElement)) throw new Error('No Delete… item');
	item.click();
	await confirmationDialog.confirm();
	await until(() => on.text('folders/work.md') === null, 'the folder deleted');
	expect(on.text('notes/a.md')).toContain('folderId: null');
	// Both changes in one transaction: one revision.
	await until(() => tab.revision() > before, 'the change heard');
	expect(tab.revision()).toBe(before + 1);
});

test('a body save that fails says so in the note view, with Try again, and keeps the typing', async () => {
	const on = await device({ 'notes/a.md': noteText({ title: 'Disk', body: 'one\n' }) });
	const page = await openPage(on);
	await openNote(page, 'notes/a.md');
	await until(() => page.target.querySelector(`${NOTE} .cm-editor`) !== null, 'the editor');
	const editor = EditorView.findFromDOM(page.get<HTMLElement>(`${NOTE} .cm-editor`));
	if (editor === null) throw new Error('No editor');
	on.refuseWrites(true);
	editor.dispatch({ changes: { from: 3, insert: '!' }, userEvent: 'input.type' });
	await until(() => page.text(`${NOTE} [data-testid="editor-status"]`).includes('Not saved'), 'the failed save');
	on.refuseWrites(false);
	button(page.get(NOTE), 'Try again').click();
	await until(() => on.text('notes/a.md') === noteText({ title: 'Disk', body: 'one!\n' }), 'the typing saved');
	await until(() => page.text(`${NOTE} [data-testid="editor-status"]`).includes('Saved'), 'the saved status');
});
