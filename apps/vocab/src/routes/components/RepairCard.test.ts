/**
 * A word note that does not read, repaired from the Words view.
 *
 * Key behaviors:
 * - The note is listed by path, and Repair as text opens its text
 * - Save repair writes the fixed text in house style, and the card gives
 *   way to the word once it reads
 * - Switching repairs shows the selected note's text
 * - A note deleted elsewhere while open says so, and the card closes
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { openVocabFolder, until } = await import(
	'../../lib/vocab.test-support.js'
);
const { createEntries } = await import('../../lib/entries.svelte.js');
const { flushSync, mount, unmount } = await import('svelte');
const { default: WordsViewHost } = await import(
	'./fixtures/WordsViewHost.svelte'
);

const word = (text: string, body = '') =>
	`---\ntext: ${text}\nstage: new\ncreatedAt: "2026-01-01T00:00:00.000Z"\n---\n${body}`;

async function setup(initial: Record<string, string>) {
	const folder = await openVocabFolder(initial);
	const entries = createEntries(folder.lists.entries);
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(WordsViewHost, { target, props: { entries } });
	await until(() => entries.repairs.length > 0);
	return {
		folder,
		entries,
		target,
		textOf: (path: string) =>
			target.querySelector<HTMLTextAreaElement>(
				`textarea[aria-label="Text of ${path}"]`,
			),
		async [Symbol.asyncDispose]() {
			await unmount(mounted);
			target.remove();
			await folder[Symbol.asyncDispose]();
		},
	};
}

test('a broken word is repaired as text and shows as a word again', async () => {
	await using context = await setup({
		'entries/broken.md': '---\ntext: [lucid\n---\nclear',
	});
	const { target, entries, folder } = context;
	expect(target.textContent).toContain('entries/broken.md');
	click(target, 'Repair as text');
	flushSync();
	const text = context.textOf('entries/broken.md');
	expect(text?.value).toBe('---\ntext: [lucid\n---\nclear');

	type(text, word('lucid', 'clear'));
	flushSync();
	expect(target.textContent).toContain('This text reads.');
	click(target, 'Save repair');
	await until(() => entries.repair.open === undefined);
	expect(await folder.text('entries/broken.md')).toBe(word('lucid', 'clear'));
	expect(entries.repairs).toEqual([]);
	expect(entries.words[0]).toMatchObject({ id: 'broken', note: 'clear' });
	flushSync();
	expect(
		target.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="Your note for lucid"]',
		)?.value,
	).toBe('clear');
});

test('switching repairs shows the selected note’s text', async () => {
	await using context = await setup({
		'entries/a.md': 'broken a',
		'entries/b.md': 'broken b',
	});
	await until(() => context.entries.repairs.length === 2);
	context.entries.repair.start('a');
	flushSync();
	type(context.textOf('entries/a.md'), 'changed a');
	context.entries.repair.start('b');
	flushSync();
	expect(context.textOf('entries/a.md')).toBeNull();
	expect(context.textOf('entries/b.md')?.value).toBe('broken b');
	// Nothing typed is written until it is saved.
	expect(await context.folder.text('entries/a.md')).toBe('broken a');
});

test('a note deleted elsewhere while open says so, and the card closes', async () => {
	await using context = await setup({ 'entries/broken.md': 'broken' });
	context.entries.repair.start('broken');
	flushSync();
	const other = await context.folder.other();
	const listed = await other.entries.list();
	const broken = listed.data?.invalid[0];
	if (broken?.id !== 'broken') throw new Error('the broken note is not listed');
	await other.entries.delete({ id: 'broken' }, { over: broken.version });
	await until(
		() => context.target.textContent?.includes('is no longer here') ?? false,
	);
	click(context.target, 'Close');
	expect(context.entries.repair.open).toBeUndefined();
});
