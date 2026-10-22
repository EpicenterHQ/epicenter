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
 *   last keystroke, even after the card goes away
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
import { expectOk } from 'wellcrafted/testing';
import {
	blur,
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import type { EntryRows } from '../../lib/entries.svelte.js';
import { cached, openVocab, quiet } from '../../lib/query.test-support.js';

const { flushSync, mount, unmount, tick } = await import('svelte');
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
	const folder = await browser.open({ saveAfterMs });
	const opened = await openVocab(folder);
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
	let mounted = true;
	async function leaveCard() {
		if (!mounted) return;
		mounted = false;
		await unmount(card);
	}
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
		unmount: leaveCard,
		/** The word's fields as its file holds them, or `undefined` when it is gone. */
		saved: async () => expectOk(await folder.tables.entries.get(id))?.fields,
		/** Every save fails, as a full browser store answers, until `restore` is called. */
		failSaves() {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = () => {
				throw new DOMException('storage refused', 'QuotaExceededError');
			};
			return () => {
				IDBObjectStore.prototype.put = put;
			};
		},
		async [Symbol.asyncDispose]() {
			confirmationDialog.close();
			await leaveCard();
			unsubscribe();
			target.remove();
			await opened[Symbol.asyncDispose]();
			await browser[Symbol.asyncDispose]();
		},
	};
}

/** What the folder holds typed into `lucid` and not saved yet. */
const held = ({ folder, vocab }: Awaited<ReturnType<typeof setup>>) =>
	folder.tables.entries.document(cached(vocab, 'lucid').id).getSnapshot();

test('the note is editable at once, and saved after a pause in typing', async () => {
	await using context = await setup('lucid');
	const note = context.note();
	expect(note?.readOnly).toBe(false);
	type(note, 'c');
	type(note, 'clear');
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('');
	await until(() => !held(context).isDirty, 'the pause to end');
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('clear');
});

test('blur and leaving the card keep the owner’s autosave timer', async () => {
	await using context = await setup('lucid', { saveAfterMs: 100 });
	type(context.note(), 'left');
	blur(context.note());
	expect(held(context).isSaving).toBe(false);
	await context.unmount();
	expect(held(context).isSaving).toBe(false);
	expect((await context.saved())?.note).toBe('');
	await until(() => !held(context).isDirty, 'autosave after leaving the card');
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('left');
});

test('the typed note survives the list being read again before it is saved', async () => {
	await using context = await setup('lucid', { saveAfterMs: 60_000 });
	type(context.note(), 'mine');
	await context.vocab.queryClient.invalidateQueries();
	await quiet(context.vocab);
	flushSync();
	expect(context.note()?.value).toBe('mine');
	await context.folder.tables.entries
		.document(cached(context.vocab, 'lucid').id)
		.save();
	await quiet(context.vocab);
	expect((await context.saved())?.note).toBe('mine');
});

test('a stage press is saved at once, and keeps a note typed meanwhile', async () => {
	await using context = await setup('lucid', { saveAfterMs: 60_000 });
	type(context.note(), 'clear');
	click(context.target, 'Understand');
	await quiet(context.vocab);
	await until(() => !held(context).isDirty, 'the stage to save');
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
	await using context = await setup('lucid');
	const restore = context.failSaves();
	type(context.note(), 'kept');
	blur(context.note());
	await until(
		() => context.target.textContent?.includes('Not saved') ?? false,
		'the failure to show',
	);
	expect(context.target.textContent).toContain(
		"This browser's storage refused it",
	);
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

test('a valid unsaved repair opens its structured controls even when saving fails', async () => {
	await using browser = createBrowser();
	const folder = await browser.open({ saveAfterMs: 60_000 });
	const broken =
		'---\ntext: lucid\nnote: ""\nstage: invalid\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\n';
	expectOk(await folder.files.write('entries/broken.md', broken));
	await using opened = await openVocab(folder);
	const { default: WordsViewHost } = await import(
		'./fixtures/WordsViewHost.svelte'
	);
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(WordsViewHost, {
		target,
		props: { client: opened.vocab.queryClient, entries: opened.vocab.entries },
	});
	const put = IDBObjectStore.prototype.put;
	try {
		await until(
			() => target.textContent?.includes('Repair as text') ?? false,
			'the repair action',
		);
		click(target, 'Repair as text');
		await until(
			() =>
				target.querySelector(
					'textarea[aria-label="File text for entries/broken.md"]',
				) !== null,
			'the source editor',
		);
		IDBObjectStore.prototype.put = () => {
			throw new DOMException('storage refused', 'QuotaExceededError');
		};
		type(
			target.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="File text for entries/broken.md"]',
			) ?? undefined,
			broken.replace('stage: invalid', 'stage: usable'),
		);
		await until(
			() => target.textContent?.includes('Show note and stage') ?? false,
			'live valid diagnostics',
		);
		click(target, 'Show note and stage');
		await until(
			() =>
				target.querySelector('textarea[aria-label="Your note for lucid"]') !==
				null,
			'the structured editor',
		);
		expect(opened.vocab.entries.repair.open).toBeUndefined();
		expect(
			(await folder.tables.entries.get('broken')).data?.fields?.stage,
		).toBe('invalid');
		expect(folder.tables.entries.document('broken').getSnapshot().isDirty).toBe(
			true,
		);
	} finally {
		IDBObjectStore.prototype.put = put;
		await unmount(view);
		target.remove();
	}
});

test('an orphan failure card follows current editor text for Copy and Discard', async () => {
	await using browser = createBrowser();
	const folder = await browser.open({ saveAfterMs: 60_000 });
	await using opened = await openVocab(folder);
	expectOk(await opened.vocab.entries.add('lucid'));
	const id = cached(opened.vocab, 'lucid').id;
	const edit = folder.tables.entries.document(id);
	const target = document.createElement('div');
	document.body.append(target);
	const { default: WordsViewHost } = await import(
		'./fixtures/WordsViewHost.svelte'
	);
	const acquire = opened.vocab.entries.document;
	let starts = 0;
	let stops = 0;
	opened.vocab.entries.document = (id) => {
		const document = acquire(id);
		return {
			...document,
			subscribe(listener) {
				starts++;
				const stop = document.subscribe(listener);
				return () => {
					stops++;
					stop();
				};
			},
		};
	};
	const view = mount(WordsViewHost, {
		target,
		props: { client: opened.vocab.queryClient, entries: opened.vocab.entries },
	});
	const put = IDBObjectStore.prototype.put;
	const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	const copied: string[] = [];
	try {
		IDBObjectStore.prototype.put = () => {
			throw new DOMException('storage refused', 'QuotaExceededError');
		};
		expectOk(edit.replace('\uFEFForphan A\r\n'));
		expect((await edit.save()).error).not.toBeNull();
		await until(
			() => target.querySelector('[aria-label="Unsaved change"]') !== null,
			'the orphan failure card',
		);

		await tick();
		const beforeTyping = { starts, stops };
		expectOk(edit.replace('\uFEFForphan newest\r\n'));
		flushSync();
		expect(
			target.querySelector('[aria-label="Unsaved change"]')?.textContent,
		).toBe('\uFEFForphan newest\r\n');
		await tick();
		expect({ starts, stops }).toEqual(beforeTyping);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: async (text: string) => void copied.push(text) },
		});
		target.querySelector<HTMLButtonElement>('button[name="copy"]')?.click();
		await until(() => copied.length === 1, 'the current orphan text to copy');
		expect(copied).toEqual(['\uFEFForphan newest\r\n']);

		click(target, 'Discard');
		await until(
			() => target.querySelector('[aria-label="Unsaved change"]') === null,
			'the orphan failure card to leave',
		);
		expect(edit.getSnapshot().isDirty).toBe(false);
	} finally {
		IDBObjectStore.prototype.put = put;
		if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
		else Object.defineProperty(navigator, 'clipboard', clipboard);
		await unmount(view);
		await tick();
		opened.vocab.entries.document = acquire;
		expect(stops).toBe(starts);
		target.remove();
	}
});

test('Save again publishes the current orphan text and clears its failure card', async () => {
	await using browser = createBrowser();
	const folder = await browser.open({ saveAfterMs: 60_000 });
	await using opened = await openVocab(folder);
	expectOk(await opened.vocab.entries.add('lucid'));
	const edit = folder.tables.entries.document(cached(opened.vocab, 'lucid').id);
	const target = document.createElement('div');
	document.body.append(target);
	const { default: WordsViewHost } = await import(
		'./fixtures/WordsViewHost.svelte'
	);
	const view = mount(WordsViewHost, {
		target,
		props: { client: opened.vocab.queryClient, entries: opened.vocab.entries },
	});
	const put = IDBObjectStore.prototype.put;
	try {
		IDBObjectStore.prototype.put = () => {
			throw new DOMException('storage refused', 'QuotaExceededError');
		};
		expectOk(edit.replace('orphan failed\n'));
		expect((await edit.save()).error).not.toBeNull();
		await until(
			() => target.querySelector('[aria-label="Unsaved change"]') !== null,
			'the orphan failure card',
		);
		expectOk(edit.replace('orphan saved\n'));
		IDBObjectStore.prototype.put = put;
		click(target, 'Save again');
		await until(
			() => target.querySelector('[aria-label="Unsaved change"]') === null,
			'the saved orphan failure card to leave',
		);
		await until(
			() => !edit.getSnapshot().isSaving && !edit.getSnapshot().isDirty,
			'the current orphan text to save',
		);
		expect(edit.getSnapshot()).toMatchObject({
			isDirty: false,
			content: { text: 'orphan saved\n' },
		});
	} finally {
		IDBObjectStore.prototype.put = put;
		await unmount(view);
		target.remove();
	}
});

test('focus-word views follow input without rebuilding subscriptions and release on unmount', async () => {
	await using browser = createBrowser();
	const folder = await browser.open({ saveAfterMs: 60_000 });
	await using opened = await openVocab(folder);
	const { entries, queryClient } = opened.vocab;
	expectOk(await entries.add('lucid'));
	const id = cached(opened.vocab, 'lucid').id;
	const acquire = entries.document;
	const starts: string[] = [];
	const stops: string[] = [];
	entries.document = (id) => {
		const document = acquire(id);
		return {
			...document,
			subscribe(listener) {
				starts.push(id);
				const stop = document.subscribe(listener);
				return () => {
					stops.push(id);
					stop();
				};
			},
		};
	};
	const { default: FocusWordsHost } = await import(
		'./fixtures/FocusWordsHost.svelte'
	);
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(FocusWordsHost, {
		target,
		props: {
			client: queryClient,
			entries,
			focus: [
				{ entryId: id, text: 'lucid' },
				{ entryId: 'missing', text: 'absent' },
			],
		},
	});
	try {
		await until(
			() => target.querySelector('[aria-pressed="true"]') !== null,
			'the current stage',
		);
		expect(starts).toEqual([id]);
		const edit = folder.tables.entries.document(id);
		for (const stage of ['recognized', 'understood', 'usable'] as const) {
			expectOk(edit.patch({ fields: { stage } }));
			flushSync();
			await tick();
		}
		expect(target.querySelector('[aria-pressed="true"]')?.textContent).toBe(
			'Use',
		);
		expect(starts).toEqual([id]);
		expect(stops).toEqual([]);
	} finally {
		await unmount(view);
		await tick();
		entries.document = acquire;
		target.remove();
	}
	expect(stops).toEqual(starts);
});
