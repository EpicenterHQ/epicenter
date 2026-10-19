/**
 * Entry card tests.
 * The real `EntryCard` is mounted in jsdom over the real Vocab store and the
 * local folder context, on Vocab's real local folder over an in-memory
 * IndexedDB. Each card is given its word from the cached rows, as the words
 * list gives it. Typing and pressing buttons are DOM events. This shows what
 * a delivered event does; jsdom has no layout, focus, selection, or IME, so
 * it says nothing about whether a person can deliver it.
 *
 * Key behaviors:
 * - The note is editable at once and saved after the pause that follows the
 *   last keystroke, or at once when the learner leaves it or the card goes
 *   away
 * - The typed note survives the list being read again before it is saved
 * - A stage press is saved at once, and keeps a note typed meanwhile
 * - A save that fails keeps the note on screen and says why, and Try again
 *   saves it
 * - Delete asks first; Cancel changes nothing, and confirming deletes it
 *
 * The confirmation is the shared dialog's state, answered as its buttons
 * would; the dialog's own markup is not mounted here.
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import { createBrowser } from '../../lib/folder.test-support.js';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import type { SaveError } from '@epicenter/folder';
import { Err } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import {
	blur,
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import type { EntryRows } from '../../lib/entries.svelte.js';
import { cached, openVocab, quiet } from '../../lib/query.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { wordsOf } = await import('../../lib/entries.svelte.js');
const { confirmationDialog } = await import(
	'@epicenter/ui/confirmation-dialog'
);
const { cardProps } = await import('./card-props.test-support.svelte.js');
const { default: EntryCardHost } = await import(
	'./fixtures/EntryCardHost.svelte'
);

/** Let the folder answer and the card catch up. */
async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 400; attempt++) {
		flushSync();
		if (done()) return;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** One card for `text`, given its word from the cache whenever the cache changes. */
async function setup(text: string, { saveAfterMs = 60 } = {}) {
	const browser = createBrowser();
	const folder = await browser.open();
	const opened = await openVocab(folder, { saveAfterMs });
	const { vocab } = opened;
	expectOk(await vocab.entries.add(text));
	const props = cardProps(vocab.entries, cached(vocab, text));
	// The words list passes each card its word as the cache now holds it.
	const unsubscribe = vocab.queryClient.getQueryCache().subscribe(() => {
		const rows = vocab.queryClient.getQueryData<EntryRows>(
			vocab.entries.entriesQuery().queryKey,
		);
		const entry = rows && wordsOf(rows).find((word) => word.text === text);
		if (entry !== undefined) props.entry = entry;
	});
	const target = document.createElement('div');
	document.body.append(target);
	const card = mount(EntryCardHost, {
		target,
		props: { client: vocab.queryClient, card: props },
	});
	flushSync();
	const id = props.entry.id;
	const note = () =>
		target.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="Your note for ${text}"]`,
		) ?? undefined;
	return {
		folder,
		vocab,
		target,
		note,
		/** Take the card away, as the list does when the word leaves it. */
		unmount: () => void unmount(card),
		/** The word's fields as its file holds them, or `undefined` when it is gone. */
		saved: async () => expectOk(await folder.tables.entries.get(id))?.fields,
		/** Every save of a word fails until `restore` is called. */
		failSaves() {
			const table = folder.tables.entries;
			const set = table.set;
			table.set = async () =>
				Err({
					name: 'StorageFailed',
					message: 'Repository save failed: storage refused',
					cause: new Error('storage refused'),
				} as SaveError);
			return () => {
				table.set = set;
			};
		},
		async [Symbol.asyncDispose]() {
			confirmationDialog.close();
			void unmount(card);
			unsubscribe();
			target.remove();
			await opened[Symbol.asyncDispose]();
			await browser[Symbol.asyncDispose]();
		},
	};
}

test('the note is editable at once, and saved after a pause in typing', async () => {
	await using context = await setup('lucid');
	const note = context.note();
	expect(note?.readOnly).toBe(false);
	type(note, 'c');
	type(note, 'clear');
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('');
	await until(
		() => !context.vocab.entries.draftOf(cached(context.vocab, 'lucid').id).held,
		'the pause to end',
	);
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('clear');
});

test('leaving the note saves it at once, and so does the card going away', async () => {
	await using context = await setup('lucid', { saveAfterMs: 60_000 });
	type(context.note(), 'left');
	blur(context.note());
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('left');

	type(context.note(), 'gone');
	flushSync();
	context.unmount();
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('gone');
});

test('the typed note survives the list being read again before it is saved', async () => {
	await using context = await setup('lucid', { saveAfterMs: 60_000 });
	type(context.note(), 'mine');
	await context.vocab.queryClient.invalidateQueries();
	await quiet(context.vocab);
	flushSync();
	expect(context.note()?.value).toBe('mine');
	blur(context.note());
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('mine');
});

test('a stage press is saved at once, and keeps a note typed meanwhile', async () => {
	await using context = await setup('lucid', { saveAfterMs: 60_000 });
	type(context.note(), 'clear');
	click(context.target, 'Understand');
	await quiet(context.vocab);
	await until(
		() => !context.vocab.entries.draftOf(cached(context.vocab, 'lucid').id).held,
		'the stage to save',
	);
	expect(await context.saved()).toMatchObject({
		note: 'clear',
		stage: 'understood',
	});
	const pressed = [...context.target.querySelectorAll('button')].find(
		(button) => button.getAttribute('aria-pressed') === 'true',
	);
	expect(pressed?.textContent?.trim()).toBe('Understand');
	expect(context.note()?.value).toBe('clear');
});

test('a save that fails keeps the note on screen and says why, and Try again saves it', async () => {
	await using context = await setup('lucid', { saveAfterMs: 60_000 });
	const restore = context.failSaves();
	type(context.note(), 'kept');
	blur(context.note());
	await until(
		() => context.target.textContent?.includes('Not saved') ?? false,
		'the failure to show',
	);
	expect(context.target.textContent).toContain("This browser's storage refused it");
	expect(context.note()?.value).toBe('kept');
	expect((await context.saved())?.note).toBe('');

	restore();
	click(context.target, 'Try again');
	await until(
		() => !(context.target.textContent?.includes('Not saved') ?? true),
		'the failure to clear',
	);
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('kept');
	expect(context.note()?.value).toBe('kept');
});

test('Delete asks first; Cancel changes nothing, and confirming deletes the word', async () => {
	await using context = await setup('lucid');
	const before = await context.saved();
	click(context.target, 'Delete');
	expect(confirmationDialog.isOpen).toBe(true);
	expect(confirmationDialog.options?.title).toContain('lucid');
	confirmationDialog.cancel();
	await Bun.sleep(10);
	expect(await context.saved()).toEqual(before);

	click(context.target, 'Delete');
	await confirmationDialog.confirm();
	await quiet(context.vocab);
	expect(await context.saved()).toBeUndefined();
});
