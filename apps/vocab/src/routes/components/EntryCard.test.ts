/**
 * EntryCard over a word note on a real device folder: the note is the
 * note's body, edited as typed (`fieldEdit`), and the stage and delete
 * write through the one list.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, spyOn, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { openVocabFolder, until } = await import(
	'../../lib/vocab.test-support.js'
);
const { createEntries } = await import('../../lib/entries.svelte.js');
const { toast } = await import('@epicenter/ui/sonner');
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
	const mounted = mount(EntryCardHost, { target, props: { card } });
	flushSync();
	return {
		folder,
		entries,
		/** The word as the list shows it. */
		word: () => folder.lists.entries.get({ id }),
		id,
		card,
		target,
		mounted,
		async close() {
			await unmount(mounted);
			target.remove();
			await folder[Symbol.asyncDispose]();
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
	expect(await context.folder.text(`entries/${context.id}.md`)).toEndWith(
		'---\nclear',
	);
	flushSync();
	expect(note.value).toBe('clear');
	await context.close();
});

test('typing again during a note save keeps the newer value', async () => {
	const context = await setup();
	const gate = Promise.withResolvers<void>();
	context.folder.control.gate = gate.promise;
	const note = noteOf(context.target);
	type(note, 'first');
	await Bun.sleep(10);
	type(note, 'second');
	flushSync();
	expect(note.value).toBe('second');
	gate.resolve();
	await until(() => context.word()?.body === 'second');
	flushSync();
	expect(note.value).toBe('second');
	await context.close();
});

test('a failed note keeps its typed text and can retry or discard', async () => {
	const context = await setup();
	context.folder.control.refuse = (collection) => collection === 'entries';
	const note = noteOf(context.target);
	type(note, 'failed text');
	await until(
		() => context.target.textContent?.includes('Not saved:') ?? false,
	);
	flushSync();
	expect(note.value).toBe('failed text');
	expect(context.target.textContent).toContain('Not saved:');
	expect(context.target.textContent).toContain('Save again');
	expect(context.word()?.body).toBe('');
	context.folder.control.refuse = undefined;
	click(context.target, 'Save again');
	await until(() => context.word()?.body === 'failed text');
	flushSync();
	expect(context.target.textContent).not.toContain('Not saved:');
	context.folder.control.refuse = (collection) => collection === 'entries';
	type(note, 'another attempt');
	await until(
		() => context.target.textContent?.includes('Not saved:') ?? false,
	);
	flushSync();
	expect(note.value).toBe('another attempt');
	click(context.target, 'Discard');
	flushSync();
	expect(note.value).toBe('failed text');
	expect(context.target.textContent).not.toContain('Not saved:');
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

test('failed stage and delete commands show their errors', async () => {
	const context = await setup();
	context.folder.control.refuse = (collection) => collection === 'entries';
	const errorToast = spyOn(toast, 'error');
	try {
		click(context.target, 'Understand');
		await until(() => errorToast.mock.calls.length === 1);
		expect(errorToast.mock.calls[0]?.[0]).toBe('The stage was not saved');
		click(context.target, 'Delete');
		await confirmationDialog.confirm();
		expect(errorToast.mock.calls[1]?.[0]).toBe('The word was not deleted');
		expect(context.word()).toBeDefined();
	} finally {
		errorToast.mockRestore();
		await context.close();
	}
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
	expect(await context.folder.files('entries')).toEqual([]);
	await context.close();
});
