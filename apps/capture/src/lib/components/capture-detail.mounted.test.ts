/**
 * Mounted Capture Detail Tests
 *
 * The real capture and text editors over the app's own folder
 * (`$lib/app`), which the `test` condition makes a folder in memory:
 * typed text shown until it lands, thought commands over one body edit,
 * Edit as text over the note's whole text, and deletion. Each test starts
 * from an empty folder; the file it writes, and a write that waits, are
 * the world outside the folder (`outside`).
 *
 * Key behaviors:
 * - Capture text and thoughts compose over one body edit; typing stays
 *   visible until its save lands, and another writer's change shows when
 *   nothing is typed
 * - A save made while the store cannot be reached shows as typed and lands
 *   once it can
 * - A capture whose file stops reading offers its own text to repair
 * - Edit as text shows the file's own text, saves it as it is typed (in
 *   house style where its front matter parses; text that does not fit is
 *   written and says why), and opens it as a capture once it reads as one
 * - Text typed over a change or a delete made elsewhere is settled with it,
 *   as sync settles it
 * - A thought's Edit as text selects its lines, after pending typing lands
 * - Thought moves and deletes refuse a list that changed beneath them
 * - Deleting a capture asks first, saying its history keeps it, and
 *   one made while the store cannot be reached lands once it can
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	button,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const {
	clear,
	folder,
	ONE,
	outside,
	pageState,
	remove,
	savedText,
	until,
	write,
} = await import('./fixtures/app-folder.test-support.js');
const { locateThought } = await import('../capture-actions.svelte.ts');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');
setWide(true);
const AT = '2026-10-04T20:49:23.041Z';
/** A capture as Capture writes it: house style. */
const FILE = `---\ncapturedAt: "${AT}"\n---\n\nText\n\n## Thoughts\n\n- first\n`;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
	document.body.replaceChildren();
	await clear();
});
const field = (id: string) => {
	const element = document.getElementById(id);
	return element instanceof HTMLTextAreaElement ? element : null;
};
function submit(form: Element | null | undefined) {
	if (!(form instanceof HTMLFormElement)) throw new Error('Expected a form');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
/** The file of the capture `one` written as `text`, open as `mode`. */
async function setup(text: string, mode: 'capture' | 'text') {
	await write(text);
	const captures = pageState();
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const host = mount(ViewHost, { target, props: { captures } });
	cleanup.push(() => unmount(host));
	// Listed, whether it reads as a capture or is there to repair.
	await until(
		() =>
			folder.captures.get(ONE) !== undefined ||
			folder.captures.invalid().some((file) => file.id === ONE.id),
	);
	captures.open(ONE.id, mode);
	flushSync();
	return { captures, target };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const textFile = () =>
	document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
const shows = (h: Harness, text: string) =>
	h.target.textContent?.includes(text) === true;
/** Wait until the capture holds what `check` wants. */
const saved = (check: (text: string | null) => boolean) =>
	until(async () => check(await savedText()));
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
	await setup(FILE, 'capture');
	expect(field('capture-text')?.value).toBe('Text');
	type(field('capture-text'), 'Edited');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	await saved(
		(text) => !!text?.includes('Edited') && !!text.includes('- second'),
	);
	expect(field('new-thought')?.value).toBe('');
});

test('a thought added behind a held write keeps text typed just before it', async () => {
	await setup(FILE, 'capture');
	const release = outside.hold();
	try {
		type(field('capture-text'), 'Typed just now');
		type(field('new-thought'), 'second');
		submit(field('new-thought')?.form);
		flushSync();
		expect(field('capture-text')?.value).toBe('Typed just now');
		// Still held a moment later: nothing landed, and the typing stays.
		await Bun.sleep(20);
		flushSync();
		expect(field('capture-text')?.value).toBe('Typed just now');
		expect(await savedText()).toBe(FILE);
	} finally {
		release();
	}
	await saved(
		(text) => !!text?.includes('Typed just now') && !!text.includes('- second'),
	);
});

test('a thought added while the store cannot be reached shows, and lands once it can', async () => {
	const h = await setup(FILE, 'capture');
	const undo = outside.refuse('disk full');
	try {
		type(field('new-thought'), 'keep this');
		submit(field('new-thought')?.form);
		// Still waiting a moment later: the thought shows as added, and nothing landed.
		await Bun.sleep(20);
		flushSync();
		expect(field('new-thought')?.value).toBe('');
		flushSync();
		expect(h.target.textContent).toContain('keep this');
		expect(await savedText()).toBe(FILE);
	} finally {
		undo();
	}
	await saved((text) => !!text?.includes('- keep this'));
});

test('a blank thought is refused and its input stays', async () => {
	const h = await setup(FILE, 'capture');
	type(field('new-thought'), '  \n');
	submit(field('new-thought')?.form);
	flushSync();
	expect(field('new-thought')?.value).toBe('  \n');
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('Write something first.');
	expect(await savedText()).toBe(FILE);
});

test('a thought typed but not added stays visible to copy when the body becomes ambiguous', async () => {
	const h = await setup(FILE, 'capture');
	type(field('new-thought'), 'copy this');
	await write(FILE.replace('## Thoughts', '## Thoughts\n\n## Thoughts'));
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
	const h = await setup(FILE, 'capture');
	await write(broken);
	await until(() => shows(h, 'This file does not read as a capture'));
	button(h.target, 'Edit as text').click();
	await until(() => textFile()?.value === broken);
	expect(h.target.textContent).toContain('Needs repair');
});

test('an outside change shows when nothing is typed, and typing stays visible until its save answers', async () => {
	await setup(FILE, 'capture');
	await write(FILE.replace('Text', 'Elsewhere'));
	await until(() => field('capture-text')?.value === 'Elsewhere');
	const release = outside.hold();
	try {
		type(field('capture-text'), 'Mine');
		flushSync();
		expect(field('capture-text')?.value).toBe('Mine');
		// Still held a moment later: the file is theirs, and the typing shows.
		await Bun.sleep(20);
		flushSync();
		expect(field('capture-text')?.value).toBe('Mine');
		expect(await savedText()).toContain('Elsewhere');
	} finally {
		release();
	}
	await saved((text) => !!text?.includes('Mine'));
	expect(field('capture-text')?.value).toBe('Mine');
});

test('Edit as text shows the file’s own text and opens it again as a capture', async () => {
	const handWritten = `---\nzeta: 1\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- first\n`;
	const h = await setup(handWritten, 'capture');
	button(h.target, 'Edit as text').click();
	flushSync();
	expect(textFile()?.value).toBe(handWritten);
	button(h.target, 'Open as capture').click();
	await until(() => h.captures.opened?.mode === 'capture');
	// Opening and reading wrote nothing: the file is as it was written.
	expect(await savedText()).toBe(handWritten);
});

test('typing saves the text, Needs repair follows it, and text that reads opens as a capture', async () => {
	const h = await setup('---\ncapturedAt: nope\n---\nBody\n', 'text');
	await until(() => textFile() !== null);
	expect(h.target.textContent).toContain('Needs repair');
	expect(h.target.textContent).toContain('capturedAt');
	const typed = `---\ncapturedAt: ${AT}\n---\nBody\n`;
	type(textFile(), typed);
	flushSync();
	expect(h.target.textContent).not.toContain('Needs repair');
	// Written in house style, since its front matter parses.
	await saved((text) => text === `---\ncapturedAt: "${AT}"\n---\nBody\n`);
	button(h.target, 'Open as capture').click();
	await until(() => h.captures.opened?.mode === 'capture');
});

test('text that does not fit is written as typed, says why, and stays to fix', async () => {
	const h = await setup(FILE, 'text');
	const typed = FILE.replace(`capturedAt: "${AT}"`, 'capturedAt: soon');
	type(textFile(), typed);
	flushSync();
	expect(
		h.target.querySelector('[aria-label="Needs repair"]')?.textContent,
	).toContain('capturedAt');
	await saved((text) => text === typed);
	await until(() =>
		folder.captures.invalid().some((file) => file.id === ONE.id),
	);
	expect(textFile()?.value).toBe(typed);
	expect(button(h.target, 'Open as capture').disabled).toBe(true);
});

test('text typed while the store cannot be reached stays, and lands once it can', async () => {
	await setup(FILE, 'text');
	const typed = FILE.replace('Text', 'Keep this');
	const undo = outside.refuse('disk full');
	try {
		type(textFile(), typed);
		await Bun.sleep(20);
		flushSync();
		expect(textFile()?.value).toBe(typed);
		expect(await savedText()).toBe(FILE);
	} finally {
		undo();
	}
	await saved((text) => text === typed);
});

test('text typed over a change made elsewhere is settled with it', async () => {
	await setup(FILE, 'text');
	const release = outside.hold();
	try {
		type(textFile(), FILE.replace('Text', 'Mine'));
		// Another writer changes another line before the typing lands.
		await write(FILE.replace('- first', '- theirs'));
	} finally {
		release();
	}
	const both = FILE.replace('Text', 'Mine').replace('- first', '- theirs');
	await saved((text) => text === both);
	await until(() => textFile()?.value === both);
});

test('text typed while the file is deleted elsewhere makes it again: an edit beats a delete', async () => {
	await setup(FILE, 'text');
	const typed = FILE.replace('Text', 'Typed');
	const release = outside.hold();
	try {
		type(textFile(), typed);
		await remove();
	} finally {
		release();
	}
	await saved((text) => text === typed);
	expect(textFile()?.value).toBe(typed);
});

test('deleting from the text editor with a draft does not recreate the file', async () => {
	const h = await setup(FILE, 'text');
	type(textFile(), FILE.replace('Text', 'Pending'));
	button(h.target, 'Delete…').click();
	await until(
		() => document.body.textContent?.includes('Delete this capture?') === true,
	);
	button(document, 'Delete').click();
	await until(() => h.captures.opened === undefined);
	await saved((text) => text === null);
});

test('deleting a capture asks first, saying its history keeps it', async () => {
	const h = await setup(FILE, 'text');
	button(h.target, 'Delete…').click();
	await until(
		() =>
			document.body.textContent?.includes('Its history keeps them') ===
			true,
	);
	button(document, 'Cancel').click();
	flushSync();
	expect(await savedText()).toBe(FILE);
});

test('a delete made while the store cannot be reached closes the capture and lands once it can', async () => {
	const h = await setup(FILE, 'text');
	const undo = outside.refuse('disk full');
	try {
		button(h.target, 'Delete…').click();
		await until(
			() =>
				document.body.textContent?.includes('Delete this capture?') === true,
		);
		button(document, 'Delete').click();
		await until(() => h.captures.opened === undefined);
		expect(await savedText()).toBe(FILE);
	} finally {
		undo();
	}
	await saved((text) => text === null);
});

test('a thought opens its own lines selected in a CRLF body', async () => {
	const crlf = FILE.replace(
		'- first\n',
		'- first\n- second\n  more\n',
	).replaceAll('\n', '\r\n');
	const h = await setup(crlf, 'capture');
	const note = folder.captures.get(ONE);
	if (note === undefined) throw new Error('Expected a capture');
	expect(note.body).toContain('\r\n');
	const range = locateThought(crlf, note.body, 1, ['first', 'second\nmore']);
	if (!range) throw new Error('Expected the thought lines');
	h.captures.open(ONE.id, 'text', range);
	await until(() => textFile() !== null);
	const contents = textFile();
	expect(
		contents?.value.slice(contents.selectionStart, contents.selectionEnd),
	).toBe('- second\n  more');
});

test('a thought’s Edit as text saves pending capture text before selecting its lines', async () => {
	await setup(FILE, 'capture');
	type(field('capture-text'), 'Pending thought context');
	await menu(0, 'Edit as text');
	await until(() => textFile() !== null);
	expect(await savedText()).toContain('Pending thought context');
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
	const h = await setup(two, 'capture');
	await menu(1, 'Move up');
	await saved((text) => !!text?.includes('- second\n- first'));
	const trigger = document.querySelectorAll<HTMLButtonElement>(
		'[data-thought-actions]',
	)[1];
	trigger?.click();
	await until(() => !!document.querySelector('[role="menuitem"]'));
	await write(two.replace('- second', '- changed'));
	await until(() => shows(h, 'changed'));
	const move = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((item) => item.textContent?.trim() === 'Move up');
	move?.click();
	flushSync();
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('thoughts changed');
	expect(await savedText()).toContain('- changed');
});

test('Delete thought asks first and refuses a list changed while the dialog is open', async () => {
	const h = await setup(FILE, 'capture');
	await menu(0, 'Delete thought…');
	await until(
		() => document.body.textContent?.includes('Delete this thought?') === true,
	);
	button(document, 'Cancel').click();
	flushSync();
	expect(await savedText()).toBe(FILE);
	await menu(0, 'Delete thought…');
	await write(FILE.replace('- first', '- changed'));
	await until(() => shows(h, 'changed'));
	button(document, 'Delete thought').click();
	await until(
		() => h.target.querySelector('[aria-label="Not applied"]') !== null,
	);
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('thoughts changed');
	expect(await savedText()).toContain('- changed');
});

test('Delete thought removes the selected thought after confirmation', async () => {
	await setup(FILE, 'capture');
	await menu(0, 'Delete thought…');
	button(document, 'Delete thought').click();
	await saved((text) => !!text && !text.includes('- first'));
});
