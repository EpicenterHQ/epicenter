/**
 * Entry card tests.
 * The real `EntryCard` is mounted in jsdom over the real Vocab owner and its
 * query cache, on Vocab's real browser folder over an in-memory OPFS
 * stand-in that can fail a write. Each card is given its word from the
 * cached listing, as the words list gives it. Typing and pressing buttons
 * are DOM events. This shows what a delivered event does; jsdom has no
 * layout, focus, selection, or IME, so it says nothing about whether a
 * person can deliver it.
 *
 * Key behaviors:
 * - The note is editable at once and written a second after the last
 *   keystroke, or at once when the learner leaves it or the card goes away
 * - The typed note survives the list being read again before it is sent
 * - A stage press is written at once, and does not undo a note typed
 *   meanwhile
 * - A save that fails keeps the note on screen and is reported, and Try
 *   again writes it
 * - Delete asks first; Cancel changes nothing, and confirming deletes it
 *
 * The confirmation is the shared dialog's state, answered as its buttons
 * would; the dialog's own markup is not mounted here.
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { createFolderContext } from '@epicenter/svelte/folder';
import type { WriteFailure } from '@epicenter/svelte/write-failure';
import { expectOk } from 'wellcrafted/testing';
import { readEntry, readRows, type vocabFolder } from '../../lib/data.js';
import type { EntryListing } from '../../lib/entries.svelte.js';
import { createBrowser, fileText } from '../../lib/folder.test-support.js';
import { cached, observe, quiet } from '../../lib/query.test-support.js';
import { click, leave, type } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createVocab } = await import('../../lib/vocab.svelte.js');
const { confirmationDialog } = await import(
	'@epicenter/ui/confirmation-dialog'
);
const { cardProps } = await import('./card-props.test-support.svelte.js');
const { default: EntryCardHost } = await import(
	'./fixtures/EntryCardHost.svelte'
);

/** Let the folder answer and the card catch up. */
async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		flushSync();
		if (done()) return;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** One card for `text`, given its word from the cache whenever the cache changes. */
async function setup(text: string) {
	const browser = createBrowser();
	const folder = await browser.open();
	const failures: WriteFailure[] = [];
	const opened = createFolderContext<typeof vocabFolder>(folder, {
		writeFailed: (failure) => failures.push(failure),
	});
	const vocab = createVocab(opened);
	const stop = observe(vocab);
	await quiet(vocab);
	expectOk(await vocab.entries.add(text));
	await quiet(vocab);
	const props = cardProps(vocab.entries, cached(vocab, text));
	// The words list passes each card its word as the cache now holds it.
	const unsubscribe = vocab.queryClient.getQueryCache().subscribe(() => {
		const listed = vocab.queryClient.getQueryData<EntryListing>(
			vocab.queries.entries.list.queryKey(),
		);
		const entry =
			listed &&
			readRows('entries', listed, readEntry).rows.find(
				(candidate) => candidate.text === text,
			);
		if (entry !== undefined) props.entry = entry;
	});
	const target = document.createElement('div');
	document.body.append(target);
	const card = mount(EntryCardHost, {
		target,
		props: { client: vocab.queryClient, card: props },
	});
	flushSync();
	const path = cached(vocab, text).stored.path;
	const note = () =>
		target.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="Your note for ${text}"]`,
		) ?? undefined;
	return {
		folder,
		vocab,
		target,
		failures,
		path,
		note,
		/** Take the card away, as the list does when the word leaves it. */
		unmount: () => void unmount(card),
		file: () => fileText(folder, path),
		/** The next write of the word's file fails. */
		failWrite() {
			browser.opfs.faults.write = (key) => {
				if (!key.endsWith(path)) return undefined;
				browser.opfs.faults.write = undefined;
				return 'fail';
			};
		},
		async [Symbol.asyncDispose]() {
			confirmationDialog.close();
			void unmount(card);
			unsubscribe();
			stop();
			target.remove();
			await opened.close();
			await browser[Symbol.asyncDispose]();
		},
	};
}

test('the note is editable at once, and written a second after the last keystroke', async () => {
	await using context = await setup('lucid');
	const note = context.note();
	expect(note?.readOnly).toBe(false);
	type(note, 'c');
	type(note, 'clear');
	await quiet(context.vocab);
	expect(await context.file()).not.toContain('note: clear');
	await Bun.sleep(1100);
	await quiet(context.vocab);
	expect(await context.file()).toContain('note: clear');
	expect(context.failures).toEqual([]);
});

test('leaving the note writes it at once, and so does the card going away', async () => {
	await using context = await setup('lucid');
	type(context.note(), 'left');
	leave(context.note());
	await quiet(context.vocab);
	expect(await context.file()).toContain('note: left');

	type(context.note(), 'gone');
	flushSync();
	context.unmount();
	await quiet(context.vocab);
	expect(await context.file()).toContain('note: gone');
});

test('the typed note survives the list being read again before it is sent', async () => {
	await using context = await setup('lucid');
	type(context.note(), 'mine');
	await context.vocab.queryClient.invalidateQueries(
		context.vocab.queries.pathFilter([context.path]),
	);
	await quiet(context.vocab);
	flushSync();
	expect(context.note()?.value).toBe('mine');
	leave(context.note());
	await quiet(context.vocab);
	expect(await context.file()).toContain('note: mine');
});

test('a stage press is written at once, and does not undo a note typed meanwhile', async () => {
	await using context = await setup('lucid');
	type(context.note(), 'clear');
	click(context.target, 'Understand');
	await quiet(context.vocab);
	flushSync();
	expect(await context.file()).toContain('stage: understood');
	const pressed = [...context.target.querySelectorAll('button')].find(
		(button) => button.getAttribute('aria-pressed') === 'true',
	);
	expect(pressed?.textContent?.trim()).toBe('Understand');
	expect(context.note()?.value).toBe('clear');

	leave(context.note());
	await quiet(context.vocab);
	const file = await context.file();
	expect(file).toContain('note: clear');
	expect(file).toContain('stage: understood');
});

test('a save that fails keeps the note on screen and is reported, and Try again writes it', async () => {
	await using context = await setup('lucid');
	context.failWrite();
	type(context.note(), 'kept');
	leave(context.note());
	await quiet(context.vocab);
	flushSync();
	expect(context.note()?.value).toBe('kept');
	expect(context.failures.map((failure) => failure.path)).toEqual([
		context.path,
	]);
	expect(await context.file()).not.toContain('kept');

	// TanStack hands the card its mutation's failure on a later turn.
	await until(
		() =>
			[...context.target.querySelectorAll('button')].some(
				(button) => button.textContent?.trim() === 'Try again',
			),
		'Try again',
	);
	click(context.target, 'Try again');
	await quiet(context.vocab);
	await until(
		() => context.note()?.value === 'kept',
		'the saved note in the list',
	);
	expect(await context.file()).toContain('note: kept');
});

test('Delete asks first; Cancel changes nothing, and confirming deletes the word', async () => {
	await using context = await setup('lucid');
	const before = await context.file();
	click(context.target, 'Delete');
	expect(confirmationDialog.isOpen).toBe(true);
	expect(confirmationDialog.options?.title).toContain('lucid');
	confirmationDialog.cancel();
	await Bun.sleep(10);
	expect(await context.file()).toBe(before);

	click(context.target, 'Delete');
	await confirmationDialog.confirm();
	await quiet(context.vocab);
	expect(await context.file()).toBeUndefined();
});
