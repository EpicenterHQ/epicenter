/**
 * Mounted Capture Detail Tests
 *
 * The real capture and text editors over stand-in clients: typed text
 * shown until it saves, thought commands over one body edit, inline save
 * recovery, Edit as text saved with `replace`, and deletion.
 *
 * Key behaviors:
 * - Capture text and thoughts compose over one body edit; typing stays
 *   visible until its save answers, and another writer's change shows when
 *   nothing is typed
 * - A failed body save keeps what was typed, with Save again and Discard
 * - Edit as text shows the note in house style, checks it as it is typed,
 *   saves it whole with Save (refused, with why, when it does not fit), and
 *   opens it as a capture once it reads as one
 * - A text draft survives a refused save, a change elsewhere and a delete
 *   elsewhere, each with what can be done
 * - A thought's Edit as text selects its lines, after pending typing lands
 * - Thought moves and deletes refuse a list that changed beneath them
 * - Deleting a capture asks first, saying its Git history keeps it
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	button,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openCaptures, until } = await import(
	'../capture-device.test-support.js'
);
const { locateThought } = await import('../capture-actions.svelte.ts');
const { captureText } = await import('../captures.svelte.ts');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');
setWide(true);
const AT = '2026-10-04T20:49:23.041Z';
const PATH = 'captures/one.md';
/** A capture as Capture writes it: house style. */
const FILE = `---\ncapturedAt: "${AT}"\n---\n\nText\n\n## Thoughts\n\n- first\n`;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
	document.body.replaceChildren();
});
const field = (id: string) => {
	const element = document.getElementById(id);
	return element instanceof HTMLTextAreaElement ? element : null;
};
function submit(form: Element | null | undefined) {
	if (!(form instanceof HTMLFormElement)) throw new Error('Expected a form');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
async function setup(files: Record<string, string>, mode: 'capture' | 'text') {
	const h = await openCaptures(files);
	h.captures.open('one', mode);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const host = mount(ViewHost, { target, props: { captures: h.captures } });
	cleanup.push(async () => {
		await unmount(host);
		await h.close();
	});
	flushSync();
	return { ...h, target };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const textFile = () =>
	document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
const shows = (h: Harness, text: string) =>
	h.target.textContent?.includes(text) === true;
/** Wait until the file at PATH holds what `check` wants. */
const saved = (h: Harness, check: (text: string | null) => boolean) =>
	until(async () => check(await h.text(PATH)));
async function menu(index: number, action: string) {
	const trigger = document.querySelectorAll<HTMLButtonElement>(
		'[data-thought-actions]',
	)[index];
	if (!trigger) throw new Error('No thought menu');
	trigger.click();
	await until(() => !!document.querySelector('[role="menuitem"]'));
	const item = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((candidate) => candidate.textContent?.trim() === action);
	if (!item) throw new Error(`No ${action} action`);
	item.click();
	flushSync();
}

test('typing capture text then adding a thought keeps both edits', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	expect(field('capture-text')?.value).toBe('Text');
	type(field('capture-text'), 'Edited');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	await saved(
		h,
		(text) => !!text?.includes('Edited') && !!text.includes('- second'),
	);
	expect(field('new-thought')?.value).toBe('');
});

test('a thought added behind a held write keeps text typed just before it', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	const release = h.holdWrites();
	type(field('capture-text'), 'Typed just now');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	flushSync();
	expect(field('capture-text')?.value).toBe('Typed just now');
	release();
	await saved(
		h,
		(text) => !!text?.includes('Typed just now') && !!text.includes('- second'),
	);
});

test('a failed thought save keeps the thought visible and Save again saves the body', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	const restore = h.failWrites();
	type(field('new-thought'), 'keep this');
	submit(field('new-thought')?.form);
	await until(() => shows(h, 'Not saved:'));
	expect(field('new-thought')?.value).toBe('');
	expect(h.target.textContent).toContain('keep this');
	expect(await h.text(PATH)).toBe(FILE);
	restore();
	button(h.target, 'Save again').click();
	await saved(h, (text) => !!text?.includes('- keep this'));
	await until(() => !shows(h, 'Not saved:'));
});

test('Discard follows the saved body after a failed thought save', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	h.failWrites();
	type(field('new-thought'), 'discard me');
	submit(field('new-thought')?.form);
	await until(() => shows(h, 'Not saved:'));
	button(h.target, 'Discard').click();
	flushSync();
	expect(h.target.textContent).not.toContain('discard me');
	expect(h.target.textContent).not.toContain('Not saved:');
	expect(await h.text(PATH)).toBe(FILE);
});

test('a blank thought is refused and its input stays', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), '  \n');
	submit(field('new-thought')?.form);
	flushSync();
	expect(field('new-thought')?.value).toBe('  \n');
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('Write something first.');
	expect(await h.text(PATH)).toBe(FILE);
});

test('a thought typed but not added stays visible to copy when the body becomes ambiguous', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), 'copy this');
	await h.writeElsewhere(
		PATH,
		FILE.replace('## Thoughts', '## Thoughts\n\n## Thoughts'),
	);
	await until(
		() => !!document.querySelector('[aria-label="Thought not added"]'),
	);
	expect(
		document.querySelector<HTMLTextAreaElement>(
			'[aria-label="Thought not added"]',
		)?.value,
	).toBe('copy this');
	expect(button(h.target, 'Copy text')).toBeDefined();
});

test('a capture whose front matter breaks elsewhere offers its own text to repair', async () => {
	const broken = FILE.replace(`capturedAt: "${AT}"`, 'capturedAt: nope');
	const h = await setup({ [PATH]: FILE }, 'capture');
	await h.writeElsewhere(PATH, broken);
	await until(() => shows(h, 'This file does not read as a capture'));
	button(h.target, 'Edit as text').click();
	await until(() => textFile()?.value === broken);
	expect(h.target.textContent).toContain('Needs repair');
});

test('an outside change shows when nothing is typed, and typing stays visible until its save answers', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	await h.writeElsewhere(PATH, FILE.replace('Text', 'Elsewhere'));
	await until(() => field('capture-text')?.value === 'Elsewhere');
	const release = h.holdWrites();
	type(field('capture-text'), 'Mine');
	flushSync();
	expect(field('capture-text')?.value).toBe('Mine');
	release();
	await saved(h, (text) => !!text?.includes('Mine'));
	expect(field('capture-text')?.value).toBe('Mine');
});

test('Edit as text shows the note in house style and opens it again as a capture', async () => {
	const handWritten = `---\nzeta: 1\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- first\n`;
	const h = await setup({ [PATH]: handWritten }, 'capture');
	button(h.target, 'Edit as text').click();
	flushSync();
	expect(textFile()?.value).toBe(FILE.replace('---\n\n', 'zeta: 1\n---\n\n'));
	button(h.target, 'Open as capture').click();
	flushSync();
	expect(h.captures.opened?.mode).toBe('capture');
	// Opening and reading wrote nothing.
	expect(await h.text(PATH)).toBe(handWritten);
});

test('Needs repair follows typing, and Save repairs the file and opens it as a capture', async () => {
	const h = await setup(
		{ [PATH]: '---\ncapturedAt: nope\n---\nBody\n' },
		'text',
	);
	await until(() => textFile() !== null);
	expect(h.target.textContent).toContain('Needs repair');
	expect(h.target.textContent).toContain('capturedAt');
	type(textFile(), `---\ncapturedAt: ${AT}\n---\nBody\n`);
	flushSync();
	expect(h.target.textContent).not.toContain('Needs repair');
	button(h.target, 'Save').click();
	await until(() => h.captures.opened?.mode === 'capture');
	expect(await h.text(PATH)).toBe(`---\ncapturedAt: "${AT}"\n---\nBody\n`);
});

test('Save refuses text that does not fit, says why, and keeps the text', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	const typed = FILE.replace(`capturedAt: "${AT}"`, 'capturedAt: soon');
	type(textFile(), typed);
	flushSync();
	button(h.target, 'Save').click();
	await until(
		() => h.target.querySelector('[aria-label="Not saved"]') !== null,
	);
	expect(
		h.target.querySelector('[aria-label="Not saved"]')?.textContent,
	).toContain('capturedAt');
	expect(textFile()?.value).toBe(typed);
	expect(await h.text(PATH)).toBe(FILE);
});

test('a failed text save keeps the text until Save again', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	const restore = h.failWrites();
	const typed = FILE.replace('Text', 'Keep this');
	type(textFile(), typed);
	flushSync();
	button(h.target, 'Save').click();
	await until(
		() => h.target.querySelector('[aria-label="Not saved"]') !== null,
	);
	expect(textFile()?.value).toBe(typed);
	restore();
	button(h.target, 'Save').click();
	await saved(h, (text) => text === typed);
	await until(() => h.captures.opened?.mode === 'capture');
});

test('a text save over a change made elsewhere is refused, keeps the text, and can use the saved text', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	const typed = FILE.replace('Text', 'Mine');
	type(textFile(), typed);
	// Another writer changes it, and the editor hears of it under the draft.
	const theirs = FILE.replace('Text', 'Theirs');
	await h.writeElsewhere(PATH, theirs);
	await until(
		() => h.list.get({ id: 'one' })?.body.includes('Theirs') === true,
	);
	button(h.target, 'Save').click();
	await until(() => shows(h, 'changed elsewhere'));
	expect(textFile()?.value).toBe(typed);
	button(h.target, 'Use the saved text').click();
	await until(() => textFile()?.value === theirs);
	expect(await h.text(PATH)).toBe(theirs);
});

test('a text draft survives a delete elsewhere, and its save says the file is gone', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	const typed = FILE.replace('Text', 'Typed');
	type(textFile(), typed);
	await h.deleteElsewhere(PATH);
	await until(() => h.list.get({ id: 'one' }) === undefined);
	button(h.target, 'Save').click();
	await until(() => shows(h, 'deleted elsewhere'));
	expect(textFile()?.value).toBe(typed);
	expect(await h.text(PATH)).toBeNull();
});

test('deleting from the text editor with a draft does not recreate the file', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	type(textFile(), FILE.replace('Text', 'Pending'));
	button(h.target, 'Delete…').click();
	await until(
		() => document.body.textContent?.includes('Delete this capture?') === true,
	);
	button(document, 'Delete').click();
	await until(() => h.captures.opened === undefined);
	expect(await h.text(PATH)).toBeNull();
});

test('deleting a capture asks first, saying its Git history keeps it', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	button(h.target, 'Delete…').click();
	await until(
		() =>
			document.body.textContent?.includes('Its Git history keeps them') ===
			true,
	);
	button(document, 'Cancel').click();
	flushSync();
	expect(await h.text(PATH)).toBe(FILE);
});

test('a failed delete keeps the file open and reports the failure', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	h.failWrites();
	button(h.target, 'Delete…').click();
	await until(
		() => document.body.textContent?.includes('Delete this capture?') === true,
	);
	button(document, 'Delete').click();
	await until(
		() =>
			document.body.textContent?.includes('Could not delete this capture') ===
			true,
	);
	expect(h.captures.opened?.mode).toBe('text');
	expect(await h.text(PATH)).toBe(FILE);
});

test('a thought opens its own lines selected in a CRLF file', async () => {
	const crlf = FILE.replace(
		'- first\n',
		'- first\n- second\n  more\n',
	).replaceAll('\n', '\r\n');
	const h = await setup({ [PATH]: crlf }, 'capture');
	const note = h.list.get({ id: 'one' });
	if (note === undefined) throw new Error('Expected a capture');
	const text = expectOk(captureText(note));
	const range = locateThought(text, note.body, 1, ['first', 'second\nmore']);
	if (!range) throw new Error('Expected the thought lines');
	h.captures.open('one', 'text', range);
	await until(() => textFile() !== null);
	const contents = textFile();
	expect(
		contents?.value.slice(contents.selectionStart, contents.selectionEnd),
	).toBe('- second\n  more');
});

test('a thought’s Edit as text saves pending capture text before selecting its lines', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	type(field('capture-text'), 'Pending thought context');
	await menu(0, 'Edit as text');
	await until(() => textFile() !== null);
	expect(await h.text(PATH)).toContain('Pending thought context');
	expect(textFile()?.value).toContain('Pending thought context');
	expect(
		textFile()?.value.slice(
			textFile()?.selectionStart,
			textFile()?.selectionEnd,
		),
	).toBe('- first');
});

test('thought move changes the list and a stale menu refuses', async () => {
	const two = FILE.replace('- first\n', '- first\n- second\n');
	const h = await setup({ [PATH]: two }, 'capture');
	await menu(1, 'Move up');
	await saved(h, (text) => !!text?.includes('- second\n- first'));
	const trigger = document.querySelectorAll<HTMLButtonElement>(
		'[data-thought-actions]',
	)[1];
	trigger?.click();
	await until(() => !!document.querySelector('[role="menuitem"]'));
	await h.writeElsewhere(PATH, two.replace('- second', '- changed'));
	await until(() => shows(h, 'changed'));
	const move = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((item) => item.textContent?.trim() === 'Move up');
	move?.click();
	flushSync();
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('thoughts changed');
	expect(await h.text(PATH)).toContain('- changed');
});

test('Delete thought asks first and refuses a list changed while the dialog is open', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	await menu(0, 'Delete thought…');
	await until(
		() => document.body.textContent?.includes('Delete this thought?') === true,
	);
	button(document, 'Cancel').click();
	flushSync();
	expect(await h.text(PATH)).toBe(FILE);
	await menu(0, 'Delete thought…');
	await h.writeElsewhere(PATH, FILE.replace('- first', '- changed'));
	await until(() => shows(h, 'changed'));
	button(document, 'Delete thought').click();
	await until(
		() => h.target.querySelector('[aria-label="Not applied"]') !== null,
	);
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('thoughts changed');
	expect(await h.text(PATH)).toContain('- changed');
});

test('Delete thought removes the selected thought after confirmation', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	await menu(0, 'Delete thought…');
	button(document, 'Delete thought').click();
	await saved(h, (text) => !!text && !text.includes('- first'));
});
