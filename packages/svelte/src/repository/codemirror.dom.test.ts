/**
 * Repository Editor Binding Tests
 *
 * `createEditorView` over jsdom, bound to a repository editor on a replica
 * in this process. jsdom has no layout, so these prove the texts, not what
 * a person sees; the Playwright page covers that.
 *
 * Key behaviors:
 * - A body view and a source view of one note are views of one editor: typing in either shows in the other, and a field set in the source never reaches the body view
 * - A change from elsewhere reaches a body view in the body's positions
 */
import '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { defineApp, openLocalRepository } from '@epicenter/repository/api';
import { openBunSqlite } from '@epicenter/repository/bun';
import { openReplica } from '@epicenter/repository/client';
import { Type } from 'typebox';
import { unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createEditorView } from './codemirror.js';

// SAFETY: jsdom has no layout; the empty list supplies only the geometry CodeMirror asks for.
Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
// SAFETY: jsdom has no layout; this rectangle stands for an unmeasured range.
Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.String() }) } });
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const cleanups: (() => unknown)[] = [];
afterEach(() => {
	for (const step of cleanups.splice(0).reverse()) step();
	document.body.replaceChildren();
});

async function twoViews() {
	const replica = unwrap(openReplica({ driver: openBunSqlite(), binding: { repository: 'r', server: null, account: null }, device: 'd', app, after: () => {}, now: () => 0 }));
	const repo = openLocalRepository({ app, replica });
	cleanups.push(() => repo.close());
	await settled();
	expectOk(await repo.notes.create({ stem: 'plan' }, { fields: { title: 'Plan' }, body: 'one\ntwo\n' }));
	const editor = expectOk(await repo.notes.openEditor({ stem: 'plan' }));
	const view = (shows: 'body' | 'source') => {
		const parent = document.createElement('div');
		document.body.append(parent);
		const created = createEditorView({ parent, editor, shows });
		cleanups.push(() => created.destroy());
		return created;
	};
	return { repo, replica, editor, body: view('body'), source: view('source') };
}

test('a body view and a source view of one note are views of one editor', async () => {
	const { replica, editor, body, source } = await twoViews();
	expect(body.state.doc.toString()).toBe('one\ntwo\n');
	expect(source.state.doc.toString()).toBe('---\ntitle: Plan\n---\none\ntwo\n');
	// Typing at the end of the body's first line.
	body.dispatch({ changes: { from: 3, insert: '!' }, userEvent: 'input.type' });
	expect(source.state.doc.toString()).toBe('---\ntitle: Plan\n---\none!\ntwo\n');
	// A field set in the source view never reaches the body view.
	source.dispatch({ changes: { from: 11, to: 15, insert: 'Both' }, userEvent: 'input.type' });
	expect(body.state.doc.toString()).toBe('one!\ntwo\n');
	expect(editor.draft()).toBe('---\ntitle: Both\n---\none!\ntwo\n');
	await settled();
	await settled();
	expect(replica.read('notes/plan.md')).toBe('---\ntitle: Both\n---\none!\ntwo\n');
});

test("a change from elsewhere reaches a body view in the body's positions", async () => {
	const { repo, body, source } = await twoViews();
	expectOk(await repo.notes.write({ stem: 'plan' }, '---\ntitle: Elsewhere\n---\none\nTWO\n'));
	await settled();
	expect(body.state.doc.toString()).toBe('one\nTWO\n');
	expect(source.state.doc.toString()).toBe('---\ntitle: Elsewhere\n---\none\nTWO\n');
});
