/**
 * Files DOM Tests
 *
 * Mounts Files' bundle in jsdom through its `mount`, as the shell does, over
 * the repository API on a replica in this process. The test plays the
 * shell: `navigate` moves the path and calls `setPath`, as the URL would.
 *
 * Key behaviors:
 * - The path names the folder shown; folders and files are listed, whichever app wrote them
 * - A Markdown file opens its exact text in the source editor, and typing saves it
 * - A new file is made in the folder shown, and opens
 * - Rename is a delete and a write, carrying what was typed; Delete asks first and returns to the folder
 * - Any other file shows its text, and a path with no file says so
 */
import '../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type { Mounted } from '@epicenter/app';
import { openBunSqlite } from '@epicenter/repository/bun';
import { openReplica } from '@epicenter/repository/client';
import { unwrap } from 'wellcrafted/result';
import { createLocalHost } from '../../../packages/repository/src/api/local.js';
import { openRepository } from '../../../packages/repository/src/api/repository.js';
import { editorText, type, typeInEditor } from '../../../packages/svelte/src/svelte-dom.test-support.js';
import { manifest } from './manifest.js';

const { flushSync } = await import('svelte');
const { confirmationDialog } = await import('@epicenter/ui/confirmation-dialog');
const { mount } = await import('./bundle.js');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanups.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		try {
			if (check()) return;
		} catch {}
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** Files mounted at `path` over a replica that starts with `files`. */
async function openFiles(files: Record<string, string>, path = '/') {
	const replica = unwrap(openReplica({ driver: openBunSqlite(), binding: { repository: 'r', server: null, account: null }, device: 'this-device', app: manifest.collections, after: () => {}, now: () => 0 }));
	for (const [at, text] of Object.entries(files)) replica.write(at, text);
	const repo = openRepository({ app: manifest.collections, host: createLocalHost({ replica, app: manifest.collections }).host });
	const target = document.createElement('div');
	document.body.append(target);
	const at = { path };
	let mounted: Mounted | undefined;
	mounted = mount(target, {
		repo,
		path,
		navigate: async (next) => {
			at.path = next;
			mounted?.setPath?.(next);
		},
	});
	cleanups.push(async () => {
		await mounted?.unmount();
		repo.close();
		target.remove();
	});
	const query = <T extends Element = HTMLElement>(selector: string) => target.querySelector<T>(selector) ?? document.querySelector<T>(selector);
	const get = <T extends Element = HTMLElement>(selector: string) => {
		const found = query<T>(selector);
		if (found === null) throw new Error(`Missing ${selector}`);
		return found;
	};
	const press = (selector: string) => get(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }));
	const pressText = (text: string) => {
		const found = [...target.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
		if (found === undefined) throw new Error(`No button reads ${text}`);
		found.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	};
	const submit = (selector: string) => get<HTMLFormElement>(selector).requestSubmit();
	return { target, at, replica, query, get, press, pressText, submit };
}

const FILE = '[aria-label="File"]';

test('the path names the folder shown; folders and files are listed, whichever app wrote them', async () => {
	const files = await openFiles({ 'README.md': '# Home\n', 'todos/milk.md': '---\ntitle: Milk\ndone: false\n---\n', 'notes/a.md': 'A\n' });
	await until(() => files.query('[data-file="README.md"]') !== null, 'the root');
	expect(files.query('[data-folder="todos"]')).not.toBeNull();
	expect(files.query('[data-folder="notes"]')).not.toBeNull();
	files.press('[data-folder="todos"]');
	await until(() => files.query('[data-file="todos/milk.md"]') !== null, 'the todos folder');
	expect(files.at.path).toBe('/todos/');
	expect(files.query('[data-file="README.md"]')).toBeNull();
	files.pressText('Root');
	await until(() => files.query('[data-file="README.md"]') !== null, 'the root again');
});

test('a Markdown file opens its exact text in the source editor, and typing saves it', async () => {
	const files = await openFiles({ 'notes/a.md': '---\nkeep: me\n---\nA\n' }, '/notes/a.md');
	await until(() => files.query('[aria-label="Text of a.md"]') !== null, 'the editor');
	expect(editorText(files.get('[aria-label="Text of a.md"]'))).toBe('---\nkeep: me\n---\nA\n');
	typeInEditor(files.get('[aria-label="Text of a.md"]'), '---\nkeep: me\n---\nA, then B\n');
	await until(() => files.replica.read('notes/a.md') === '---\nkeep: me\n---\nA, then B\n', 'the typing saved');
});

test('a new file is made in the folder shown, and opens', async () => {
	const files = await openFiles({ 'notes/a.md': 'A\n' }, '/notes/');
	await until(() => files.query('[data-file="notes/a.md"]') !== null, 'the folder');
	type(files.get('form[aria-label="New file"] input'), 'plan.md');
	files.submit('form[aria-label="New file"]');
	await until(() => files.at.path === '/notes/plan.md', 'the new file to open');
	expect(files.replica.read('notes/plan.md')).toBe('');
	await until(() => files.query('[aria-label="Text of plan.md"]') !== null, 'its editor');

	type(files.get('form[aria-label="New file"] input'), 'a.md');
	files.submit('form[aria-label="New file"]');
	await until(() => files.query('form[aria-label="New file"] [role="alert"]')?.textContent === 'A file is already at notes/a.md.', 'the refusal');
});

test('rename is a delete and a write, carrying what was typed; delete asks first and returns to the folder', async () => {
	const files = await openFiles({ 'notes/a.md': 'A\n', 'notes/b.md': 'B\n' }, '/notes/a.md');
	await until(() => files.query('[aria-label="Text of a.md"]') !== null, 'the editor');
	typeInEditor(files.get('[aria-label="Text of a.md"]'), 'A, typed\n');
	files.pressText('Rename');
	await until(() => files.query('form[aria-label="Rename"]') !== null, 'the rename form');
	type(files.get('form[aria-label="Rename"] input'), 'notes/b.md');
	files.submit('form[aria-label="Rename"]');
	await until(() => files.query(`${FILE} [role="alert"]`)?.textContent === 'A file is already at notes/b.md.', 'the refusal');
	type(files.get('form[aria-label="Rename"] input'), 'archive/a.md');
	files.submit('form[aria-label="Rename"]');
	await until(() => files.at.path === '/archive/a.md', 'the renamed file');
	expect(files.replica.read('notes/a.md')).toBeNull();
	expect(files.replica.read('archive/a.md')).toBe('A, typed\n');

	await until(() => files.query('[aria-label="Text of a.md"]') !== null, 'the renamed file’s editor');
	files.pressText('Delete');
	await confirmationDialog.confirm();
	await until(() => files.at.path === '/archive/', 'its folder');
	expect(files.replica.read('archive/a.md')).toBeNull();
});

test('any other file shows its text, and a path with no file says so', async () => {
	const files = await openFiles({ 'data/list.txt': 'one\ntwo\n' }, '/data/list.txt');
	await until(() => files.query('[aria-label="Text of list.txt"]')?.textContent === 'one\ntwo\n', 'the text');
	const missing = await openFiles({}, '/data/gone.md');
	await until(() => missing.query(FILE)?.textContent?.includes('No file is at data/gone.md') ?? false, 'no file');
});
