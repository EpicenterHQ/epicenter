/**
 * Editor Tests
 *
 * One editor per note, over its exact text, shared by every view of it (a
 * body view shows the same draft's body): it owns the draft and the last
 * text the worker confirmed, sends one write at a time over that text with
 * the keystrokes since coalesced, and carries what was typed while a write
 * was in flight onto the worker's resulting text by position.
 *
 * Key behaviors:
 * - K1 against a remote same-line edit, then K2, K3 and a field patch while K1 is in flight: one conflict block, every keystroke, the fields kept
 * - A remote same-line edit landing between two of the person's writes: still one conflict block, holding every keystroke
 * - Typing on another line than a remote edit merges clean; a clean editor follows remote changes, and one heard during a write is taken after its answer
 * - Typing that touches what the worker changed pauses autosave with both kept, until resolved
 * - A note deleted elsewhere while the person types comes back with their typing
 * - A refused write, a worker lost mid-write, a close that cannot save and a repository closed (an account change) all keep the draft
 * - Views of one note share its editor, body and source alike: the last to close saves
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { applyChanges } from '../core/diff.js';
import { findConflicts } from '../core/conflict.js';
import { defineApp } from '../core/lens.js';
import { bodyOf, parseMarkdown, withBody } from '../core/markdown.js';
import { settled, twoDevices } from './api.test-support.js';

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.String(), pinned: Type.Optional(Type.Boolean()) }) } });
const PATH = 'notes/plan.md';
const note = (body: string, title = 'Base') => `---\ntitle: ${title}\n---\n${body}`;

test('K1 against a remote same-line edit, then K2, K3 and a field patch while K1 is in flight: one conflict block, every keystroke, the fields kept', async () => {
	const { alice, bob, gate, repo } = twoDevices(app);
	alice.replica.write(PATH, note('one'));
	alice.sync();
	bob.catchUp();
	await settled();
	const editor = expectOk(await repo.notes.openEditor({ stem: 'plan' }));
	expect(editor.draft()).toBe(note('one'));

	// Bob changes the same line, and the title; Alice's replica has it before her first keystroke reaches it.
	bob.replica.write(PATH, note('oneR', 'Remote'));
	bob.sync();
	alice.catchUp();
	gate.hold();
	editor.update(note('oneA'));
	await settled();
	// K1 is in flight. Alice types on, and pins the note.
	editor.update(note('oneAB'));
	void repo.notes.patch({ stem: 'plan' }, { pinned: true });
	editor.update(note('oneABC'));
	gate.release();
	await settled();
	await settled();

	const text = alice.replica.read(PATH) ?? '';
	const blocks = findConflicts(text);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]).toMatchObject({ current: 'oneR\n', base: 'one\n', incoming: 'oneABC\n' });
	expect(parseMarkdown(text).data?.fields).toEqual({ title: 'Remote', pinned: true });
	expect(editor.draft()).toBe(text);
	expect(editor.state()).toEqual({ status: 'saved' });
	expect(repo.notes.get({ stem: 'plan' })?.text).toBe(text);
});

/** A note with title Base, synced to both devices, and Alice's editor on it. */
async function opened(body: string) {
	const world = twoDevices(app);
	world.alice.replica.write(PATH, note(body));
	world.alice.sync();
	world.bob.catchUp();
	await settled();
	const editor = expectOk(await world.repo.notes.openEditor({ stem: 'plan' }));
	/** What a view would show: the draft as the editor replaced it, change by change. */
	let shown = editor.draft();
	editor.subscribe(({ replaced }) => {
		if (replaced !== null) shown = applyChanges(shown, replaced);
	});
	/** The person types the body `body`, in what they see. */
	const type = (body: string) => {
		shown = withBody(shown, body);
		editor.update(shown);
	};
	return { ...world, editor, type, shown: () => bodyOf(shown) };
}
const remote = (world: Awaited<ReturnType<typeof opened>>, body: string) => {
	world.bob.replica.write(PATH, note(body));
	world.bob.sync();
	world.alice.catchUp();
};

test("a remote same-line edit landing between two of the person's writes is one conflict block, holding all the typing", async () => {
	const world = await opened('one\n');
	world.type('oneA\n');
	await settled();
	await settled();
	// K2 is stored in the worker, its answer held, when Bob's edit of the same line arrives.
	world.gate.hold();
	world.type('oneAB\n');
	await settled();
	remote(world, 'oneR\n');
	await settled();
	// Alice keeps typing at the end of her line, in what she sees.
	world.type(world.shown().replace('oneAB\n', 'oneABC\n'));
	world.gate.release();
	await settled();
	await settled();
	await settled();
	const text = world.alice.replica.read(PATH) ?? '';
	expect(findConflicts(text)).toMatchObject([{ current: 'oneR\n', base: 'one\n', incoming: 'oneABC\n' }]);
	expect(world.editor.draft()).toBe(text);
	expect(world.shown()).toBe(bodyOf(text));
	expect(world.editor.state()).toEqual({ status: 'saved' });
});

test('typing on another line than a remote edit merges clean, with every keystroke', async () => {
	const world = await opened('alpha\nbeta\n');
	remote(world, 'alpha\nBETA\n');
	world.gate.hold();
	world.type('alphaX\nbeta\n');
	await settled();
	world.type('alphaXY\nbeta\n');
	world.gate.release();
	await settled();
	await settled();
	expect(world.alice.replica.read(PATH)).toBe(note('alphaXY\nBETA\n'));
	expect(world.editor.draft()).toBe(note('alphaXY\nBETA\n'));
	expect(world.shown()).toBe('alphaXY\nBETA\n');
});

test('a clean editor follows a remote change in place, and one heard while a write is in flight is taken after its answer', async () => {
	const world = await opened('alpha\nbeta\n');
	remote(world, 'alpha\nbeta\ngamma\n');
	await settled();
	expect(world.editor.draft()).toBe(note('alpha\nbeta\ngamma\n'));
	expect(world.shown()).toBe('alpha\nbeta\ngamma\n');
	world.gate.hold();
	world.type('ALPHA\nbeta\ngamma\n');
	await settled();
	// Stored after Alice's write, heard before its answer.
	remote(world, 'alpha\nbeta\ngamma\ndelta\n');
	await settled();
	world.gate.release();
	await settled();
	await settled();
	expect(world.editor.draft()).toBe(note('ALPHA\nbeta\ngamma\ndelta\n'));
	expect(world.shown()).toBe('ALPHA\nbeta\ngamma\ndelta\n');
	expect(world.editor.state()).toEqual({ status: 'saved' });
});

test('typing that touches what the worker changed pauses autosave with both kept, until resolved', async () => {
	const world = await opened('alpha\nbeta\n');
	remote(world, 'alpha\nBETA\n');
	world.gate.hold();
	world.type('alphaX\nbeta\n');
	await settled();
	// While K1 is in flight, Alice types inside the word Bob changed.
	world.type('alphaX\nbeXta\n');
	world.gate.release();
	await settled();
	await settled();
	expect(world.editor.state()).toEqual({ status: 'paused', theirs: note('alphaX\nBETA\n') });
	expect(world.editor.draft()).toBe(note('alphaX\nbeXta\n'));
	expect(world.alice.replica.read(PATH)).toBe(note('alphaX\nBETA\n'));
	world.editor.resolve(note('alphaX\nBEXTA\n'));
	await settled();
	expect(world.editor.state()).toEqual({ status: 'saved' });
	expect(world.alice.replica.read(PATH)).toBe(note('alphaX\nBEXTA\n'));
});

test('a note deleted elsewhere while the person types comes back with their typing', async () => {
	const world = await opened('one\n');
	world.gate.hold();
	world.type('one!\n');
	world.bob.replica.write(PATH, null);
	world.bob.sync();
	world.alice.catchUp();
	world.gate.release();
	await settled();
	await settled();
	expect(world.editor.state()).toEqual({ status: 'saved' });
	expect(world.alice.replica.read(PATH)).toBe(note('one!\n'));
	expect(world.repo.notes.get({ stem: 'plan' })?.body).toBe('one!\n');
});

test('a refused write keeps the draft, shown in the list too, and retry saves it', async () => {
	const world = await opened('one\n');
	world.alice.fail();
	world.type('one two\n');
	await settled();
	expect(world.editor.state()).toMatchObject({ status: 'failed', error: { name: 'Failed' } });
	expect(world.editor.draft()).toBe(note('one two\n'));
	// The repository dropped its projection of the write; the list still shows the typing.
	expect(world.repo.notes.get({ stem: 'plan' })?.body).toBe('one two\n');
	world.type('one two three\n');
	await settled();
	expect(world.editor.state().status).toBe('failed');
	world.alice.fail(false);
	world.editor.retry();
	await settled();
	expect(world.editor.state()).toEqual({ status: 'saved' });
	expect(world.alice.replica.read(PATH)).toBe(note('one two three\n'));
});

test('a worker lost mid-write keeps the draft, and the next session saves it once', async () => {
	const world = await opened('one\n');
	world.gate.hold();
	world.type('one two\n');
	await settled();
	world.type('one two three\n');
	world.local.end();
	world.gate.release();
	await settled();
	expect(world.editor.draft()).toBe(note('one two three\n'));
	expect(world.repo.notes.get({ stem: 'plan' })?.body).toBe('one two three\n');
	world.type('one two three four\n');
	world.local.resume();
	await settled();
	await settled();
	expect(world.editor.state()).toEqual({ status: 'saved' });
	expect(world.alice.replica.read(PATH)).toBe(note('one two three four\n'));
	expect(findConflicts(world.alice.replica.read(PATH) ?? '')).toEqual([]);
});

test('a close that cannot save reports the draft and keeps it, saved once a session opens', async () => {
	const world = await opened('one\n');
	world.local.end();
	world.type('one two\n');
	const closed = expectErr(await world.editor.close());
	expect(closed).toMatchObject({ name: 'Unsaved', draft: note('one two\n') });
	// Still there, shown in the list, and found by the next view that opens the note.
	expect(world.repo.notes.get({ stem: 'plan' })?.body).toBe('one two\n');
	const again = expectOk(await world.repo.notes.openEditor({ stem: 'plan' }));
	expect(again).toBe(world.editor);
	expect(again.draft()).toBe(note('one two\n'));
	world.local.resume();
	await settled();
	await settled();
	expect(world.alice.replica.read(PATH)).toBe(note('one two\n'));
	expectOk(await again.close());
});

test('an editor closed with typing unsaved leaves once a later session saves it', async () => {
	const world = await opened('one\n');
	world.local.end();
	world.type('one two\n');
	expect(expectErr(await world.editor.close()).name).toBe('Unsaved');
	world.local.resume();
	await settled();
	await settled();
	expect(world.alice.replica.read(PATH)).toBe(note('one two\n'));
	world.alice.sync();
	world.bob.catchUp();
	await settled();
	expect(world.repo.notes.get({ stem: 'plan' })?.state).toEqual({ status: 'synced' });
	// Gone: the list shows a change from elsewhere, the old handle does not follow it, and the next view gets a new editor.
	remote(world, 'bob\n');
	await settled();
	expect(world.repo.notes.get({ stem: 'plan' })?.body).toBe('bob\n');
	expect(world.editor.draft()).toBe(note('one two\n'));
	const next = expectOk(await world.repo.notes.openEditor({ stem: 'plan' }));
	expect(next).not.toBe(world.editor);
	expect(next.draft()).toBe(note('bob\n'));
});

test('a repository closed with typing unsaved (an account change) reports it, and the draft stays readable', async () => {
	const world = await opened('one\n');
	world.gate.hold();
	world.type('one two\n');
	await settled();
	world.type('one two three\n');
	const closing = world.editor.close();
	world.repo.close();
	expect(expectErr(await closing)).toMatchObject({ name: 'Unsaved', draft: note('one two three\n') });
	expect(world.editor.draft()).toBe(note('one two three\n'));
	expect(world.editor.state()).toEqual({ status: 'closed' });
});

test('views of one note share its editor, a body view and a source view alike: the last to close saves it', async () => {
	const world = await opened('one\n');
	const source = expectOk(await world.repo.notes.openEditor({ stem: 'plan' }));
	expect(source).toBe(world.editor);
	world.gate.hold();
	// The body view types; the source view sets a field on the same draft.
	world.type('one two\n');
	source.update(source.draft().replace('title: Base', 'title: Both'));
	await settled();
	expectOk(await source.close());
	const last = world.editor.close();
	world.gate.release();
	expectOk(await last);
	expect(world.alice.replica.read(PATH)).toBe(note('one two\n', 'Both'));
});
