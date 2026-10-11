/**
 * Entry card tests.
 * The real `EntryCard` is mounted in jsdom over the real words list on
 * Vocab's real browser folder over an in-memory OPFS stand-in that can fail a
 * write or be changed the way another program would. Typing, focusing, and
 * pressing buttons are DOM events. This shows what a delivered event does;
 * jsdom has no layout, focus, selection, or IME, so it says nothing about
 * whether a person can deliver it.
 *
 * Key behaviors:
 * - The note is read-only until focusing it opens the word; each keystroke
 *   then saves
 * - A change made elsewhere merges first: only the note both changed is
 *   reviewed, and Apply with either side keeps their other changes; a word
 *   deleted elsewhere is reviewed too, and using your edit creates it again
 * - A stage pressed on a word that is not open saves it as listed
 * - Delete asks first; Cancel changes nothing, and confirming deletes it
 * - Opening another word after a failed save asks to discard it
 *
 * The confirmation is the shared dialog's state, answered as its buttons
 * would; the dialog's own markup is not mounted here.
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import type { Entry } from '../../lib/data.js';
import {
	createBrowser,
	entriesOf,
	fileText,
} from '../../lib/folder.test-support.js';
import { click, type } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createEntriesState } = await import('../../lib/entries.svelte.js');
const { confirmationDialog } = await import(
	'@epicenter/ui/confirmation-dialog'
);
const { cardProps } = await import('./card-props.test-support.svelte.js');
const { default: EntryCard } = await import('./EntryCard.svelte');

/** Let the folder answer and the cards catch up. */
async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		flushSync();
		if (done()) return;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** One card per word, mounted in order. */
async function setup(texts: string[]) {
	const browser = createBrowser();
	const folder = await browser.open();
	const entries = createEntriesState(entriesOf(folder));
	for (const text of texts) expectOk(await entries.add(text));
	const byText = (text: string): Entry => {
		const entry = entries.entries.find((candidate) => candidate.text === text);
		if (entry === undefined) throw new Error(`${text} is not listed`);
		return entry;
	};
	const target = document.createElement('div');
	document.body.append(target);
	const cards = texts.map((text) => {
		const element = document.createElement('div');
		target.append(element);
		return mount(EntryCard, {
			target: element,
			props: cardProps(entries, byText(text)),
		});
	});
	flushSync();
	const { faults } = browser.opfs;
	const path = (text: string) => byText(text).stored.path;
	const field = (text: string) =>
		target.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="Your note for ${text}"]`,
		) ?? undefined;
	return {
		folder,
		entries,
		target,
		byText,
		path,
		field,
		file: (text: string) => fileText(folder, path(text)),
		/** Focus the note, as a click or a tab into it would, and wait for the word to open. */
		async focus(text: string) {
			field(text)?.dispatchEvent(new window.FocusEvent('focus'));
			await until(() => field(text)?.readOnly === false, `${text} to open`);
		},
		/** The next write of `text`'s file fails. */
		failWrite(text: string) {
			const failing = path(text);
			faults.write = (key) => {
				if (!key.endsWith(failing)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
		async [Symbol.asyncDispose]() {
			confirmationDialog.close();
			for (const card of cards) void unmount(card);
			target.remove();
			await entries.close();
			await browser[Symbol.asyncDispose]();
		},
	};
}

const reviewGroups = (target: HTMLElement) => [
	...target.querySelectorAll(
		'form[aria-label="Review sync changes"] [role="group"]',
	),
];

/** The names of the parts the review asks about. */
const reviewedParts = (target: HTMLElement) =>
	reviewGroups(target).map((group) => group.getAttribute('aria-label'));

/** Press "Use this" on one side of every part in the review, then Apply. */
function applyEvery(
	target: HTMLElement,
	side: 'Your edit' | 'Saved elsewhere',
) {
	const groups = reviewGroups(target);
	if (groups.length === 0) throw new Error('Nothing is in review');
	for (const group of groups) {
		const buttons = [...group.querySelectorAll('button')].filter(
			(button) => button.textContent?.trim() === 'Use this',
		);
		const button = buttons[side === 'Your edit' ? 0 : 1];
		if (button === undefined) throw new Error(`No Use this for ${side}`);
		click(target, button);
	}
	flushSync();
	click(target, 'Apply');
}

const theirs = (stage: string) =>
	`---\ntext: lucid\nnote: theirs\nstage: ${stage}\ncreatedAt: 2026-10-03T00:00:00.000Z\n---\n`;

test('the note is read-only until focusing it opens the word, and each keystroke then saves', async () => {
	await using context = await setup(['lucid']);
	const note = context.field('lucid');
	expect(note?.readOnly).toBe(true);
	await context.focus('lucid');
	type(note, 'clear');
	await until(() => context.entries.unsaved === false, 'the save');
	expect(await context.file('lucid')).toContain('note: clear');
});

test('a change made elsewhere to the note asks about the note only, and keeps their other changes', async () => {
	await using context = await setup(['lucid']);
	const { target } = context;
	const note = context.field('lucid');
	await context.focus('lucid');
	expectOk(
		await context.folder.files.overwrite(
			context.path('lucid'),
			theirs('usable'),
		),
	);
	type(note, 'mine');
	await until(
		() =>
			target.querySelector('form[aria-label="Review sync changes"]') !== null,
		'the review',
	);
	expect(reviewedParts(target)).toEqual(['note']);
	applyEvery(target, 'Saved elsewhere');
	await until(() => context.entries.unsaved === false, 'the save');
	await until(() => note?.value === 'theirs', 'their note');
	const chose = await context.file('lucid');
	expect(chose).toContain('note: theirs');
	expect(chose).toContain('stage: usable');

	expectOk(
		await context.folder.files.overwrite(
			context.path('lucid'),
			theirs('new').replace('note: theirs', 'note: elsewhere'),
		),
	);
	type(note, 'mine again');
	await until(
		() =>
			target.querySelector('form[aria-label="Review sync changes"]') !== null,
		'the second review',
	);
	expect(reviewedParts(target)).toEqual(['note']);
	applyEvery(target, 'Your edit');
	await until(
		() =>
			target.querySelector('form[aria-label="Review sync changes"]') === null,
		'the review to close',
	);
	await until(() => context.entries.unsaved === false, 'the save');
	const saved = await context.file('lucid');
	expect(saved).toContain('note: mine again');
	expect(saved).toContain('stage: new');
});

test('a word deleted elsewhere is reviewed; using your edit creates it again, using theirs leaves it deleted', async () => {
	await using context = await setup(['lucid']);
	const { folder, target } = context;
	const path = context.path('lucid');
	await context.focus('lucid');
	expectOk(await folder.files.remove(expectOk(await folder.files.read(path))));
	type(context.field('lucid'), 'still mine');
	await until(
		() => target.textContent?.includes('This was deleted elsewhere') ?? false,
		'the conflict',
	);
	applyEvery(target, 'Your edit');
	await until(
		() =>
			context.entries.unsaved === false &&
			context.entries.opened?.kind === 'word',
		'the recreate',
	);
	await until(
		() => !(target.textContent?.includes('deleted elsewhere') ?? true),
		'the prompt to close',
	);
	expect(await fileText(folder, path)).toContain('note: still mine');

	expectOk(await folder.files.remove(expectOk(await folder.files.read(path))));
	type(context.field('lucid'), 'gone');
	await until(
		() => target.textContent?.includes('This was deleted elsewhere') ?? false,
		'the second conflict',
	);
	applyEvery(target, 'Saved elsewhere');
	await until(() => context.entries.opened === undefined, 'the word to close');
	expect(await fileText(folder, path)).toBeUndefined();
});

test('a stage pressed on a word that is not open saves it as listed', async () => {
	await using context = await setup(['lucid']);
	click(context.target, 'Understand');
	await until(
		() => context.byText('lucid').stage === 'understood',
		'the stage to save',
	);
	expect(await context.file('lucid')).toContain('stage: understood');
	expect(context.entries.opened).toBeUndefined();
});

test('Delete asks first; Cancel changes nothing, and confirming deletes the word', async () => {
	await using context = await setup(['lucid']);
	const { entries, target } = context;
	const before = await context.file('lucid');
	click(target, 'Delete');
	expect(confirmationDialog.isOpen).toBe(true);
	expect(confirmationDialog.options?.title).toContain('lucid');
	confirmationDialog.cancel();
	await Bun.sleep(10);
	expect(await context.file('lucid')).toBe(before);

	const path = context.path('lucid');
	click(target, 'Delete');
	await confirmationDialog.confirm();
	expect(entries.entries).toEqual([]);
	expect(await fileText(context.folder, path)).toBeUndefined();
});

test('opening another word after a failed save asks to discard it', async () => {
	await using context = await setup(['lucid', 'candid']);
	const { entries } = context;
	await context.focus('lucid');
	context.failWrite('lucid');
	type(context.field('lucid'), 'lost');
	await until(
		() =>
			entries.opened?.kind === 'word' &&
			entries.opened.session.state.status === 'error',
		'the save to fail',
	);

	context.field('candid')?.dispatchEvent(new window.FocusEvent('focus'));
	await until(() => confirmationDialog.isOpen, 'the question');
	expect(confirmationDialog.options?.title).toBe('Discard unsaved changes?');
	expect(entries.opened?.id).toBe(context.byText('lucid').id);
	await confirmationDialog.confirm();
	await until(
		() => context.field('candid')?.readOnly === false,
		'candid to open',
	);
	expect(await context.file('lucid')).not.toContain('lost');
});
