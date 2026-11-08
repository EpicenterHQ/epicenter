/**
 * EntryCard over a word note in a stand-in folder: the note is the note's
 * body, edited as typed (`entries.notes.edit`), and the stage and delete
 * write through the same notes. While the store is out of reach, each
 * waits, and lands once it is back.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { openVocabFolder, until } = await import(
	'../../lib/vocab.test-support.js'
);
const { createEntries } = await import('../../lib/entries.svelte.js');
const { confirmationDialog } = await import(
	'@epicenter/ui/confirmation-dialog'
);

const { flushSync, mount, unmount } = await import('svelte');
const { cardProps } = await import('./card-props.test-support.svelte.js');
const { default: EntryCardHost } = await import(
	'./fixtures/EntryCardHost.svelte'
);

function noteOf(target: HTMLElement): HTMLTextAreaElement {
	const note = target.querySelector(
		'textarea[aria-label="Your note for lucid"]',
	);
	if (!(note instanceof HTMLTextAreaElement))
		throw new Error('Note editor missing');
	return note;
}

async function setup() {
	const folder = await openVocabFolder();
	const entries = createEntries(folder.lists.entries);
	expectOk(await entries.add('lucid'));
	const id = entries.words[0]!.id;
	const card = cardProps(entries, entries.words[0]!);
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(EntryCardHost, {
		target,
		props: { card },
	});
	flushSync();
	return {
		folder,
		entries,
		/** The word as the list shows it. */
		word: () => folder.lists.entries.get({ id }),
		/** Make every write to the words wait, as for a lost connection, until the returned undo. */
		refuseEntries: () => folder.files.refuse('offline', { under: 'entries' }),
		id,
		card,
		target,
		mounted,
		async close() {
			await unmount(mounted);
			target.remove();
			folder[Symbol.dispose]();
		},
	};
}

test('note draft stays visible until save and then follows the row', async () => {
	const context = await setup();
	const note = noteOf(context.target);
	type(note, 'clear');
	flushSync();
	expect(note.value).toBe('clear');
	await until(() => context.word()?.body === 'clear');
	expect(context.folder.files.read(`entries/${context.id}.md`)).toEndWith(
		'---\nclear',
	);
	flushSync();
	expect(note.value).toBe('clear');
	await context.close();
});

test('typing again during a note save keeps the newer value', async () => {
	const context = await setup();
	const release = context.folder.files.hold();
	const note = noteOf(context.target);
	type(note, 'first');
	await Bun.sleep(10);
	type(note, 'second');
	flushSync();
	expect(note.value).toBe('second');
	release();
	await until(() => context.word()?.body === 'second');
	flushSync();
	expect(note.value).toBe('second');
	await context.close();
});

test('a note typed while the store is out of reach stays as typed, and lands once it is back', async () => {
	const context = await setup();
	const back = context.refuseEntries();
	const note = noteOf(context.target);
	type(note, 'typed offline');
	await until(() => context.folder.lists.saving());
	await Bun.sleep(20);
	flushSync();
	expect(note.value).toBe('typed offline');
	expect(context.word()?.body).toBe('');
	back();
	await until(() => context.word()?.body === 'typed offline');
	flushSync();
	expect(note.value).toBe('typed offline');
	await context.close();
});

test('note and stage updates merge over one path', async () => {
	const context = await setup();
	const note = noteOf(context.target);
	type(note, 'new note');
	click(context.target, 'Understand');
	await until(
		() =>
			context.word()?.stage === 'understood' &&
			context.word()?.body === 'new note',
	);
	await context.close();
});

test('a stage and a delete made while the store is out of reach land, in order, once it is back', async () => {
	const context = await setup();
	const back = context.refuseEntries();
	click(context.target, 'Understand');
	click(context.target, 'Delete');
	const deleting = confirmationDialog.confirm();
	await Bun.sleep(20);
	expect(context.word()?.stage).toBe('new');
	back();
	await deleting;
	expect(context.word()).toBeUndefined();
	expect(context.folder.files.paths('entries')).toEqual([]);
	await context.close();
});

test('Delete asks first; Cancel changes nothing, and confirming deletes the word', async () => {
	const context = await setup();
	const before = context.word();
	click(context.target, 'Delete');
	expect(confirmationDialog.isOpen).toBe(true);
	expect(confirmationDialog.options?.title).toContain('lucid');
	confirmationDialog.cancel();
	expect(context.word()).toEqual(before);
	click(context.target, 'Delete');
	await confirmationDialog.confirm();
	expect(context.word()).toBeUndefined();
	expect(context.folder.files.paths('entries')).toEqual([]);
	await context.close();
});
