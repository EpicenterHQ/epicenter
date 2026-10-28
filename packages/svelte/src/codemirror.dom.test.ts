/**
 * Source Editor Tests
 *
 * `createSourceEditor` over jsdom, bound to a file held open in a real
 * repository engine on `bun:sqlite` with no server. jsdom has no layout, so
 * these prove the text, the saves and what is held back, not what a person
 * sees; the apps' Playwright tests cover that.
 *
 * Key behaviors:
 * - Every keystroke saves while the frontmatter keeps parsing
 * - A text that would break frontmatter that parses is held back, and saved once it parses again
 * - A file that does not parse saves every step of its repair
 * - A change from elsewhere merges under held-back typing, which survives it
 * - A text the repository refuses to store stays in the editor and is not sent again
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { defineApp, offlineTransport, openRepository } from '@epicenter/repository';
import { openBunSqlite } from '@epicenter/repository/bun';
import { Type } from 'typebox';
import { createSourceEditor } from './codemirror.js';

// SAFETY: jsdom has no layout; the empty list supplies only the geometry CodeMirror asks for.
Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
// SAFETY: jsdom has no layout; this rectangle stands for an unmeasured range.
Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.String() }) } });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanups.splice(0).reverse()) await step();
	document.body.replaceChildren();
});

/** A file on a device, held open, with the source editor over it. */
async function sourceOver(text: string) {
	const repo = openRepository({ app, driver: openBunSqlite(), transport: offlineTransport });
	cleanups.push(() => repo.close());
	await repo.files.writeText('notes/a.md', text);
	const file = await repo.files.open('notes/a.md');
	cleanups.push(() => file.close());
	const parent = document.createElement('div');
	document.body.append(parent);
	const shown: { text: string; held: boolean }[] = [];
	const editor = createSourceEditor({
		parent,
		file,
		parses: (candidate) => repo.files.status(candidate).parses,
		onText: (next, held) => shown.push({ text: next, held }),
	});
	cleanups.push(() => editor.destroy());
	/** Replace `from` with `to` in the editor, as typing does. */
	const type = (from: string, to: string) => {
		const at = editor.view.state.sliceDoc().indexOf(from);
		editor.view.dispatch({ changes: { from: at, to: at + from.length, insert: to }, userEvent: 'input.type' });
	};
	return { repo, file, editor, type, shown, stored: () => repo.files.readText('notes/a.md') };
}

test('a text that would break frontmatter that parses is held back, and saved once it parses again', async () => {
	const t = await sourceOver('---\ntitle: Plan\n---\nBody\n');
	t.type('Plan', 'Plans');
	expect(await t.stored()).toBe('---\ntitle: Plans\n---\nBody\n');
	t.type('Plans', '[Plans');
	expect(t.shown.at(-1)).toEqual({ text: '---\ntitle: [Plans\n---\nBody\n', held: true });
	expect(await t.stored()).toBe('---\ntitle: Plans\n---\nBody\n');
	t.type('[Plans', '[Plans]');
	expect(t.shown.at(-1)?.held).toBe(false);
	await t.repo.flush();
	expect(await t.stored()).toBe('---\ntitle: [Plans]\n---\nBody\n');
});

test('a file that does not parse saves every step of its repair', async () => {
	const t = await sourceOver('---\ntitle: [\n---\nBody\n');
	t.type('[', '[Pl');
	expect(t.shown.at(-1)?.held).toBe(false);
	expect(await t.stored()).toBe('---\ntitle: [Pl\n---\nBody\n');
	t.type('[Pl', 'Plan');
	expect(await t.stored()).toBe('---\ntitle: Plan\n---\nBody\n');
	expect((await t.repo.notes.get({ stem: 'a' }))?.valid).toBe(true);
});

test('a change from elsewhere merges under held-back typing, which survives it', async () => {
	const t = await sourceOver('---\ntitle: Plan\n---\nBody\n');
	t.type('Plan', '[Plan');
	await t.repo.files.writeText('notes/a.md', '---\ntitle: Plan\n---\nBody\nMore from elsewhere\n');
	await t.repo.flush();
	expect(t.editor.view.state.sliceDoc()).toBe('---\ntitle: [Plan\n---\nBody\nMore from elsewhere\n');
	expect(t.shown.at(-1)?.held).toBe(true);
	expect(await t.stored()).toBe('---\ntitle: Plan\n---\nBody\nMore from elsewhere\n');
});

test('a text the repository refuses to store stays in the editor and is not sent again', async () => {
	const t = await sourceOver('---\ntitle: Plan\n---\nBody\n');
	const large = 'x'.repeat(1024 * 1024);
	t.type('Body', large);
	await t.repo.flush();
	expect(t.editor.view.state.sliceDoc()).toBe(`---\ntitle: Plan\n---\n${large}\n`);
	expect(await t.stored()).toBe('---\ntitle: Plan\n---\nBody\n');
	expect(await t.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 1 }]);
});
