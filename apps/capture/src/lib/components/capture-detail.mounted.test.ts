/**
 * Mounted Capture Detail Tests
 *
 * Verifies the real capture and text editors against the folder mirror:
 * visible typed text, thought composition, explicit action saves, and live repair.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { until as waitUntil } from '@epicenter/folder/testing';
import {
	button,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openCaptures } = await import('../local-folder.test-support.js');
const { locateThought } = await import('../capture-actions.svelte.ts');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');
setWide(true);
const until = (
	check: () => boolean,
	options: { timeout?: number } = { timeout: 2500 },
) => waitUntil(check, options);
const AT = '2026-10-04T20:49:23.041Z';
const PATH = 'captures/one.md';
const FILE = `---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- first\n`;
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
	const harness = await openCaptures(files);
	await harness.captures.open('one', mode);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(ViewHost, {
		target,
		props: { captures: harness.captures, folder: harness.folder },
	});
	cleanup.push(async () => {
		await unmount(view);
		await harness.close();
	});
	flushSync();
	return { ...harness, target };
}
const textFile = () =>
	document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
async function menu(index: number, action: string) {
	const trigger = document.querySelectorAll<HTMLButtonElement>(
		'[data-thought-actions]',
	)[index];
	if (!trigger) throw new Error('No thought menu');
	trigger.click();
	await until(() => {
		flushSync();
		return !!document.querySelector('[role="menuitem"]');
	});
	const item = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((candidate) => candidate.textContent?.trim() === action);
	if (!item) throw new Error(`No ${action} action`);
	item.click();
	flushSync();
}
async function land(h: Awaited<ReturnType<typeof setup>>) {
	await h.quiet();
	flushSync();
}

test('typing capture text then adding a thought keeps both edits', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	expect(field('capture-text')?.value).toBe('Text');
	type(field('capture-text'), 'Edited');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	await land(h);
	expect(h.text(PATH)).toContain('Edited');
	expect(h.text(PATH)).toContain('- second');
	expect(field('new-thought')?.value).toBe('');
});

test('a thought added behind a pending write keeps text typed just before it', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	type(field('capture-text'), 'Typed just now');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	flushSync();
	expect(field('capture-text')?.value).toBe('Typed just now');
	await until(() => h.host.log.puts.length > 0, { timeout: 2500 });
	release();
	await land(h);
	expect(h.text(PATH)).toContain('Typed just now');
	expect(h.text(PATH)).toContain('- second');
});

test('a failed thought save keeps the thought visible and retries the body', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	const restore = h.failSaves(PATH);
	type(field('new-thought'), 'keep this');
	submit(field('new-thought')?.form);
	await until(() => {
		flushSync();
		return h.target.textContent?.includes('Not saved:') === true;
	});
	expect(field('new-thought')?.value).toBe('');
	expect(h.target.textContent).toContain('keep this');
	expect(h.text(PATH)).toBe(FILE);
	restore();
	button(h.target, 'Save again').click();
	await until(() => h.text(PATH)?.includes('- keep this') === true);
	flushSync();
	expect(h.target.textContent).not.toContain('Not saved:');
});

test('Discard follows the saved body after a failed thought save', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	h.failSaves(PATH);
	type(field('new-thought'), 'discard me');
	submit(field('new-thought')?.form);
	await until(() => {
		flushSync();
		return h.target.textContent?.includes('Not saved:') === true;
	});
	button(h.target, 'Discard').click();
	flushSync();
	expect(h.target.textContent).not.toContain('discard me');
	expect(h.target.textContent).not.toContain('Not saved:');
	expect(h.text(PATH)).toBe(FILE);
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
	expect(h.text(PATH)).toBe(FILE);
});

test('a thought typed but not added stays visible to copy when the body becomes ambiguous', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), 'copy this');
	h.writeElsewhere(
		PATH,
		FILE.replace('## Thoughts', '## Thoughts\n\n## Thoughts'),
	);
	await until(() => {
		flushSync();
		return !!document.querySelector('[aria-label="Thought not added"]');
	});
	expect(
		document.querySelector<HTMLTextAreaElement>(
			'[aria-label="Thought not added"]',
		)?.value,
	).toBe('copy this');
	expect(button(h.target, 'Copy text')).toBeDefined();
});

test('Edit as text follows queued typing after a capture stops reading as one', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	type(field('capture-text'), 'Held text');
	h.writeElsewhere(PATH, FILE.replace(`capturedAt: ${AT}`, 'capturedAt: nope'));
	await until(() => {
		flushSync();
		return (
			h.target.textContent?.includes('This file does not read as a capture') ===
			true
		);
	});
	button(h.target, 'Edit as text').click();
	await until(() => {
		flushSync();
		return textFile()?.value.includes('Held text') === true;
	});
	expect(textFile()?.value).toContain('capturedAt: nope');
	expect(h.text(PATH)).toContain('Held text');
});

test('Edit as text queued after a body write replaces the whole file', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	type(field('capture-text'), 'Pending');
	await until(() => h.host.log.puts.length > 0);
	button(h.target, 'Edit as text').click();
	flushSync();
	expect(h.captures.opened?.mode).toBe('text');
	expect(textFile()?.value).toBe(FILE);
	type(textFile(), FILE.replace('- first', '- first\n- from source'));
	release();
	await land(h);
	expect(h.text(PATH)).toContain('Text');
	expect(h.text(PATH)).not.toContain('Pending');
	expect(h.text(PATH)).toContain('- from source');
});

test('Open as capture saves the repaired text before switching views', async () => {
	const invalid = '---\ncapturedAt: nope\n---\nBody\n';
	const h = await setup({ [PATH]: invalid }, 'text');
	const repaired = `---\ncapturedAt: ${AT}\n---\nBody\n`;
	type(textFile(), repaired);
	flushSync();
	button(h.target, 'Open as capture').click();
	await until(() => {
		flushSync();
		return h.captures.opened?.mode === 'capture';
	});
	expect(h.text(PATH)).toBe(repaired);
});

test('an outside change appears when idle and typing stays visible until its save answers', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	h.writeElsewhere(PATH, FILE.replace('Text', 'Elsewhere'));
	await until(() => {
		flushSync();
		return field('capture-text')?.value === 'Elsewhere';
	});
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	type(field('capture-text'), 'Mine');
	flushSync();
	expect(field('capture-text')?.value).toBe('Mine');
	await until(() => h.host.log.puts.length > 0, { timeout: 2500 });
	expect(field('capture-text')?.value).toBe('Mine');
	release();
	await land(h);
	expect(field('capture-text')?.value).toBe('Mine');
	expect(h.text(PATH)).toContain('Mine');
});

test('Needs repair responds to typing before the save answers', async () => {
	const h = await setup(
		{ [PATH]: '---\ncapturedAt: nope\n---\nBody\n' },
		'text',
	);
	const file = document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
	expect(h.target.textContent).toContain('Needs repair');
	type(file, `---\ncapturedAt: ${AT}\n---\nBody\n`);
	flushSync();
	expect(h.target.textContent).not.toContain('Needs repair');
	const open = [...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Open as capture',
	);
	expect(open?.disabled).toBe(false);
});

test('Edit as text shows LF and saves CRLF files with CRLF', async () => {
	const crlf = FILE.replaceAll('\n', '\r\n');
	const h = await setup({ [PATH]: crlf }, 'text');
	expect(textFile()?.value).toBe(FILE);
	type(textFile(), FILE.replace('Text', 'Revised'));
	await land(h);
	expect(h.text(PATH)).toBe(crlf.replace('Text', 'Revised'));
});

test('failed text editing keeps the typed file until Save again', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	const restore = h.failSaves(PATH);
	const typed = FILE.replace('Text', 'Keep this');
	type(textFile(), typed);
	await until(() => {
		flushSync();
		return h.target.textContent?.includes('Not saved:') === true;
	});
	expect(textFile()?.value).toBe(typed);
	expect(h.text(PATH)).toBe(FILE);
	restore();
	button(h.target, 'Save again').click();
	await until(() => h.text(PATH) === typed);
	flushSync();
	expect(h.target.textContent).not.toContain('Not saved:');
});

test('Discard returns failed text editing to the saved file', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	h.failSaves(PATH);
	type(textFile(), FILE.replace('Text', 'Discard this'));
	await until(() => {
		flushSync();
		return h.target.textContent?.includes('Not saved:') === true;
	});
	button(h.target, 'Discard').click();
	flushSync();
	expect(textFile()?.value).toBe(FILE);
	expect(h.target.textContent).not.toContain('Not saved:');
});

test('pending whole-file text refuses a file deleted elsewhere', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const typed = FILE.replace('Text', 'Typed');
	type(textFile(), typed);
	await until(() => h.host.log.puts.length > 0, { timeout: 2500 });
	h.deleteElsewhere('one');
	flushSync();
	expect(textFile()?.value).toBe(typed);
	release();
	await land(h);
	expect(h.text(PATH)).toBeUndefined();
	expect(h.target.textContent).toContain('Not saved:');
	expect(h.target.textContent).toContain('Copy');
});

test('deleting a text editor with pending typing does not recreate the file', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	type(textFile(), FILE.replace('Text', 'Pending'));
	button(h.target, 'Delete…').click();
	await until(() => {
		flushSync();
		return document.body.textContent?.includes('Delete this capture?') === true;
	});
	button(document, 'Delete').click();
	await until(() => {
		flushSync();
		return h.captures.opened === undefined;
	});
	await h.quiet();
	expect(h.text(PATH)).toBeUndefined();
});

test('a failed delete keeps the file open and reports the failure', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	h.failSaves(PATH);
	button(h.target, 'Delete…').click();
	await until(() => {
		flushSync();
		return document.body.textContent?.includes('Delete this capture?') === true;
	});
	button(document, 'Delete').click();
	await until(() => {
		flushSync();
		return (
			document.body.textContent?.includes('Could not delete this capture') ===
			true
		);
	});
	expect(h.captures.opened?.mode).toBe('text');
	expect(h.text(PATH)).toBe(FILE);
});

test('a thought opens its own lines selected in a CRLF file', async () => {
	const crlf = FILE.replace(
		'- first\n',
		'- first\n- second\n  more\n',
	).replaceAll('\n', '\r\n');
	const h = await setup({ [PATH]: crlf }, 'capture');
	const row = h.cached('one');
	if (row?.issues !== null) throw new Error('Expected a capture row');
	const range = locateThought(crlf, row.body, 1, ['first', 'second\nmore']);
	if (!range) throw new Error('Expected the thought lines');
	await h.captures.open('one', 'text', range);
	await until(() => {
		flushSync();
		return textFile() !== null;
	});
	const contents = textFile();
	expect(
		contents?.value.slice(contents.selectionStart, contents.selectionEnd),
	).toBe('- second\n  more');
});

test('a thought Edit as text writes pending capture text before selecting its lines', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	type(field('capture-text'), 'Pending thought context');
	await menu(0, 'Edit as text');
	await until(() => {
		flushSync();
		return textFile() !== null;
	});
	expect(h.text(PATH)).toContain('Pending thought context');
	expect(textFile()?.value).toContain('Pending thought context');
	expect(
		textFile()?.value.slice(
			textFile()?.selectionStart,
			textFile()?.selectionEnd,
		),
	).toBe('- first');
});

test('U+0000 paste is refused and the text box reverts', async () => {
	const h = await setup({ [PATH]: FILE }, 'text');
	type(textFile(), `${FILE}\0bad`);
	flushSync();
	await Bun.sleep(0);
	expect(textFile()?.value).toBe(FILE);
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('U+0000');
	expect(h.text(PATH)).toBe(FILE);
});

test('thought move changes the list and a stale menu refuses', async () => {
	const two = FILE.replace('- first\n', '- first\n- second\n');
	const h = await setup({ [PATH]: two }, 'capture');
	await menu(1, 'Move up');
	await land(h);
	expect(h.text(PATH)).toContain('- second\n- first');
	const trigger = document.querySelectorAll<HTMLButtonElement>(
		'[data-thought-actions]',
	)[1];
	trigger?.click();
	await until(() => {
		flushSync();
		return !!document.querySelector('[role="menuitem"]');
	});
	h.writeElsewhere(PATH, two.replace('- second', '- changed'));
	await until(() => {
		flushSync();
		return h.target.textContent?.includes('changed') === true;
	});
	const move = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((item) => item.textContent?.trim() === 'Move up');
	move?.click();
	flushSync();
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('thoughts changed');
	expect(h.text(PATH)).toContain('- changed');
});

test('Delete thought asks first and refuses a list changed while the dialog is open', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	await menu(0, 'Delete thought…');
	await until(() => {
		flushSync();
		return document.body.textContent?.includes('Delete this thought?') === true;
	});
	expect(h.text(PATH)).toBe(FILE);
	button(document, 'Cancel').click();
	flushSync();
	expect(h.text(PATH)).toBe(FILE);
	await menu(0, 'Delete thought…');
	h.writeElsewhere(PATH, FILE.replace('- first', '- changed'));
	await until(() => {
		flushSync();
		return h.target.textContent?.includes('changed') === true;
	});
	button(document, 'Delete thought').click();
	await until(() => {
		flushSync();
		return h.target.querySelector('[aria-label="Not applied"]') !== null;
	});
	expect(
		h.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('thoughts changed');
	expect(h.text(PATH)).toContain('- changed');
});

test('Delete thought removes the selected thought after confirmation', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	await menu(0, 'Delete thought…');
	button(document, 'Delete thought').click();
	await land(h);
	expect(h.text(PATH)).not.toContain('- first');
});
