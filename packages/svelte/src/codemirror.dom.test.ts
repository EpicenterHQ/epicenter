/**
 * Source Editor Tests
 *
 * `createSourceEditor` over jsdom, bound to a file held open in a real
 * repository engine on `bun:sqlite`, with no server or with a real one in
 * the same process. jsdom has no layout, so these prove the text and the
 * saves, not what a person sees; the apps' Playwright tests cover that.
 *
 * Key behaviors:
 * - Every keystroke saves; one that would break frontmatter that parses is saved and held, and sent once it parses again
 * - A file that does not parse saves every step of its repair
 * - A change from elsewhere merges under held typing, which survives it
 * - A text the repository refuses to store stays in the editor and is not sent again
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp, offlineTransport, openRepository, type Transport } from '@epicenter/repository';
import { createInProcessTransport, openBunGitStore, openBunSqlite } from '@epicenter/repository/bun';
import { createRepositoryServer } from '@epicenter/repository/server';
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
async function sourceOver(text: string, transport: Transport = offlineTransport) {
	const repo = openRepository({ app, driver: openBunSqlite(), transport });
	cleanups.push(() => repo.close());
	await repo.files.writeText('notes/a.md', text);
	await repo.flush();
	const file = await repo.files.open('notes/a.md');
	cleanups.push(() => file.close());
	const parent = document.createElement('div');
	document.body.append(parent);
	const shown: string[] = [];
	const editor = createSourceEditor({ parent, file, onText: (next) => shown.push(next) });
	cleanups.push(() => editor.destroy());
	/** Replace `from` with `to` in the editor, as typing does. */
	const type = (from: string, to: string) => {
		const at = editor.view.state.sliceDoc().indexOf(from);
		editor.view.dispatch({ changes: { from: at, to: at + from.length, insert: to }, userEvent: 'input.type' });
	};
	return { repo, file, editor, type, shown, stored: () => repo.files.readText('notes/a.md') };
}

test('every keystroke saves; one that would break frontmatter that parses is saved and held, and sent once it parses again', async () => {
	const t = await sourceOver('---\ntitle: Plan\n---\nBody\n');
	t.type('Plan', 'Plans');
	expect((await t.stored())?.text).toBe('---\ntitle: Plans\n---\nBody\n');
	t.type('Plans', '[Plans');
	expect(t.shown.at(-1)).toBe('---\ntitle: [Plans\n---\nBody\n');
	expect(await t.stored()).toMatchObject({ text: '---\ntitle: [Plans\n---\nBody\n', sync: { state: 'held', reason: 'unparseable' } });
	expect(t.file.read()?.sync.state).toBe('held');
	t.type('[Plans', '[Plans]');
	await t.repo.flush();
	expect(await t.stored()).toMatchObject({ text: '---\ntitle: [Plans]\n---\nBody\n', sync: { state: 'sending' } });
	expect(t.file.read()?.sync.state).toBe('sending');
});

test('a file that does not parse saves every step of its repair', async () => {
	const t = await sourceOver('---\ntitle: [\n---\nBody\n');
	t.type('[', '[Pl');
	expect(await t.stored()).toMatchObject({ text: '---\ntitle: [Pl\n---\nBody\n', sync: { state: 'held' } });
	t.type('[Pl', 'Plan');
	expect(await t.stored()).toMatchObject({ text: '---\ntitle: Plan\n---\nBody\n', sync: { state: 'sending' } });
	expect((await t.repo.notes.get({ stem: 'a' }))?.valid).toBe(true);
});

test('a change from elsewhere merges under held typing, which survives it', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'source-editor-'));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const server = createRepositoryServer({ driver: openBunSqlite(), git: await openBunGitStore(join(dir, 'repo.git')) });
	const t = await sourceOver('---\ntitle: Plan\n---\nBody\n', createInProcessTransport(server, { user: 'alice' }));
	const bob = openRepository({ app, driver: openBunSqlite(), transport: createInProcessTransport(server, { user: 'bob' }) });
	cleanups.push(() => bob.close());
	await bob.flush();
	t.type('Plan', '[Plan');
	await t.repo.flush();
	expect(t.file.read()?.sync.state).toBe('held');
	expectSaved(await bob.files.writeText('notes/a.md', '---\ntitle: Plan\n---\nBody\nMore from elsewhere\n'));
	await bob.flush();
	await t.repo.flush();
	expect(t.editor.view.state.sliceDoc()).toBe('---\ntitle: [Plan\n---\nBody\nMore from elsewhere\n');
	expect(t.file.read()).toMatchObject({ text: '---\ntitle: [Plan\n---\nBody\nMore from elsewhere\n', sync: { state: 'held' } });
	expect(await server.read('notes/a.md')).toBe('---\ntitle: Plan\n---\nBody\nMore from elsewhere\n');
});

test('a text the repository refuses to store stays in the editor and is not sent again', async () => {
	const t = await sourceOver('---\ntitle: Plan\n---\nBody\n');
	const large = 'x'.repeat(1024 * 1024);
	t.type('Body', large);
	await t.repo.flush();
	expect(t.editor.view.state.sliceDoc()).toBe(`---\ntitle: Plan\n---\n${large}\n`);
	expect((await t.stored())?.text).toBe('---\ntitle: Plan\n---\nBody\n');
	expect(await t.repo.files.list({ sync: 'sending' })).toHaveLength(1);
});

function expectSaved({ error }: { error: unknown }) {
	expect(error).toBeNull();
}
