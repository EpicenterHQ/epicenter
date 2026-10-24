/**
 * Rich Text Tests
 *
 * Drives the rich-text view's two rules the way the view does, over the real
 * notes state and its query cache on Honeycrisp's folder: each transaction
 * goes through `stateAfter` before it is shown, and the body is followed
 * with `stateShowing`. The state the harness keeps is what the view would
 * display; the note's body draft holds an edit until its save lands, and
 * the cache holds the note after.
 *
 * Key behaviors:
 * - Every displayed edit is in the note, including spaces, Enter, and
 *   Shift-Enter, and saves the body alone: every field, and a key Honeycrisp
 *   does not declare, stays as it was
 * - Moving the cursor or setting pending formatting writes nothing, and is
 *   shown even while the note takes no edit
 * - An edit Markdown cannot express, or made while the note takes no edit,
 *   is refused before it is displayed
 * - A lone surrogate becomes U+FFFD in the same transaction, as the file
 *   stores it, so the screen shows what is saved
 * - A body read from a CRLF file shows and saves with line feeds
 * - The same content keeps the state, its cursor, pending formatting, and
 *   undo history; different content replaces it; a body that is not rich
 *   text is never written over
 * - A transaction built before the body changed is dropped
 * - A change another tab saved replaces a clean editor; a save landing
 *   does not
 * - A read that lands while an edit is held does not replace the typing;
 *   whole-file publication preserves accepted input and rich-text state
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { toggleMark } from 'prosemirror-commands';
import {
	closeHistory,
	redo,
	redoDepth,
	undo,
	undoDepth,
} from 'prosemirror-history';
import {
	type Command,
	EditorState,
	TextSelection,
	type Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { expectOk } from 'wellcrafted/testing';
import type { NotesFixture } from '../local.test-support.js';
import { bodyCodec, equivalentNoteDocs, parseNoteBody } from './markdown.js';
import { noteSchema } from './schema.js';

// The notes state is a runes module: load it, and the rules, after the
// compiler plugin.
const { openNotes, quiet, until, noteText, rows } = await import(
	'../local.test-support.ts'
);
const { editingPlugins, noteBody, stateAfter, stateShowing } = await import(
	'./rich-text.js'
);

const cleanup: (() => unknown)[] = [];

function parsed(folder: NotesFixture['folder'], text: string | undefined) {
	return text === undefined ? undefined : folder.tables.notes.parse(text);
}

afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

const PATH = 'notes/a.md';

/** The notes state over a folder holding one note with `text`, open as a note. */
async function noteOver(text: string) {
	const fixture = await openNotes();
	cleanup.push(() => fixture.close());
	await fixture.write(PATH, text);
	const { notes, local } = fixture;
	await notes.load();
	fixture.observe();
	notes.open(PATH);
	await quiet(notes);
	const note = notes.folder.tables.notes.document('a');
	cleanup.push(note.subscribe(() => {}));
	expectOk(await note.refresh());
	const opened = fixture.saves(PATH);
	return {
		fixture,
		notes,
		note,
		/** The saves that failed and still hold their typing. */
		failures: () => local.getStatus().failures,
		/** The note as shown now: with what is typed over it. */
		draft: () => {
			const row = parsed(notes.folder, note.getSnapshot().text);
			if (row?.issues !== null) throw new Error('The note is not in the cache');
			return row;
		},
		/** Flush pending input and let the resulting observations finish. */
		settled: async () => {
			if (note.getSnapshot().isDirty) await note.save();
			await quiet(notes);
		},
		/** Saves of the note since it opened. */
		writes: () => fixture.saves(PATH) - opened,
		/** The note's text in storage now. */
		stored: () => fixture.text(PATH),
		/** Close the notes: from now on the note takes no edit. */
		closeNotes: () => local.close(),
	};
}

/** One rich-text view over `body`, as the view holds it, and its note. */
async function open(
	initialBody: string,
	{ text = noteText({ body: initialBody }) } = {},
) {
	const opened = await noteOver(text);
	const { note, notes } = opened;
	const body = () =>
		noteBody(parsed(notes.folder, note.getSnapshot().text)) ?? '';
	const initial = bodyCodec.decode(body());
	if (!initial.supported) throw new Error('The note is not rich text');
	/** Why the last edit was refused. */
	let refusal: string | undefined;
	/** What the view displays. */
	let state = EditorState.create({
		doc: initial.doc,
		plugins: editingPlugins(),
	});
	/** Deliver a transaction as the view does. Returns whether it was displayed. */
	const dispatch = (transaction: Transaction) => {
		const next = stateAfter(
			state,
			transaction,
			note,
			notes.folder.tables.notes.parse,
			(reason) => {
				refusal = reason;
			},
		);
		if (next !== undefined) state = next;
		return next !== undefined;
	};
	const run = (command: Command) => {
		let displayed = false;
		command(state, (transaction) => {
			displayed = dispatch(transaction);
		});
		return displayed;
	};
	const type = (text: string) =>
		run((state, send) => {
			send?.(state.tr.insertText(text));
			return true;
		});
	/** A key, through the view's keymaps in order, as the view delivers it. */
	const press = (key: string, { shift = false } = {}) => {
		const event = {
			key,
			shiftKey: shift,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			keyCode: 0,
		} as KeyboardEvent;
		const view = {
			get state() {
				return state;
			},
			dispatch,
		} as unknown as EditorView;
		const handled = state.plugins.some((plugin) =>
			plugin.props.handleKeyDown?.call(plugin, view, event),
		);
		if (!handled) throw new Error(`Nothing handles ${key}`);
	};
	const end = () =>
		run((state, send) => {
			send?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));
			return true;
		});
	/** The view's effect after the body changed: show the note's body now. */
	const follow = () => {
		const now = bodyCodec.decode(body());
		if (now.supported) state = stateShowing(state, now.doc);
	};
	/** What the Source view, showing the note as it is now, does with typed text. */
	const source = (text: string) =>
		notes.folder.tables.notes.document('a').patch({ body: text });
	/** What is on screen and the note's body are the same content. */
	const expectNoteHoldsScreen = () =>
		expect(equivalentNoteDocs(parseNoteBody(body()), state.doc)).toBe(true);
	return {
		...opened,
		source,
		/** The state the view displays now. */
		shown: () => state,
		refusal: () => refusal,
		dispatch,
		run,
		type,
		press,
		end,
		follow,
		body,
		expectNoteHoldsScreen,
	};
}

describe('every displayed edit is in the note', () => {
	test('a trailing space is kept, on screen and in the note', async () => {
		const { type, body, refusal, expectNoteHoldsScreen, ...view } =
			await open('');
		expect(type('A')).toBe(true);
		expect(type(' ')).toBe(true);
		expect(refusal()).toBeUndefined();
		expect(view.shown().doc.textContent).toBe('A ');
		expect(body()).toBe('A&#32;\n');
		expect(parseNoteBody(body()).textContent).toBe('A ');
		expectNoteHoldsScreen();
		// The next letter makes the space ordinary again.
		type('b');
		expect(body()).toBe('A b\n');
	});

	test('leading spaces and tabs are kept', async () => {
		const { type, body, expectNoteHoldsScreen } = await open('');
		type('  ');
		type('\t');
		type('x');
		expect(parseNoteBody(body()).textContent).toBe('  \tx');
		expectNoteHoldsScreen();
	});

	test('Enter and Shift-Enter are displayed, and what Markdown cannot spell yet does not make the note newer', async () => {
		const {
			type,
			press,
			body,
			draft,
			settled,
			end,
			writes,
			expectNoteHoldsScreen,
			...view
		} = await open('one\n');
		end();
		const before = JSON.parse(JSON.stringify(draft()));
		press('Enter');
		expect(view.shown().doc.childCount).toBe(2);
		// An empty paragraph has no Markdown: the note, its time included, stays.
		expect(JSON.parse(JSON.stringify(draft()))).toEqual(before);
		await settled();
		expect(writes()).toBe(0);
		expectNoteHoldsScreen();
		type('two');
		expect(body()).toBe('one\n\ntwo\n');
		press('Enter', { shift: true });
		expect(body()).toBe('one\n\ntwo\n');
		type('three');
		expect(body()).toBe('one\n\ntwo\\\nthree\n');
		expectNoteHoldsScreen();
	});

	test('a space typed in pending bold is kept', async () => {
		const { type, run, body, expectNoteHoldsScreen, ...view } = await open('');
		run(toggleMark(noteSchema.marks.strong));
		type('bold');
		type(' ');
		expect(view.shown().doc.textContent).toBe('bold ');
		expect(parseNoteBody(body()).textContent).toBe('bold ');
		expectNoteHoldsScreen();
		type('more');
		expect(body()).toBe('**bold more**\n');
	});

	test('typing Markdown syntax as text stays text', async () => {
		const { type, body, expectNoteHoldsScreen, ...view } = await open('');
		for (const character of '<b> &amp; 1) *x* __y__ #') type(character);
		expect(view.shown().doc.textContent).toBe('<b> &amp; 1) *x* __y__ #');
		expect(parseNoteBody(body()).textContent).toBe('<b> &amp; 1) *x* __y__ #');
		expectNoteHoldsScreen();
	});

	test('lines typed like a table stay text, and the note stays rich text', async () => {
		const { type, press, body, follow, ...view } = await open('');
		type('a | b');
		press('Enter', { shift: true });
		type('|---|---|');
		expect(body()).toBe('a | b\\\n\\|---|---|\n');
		expect(bodyCodec.decode(body()).supported).toBe(true);
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
	});

	test('an edit saves the body once, and every field stays as it was (ADR-0573)', async () => {
		// An earlier Honeycrisp wrote `updatedAt`; it is now a key it does not declare.
		const edited = '"updatedAt": "2026-10-01T00:00:00.000Z"';
		const { type, draft, settled, failures, stored } = await open('one\n', {
			text: noteText({ body: 'one\n', extra: `${edited}\n"owner": "sam"\n` }),
		});
		const before = JSON.parse(JSON.stringify(draft()));
		type('x');
		expect(draft().body).toBe('xone\n');
		await settled();
		expect(failures()).toEqual([]);
		const row = draft();
		expect(row.body).toBe('xone\n');
		expect(row.fields).toEqual(before.fields);
		const saved = (await stored()) ?? '';
		expect(saved).toContain('xone');
		expect(saved).toMatch(/^"?updatedAt"?: "2026-10-01T00:00:00\.000Z"$/m);
		expect(saved).toMatch(/^"?owner"?: "?sam"?$/m);
	});

	test('a CRLF body shows and saves with line feeds, and its blank lines at the start are kept (ADR-0572)', async () => {
		const crlf = noteText({ body: '\none\n\ntwo\n' }).replace(/\n/g, '\r\n');
		const { type, end, body, settled, failures, stored, writes, note, notes } =
			await open('', {
				text: crlf,
			});
		expect(body()).toBe('\none\n\ntwo\n');
		expect(parsed(notes.folder, note.getSnapshot().text)?.body).toBe(
			'\r\none\r\n\r\ntwo\r\n',
		);
		expect(note.getSnapshot().text).toBe(crlf);
		expect(writes()).toBe(0);
		end();
		type('!');
		expect(body()).toBe('\none\n\ntwo!\n');
		await settled();
		expect(failures()).toEqual([]);
		const saved = (await stored()) ?? '';
		// The body after the closing `---` line has line feeds only.
		const savedBody = saved.slice(
			saved.indexOf('\n', saved.lastIndexOf('---')) + 1,
		);
		expect(savedBody).toBe('\none\n\ntwo!\n');
	});

	test('moving the cursor or setting pending formatting writes nothing', async () => {
		const { end, run, body, writes, settled, ...view } = await open('one\n');
		const before = body();
		end();
		expect(run(toggleMark(noteSchema.marks.em))).toBe(true);
		expect(view.shown().storedMarks?.map((mark) => mark.type)).toEqual([
			noteSchema.marks.em,
		]);
		expect(body()).toBe(before);
		await settled();
		expect(writes()).toBe(0);
	});

	test('moving the cursor is shown while the note takes no edit, and writes nothing', async () => {
		const { end, closeNotes, writes, ...view } = await open('one\n');
		const closed = closeNotes();
		expect(end()).toBe(true);
		expect(view.shown().selection.head).toBe(4);
		await closed;
		expect(writes()).toBe(0);
	});
});

describe('an edit that cannot be written', () => {
	test('one Markdown cannot express is refused before it is displayed, and says why', async () => {
		const { run, body, refusal, ...view } = await open('a(b)\n');
		const before = view.shown();
		// Bold on "(b)" directly after a letter has no Markdown spelling.
		const displayed = run((state, send) => {
			send?.(state.tr.addMark(2, 5, noteSchema.marks.strong.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(view.shown()).toBe(before);
		expect(body()).toBe('a(b)\n');
		expect(refusal()).toContain('cannot be written as Markdown');
	});

	test('a line break in a heading is refused; the heading text is untouched', async () => {
		const { run, body, ...view } = await open('# Title\n');
		const displayed = run((state, send) => {
			send?.(state.tr.insert(3, noteSchema.nodes.hard_break.create()));
			return true;
		});
		expect(displayed).toBe(false);
		expect(view.shown().doc.textContent).toBe('Title');
		expect(body()).toBe('# Title\n');
	});

	test('a lone surrogate is saved as U+FFFD, and the undo history survives it', async () => {
		const {
			dispatch,
			run,
			body,
			settled,
			failures,
			stored,
			expectNoteHoldsScreen,
			...view
		} = await open('Body.\n');
		expect(dispatch(view.shown().tr.insertText('x', 1))).toBe(true);
		// The next edit is its own undo step.
		expect(dispatch(closeHistory(view.shown().tr))).toBe(true);
		// Half of an emoji: Markdown can spell it, and the file stores it as U+FFFD.
		expect(dispatch(view.shown().tr.insertText('\uD800', 1))).toBe(true);
		expect(body()).toBe('\uFFFDxBody.\n');
		expect(view.shown().doc.textContent).toBe('\uFFFDxBody.');
		expectNoteHoldsScreen();
		await settled();
		expect(failures()).toEqual([]);
		expect(await stored()).toContain('\uFFFDxBody.');
		expect(undoDepth(view.shown())).toBe(2);
		expect(run(undo)).toBe(true);
		expect(body()).toBe('xBody.\n');
		expect(run(undo)).toBe(true);
		expect(body()).toBe('Body.\n');
		expectNoteHoldsScreen();
	});

	test('one made while the note takes no edit is not displayed', async () => {
		const { type, closeNotes, body, end, refusal, ...view } =
			await open('one\n');
		end();
		type('!');
		const state = view.shown();
		const closed = closeNotes();
		expect(type('late')).toBe(false);
		expect(refusal()).toContain('closing');
		expect(view.shown()).toBe(state);
		expect(body()).toBe('one!\n');
		await closed;
	});

	test('Enter is not displayed while the note takes no edit, and writes nothing', async () => {
		const { press, end, closeNotes, writes, ...view } = await open('one\n');
		end();
		const closed = closeNotes();
		const state = view.shown();
		press('Enter');
		expect(view.shown()).toBe(state);
		await closed;
		expect(writes()).toBe(0);
	});
});

describe('undo history', () => {
	test('lasts across edits: the state is one continuous history', async () => {
		const { type, press, run, body, end, expectNoteHoldsScreen, ...view } =
			await open('one\n');
		end();
		type(' two');
		press('Enter');
		type('three');
		expect(undoDepth(view.shown())).toBeGreaterThan(0);
		while (undoDepth(view.shown()) > 0) expect(run(undo)).toBe(true);
		expect(view.shown().doc.textContent).toBe('one');
		expect(body()).toBe('one\n');
		expectNoteHoldsScreen();
		while (redoDepth(view.shown()) > 0) expect(run(redo)).toBe(true);
		expect(body()).toBe('one two\n\nthree\n');
	});

	test('a body this view wrote, or a look at Source that changes nothing, keeps the state', async () => {
		const { type, press, end, follow, ...view } = await open('one\n');
		end();
		type('!');
		press('Enter');
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
		// The empty paragraph Enter made is still there to type into.
		expect(view.shown().doc.childCount).toBe(2);
		expect(undoDepth(view.shown())).toBeGreaterThan(0);
	});

	test('the same content respelled in Source keeps the cursor, pending formatting, and history', async () => {
		const { type, run, source, follow, body, ...view } = await open('*a* b\n');
		run((state, send) => {
			send?.(state.tr.setSelection(TextSelection.create(state.doc, 4)));
			return true;
		});
		type('!');
		run(toggleMark(noteSchema.marks.strong));
		const state = view.shown();
		expect(body()).toBe('*a* b!\n');
		source('_a_ b!\n');
		follow();
		expect(view.shown()).toBe(state);
		expect(view.shown().selection.head).toBe(5);
		expect(view.shown().storedMarks).not.toBeNull();
		expect(undoDepth(view.shown())).toBe(1);
	});

	test('a different body replaces the state without writing, and new edits are undoable', async () => {
		const { type, run, source, follow, body, end, ...view } =
			await open('one\n');
		end();
		type('!');
		source('from source\n');
		follow();
		expect(view.shown().doc.textContent).toBe('from source');
		expect(body()).toBe('from source\n');
		expect(undoDepth(view.shown())).toBe(0);
		// The cursor starts at the start.
		expect(view.shown().selection.head).toBe(1);
		// Undo does not bring back text from before the replacement.
		run(undo);
		expect(body()).toBe('from source\n');
		end();
		type('?');
		expect(body()).toBe('from source?\n');
		run(undo);
		expect(body()).toBe('from source\n');
	});
});

describe('a body that changed under the view', () => {
	test('a transaction that arrives before the view followed is dropped, and the body is shown', async () => {
		const { type, source, body, follow, ...view } = await open('one\n');
		// Source took a body; the view has not followed it yet.
		source('from source\n');
		expect(type('x')).toBe(true);
		expect(view.shown().doc.textContent).toBe('from source');
		expect(body()).toBe('from source\n');
		expect(undoDepth(view.shown())).toBe(0);
		const state = view.shown();
		follow();
		expect(view.shown()).toBe(state);
	});

	test('a transaction built before a replacement is dropped after it', async () => {
		const { dispatch, source, body, follow, ...view } = await open('one\n');
		const late = view.shown().tr.insertText('late ', 1);
		const moved = view
			.shown()
			.tr.setSelection(TextSelection.create(view.shown().doc, 4));
		source('from source\n');
		follow();
		const state = view.shown();
		expect(dispatch(late)).toBe(false);
		expect(dispatch(moved)).toBe(false);
		expect(view.shown()).toBe(state);
		expect(body()).toBe('from source\n');
	});

	test('a body that is not rich text is never written over', async () => {
		const { type, source, body, follow, ...view } = await open('one\n');
		const state = view.shown();
		source('<div>x</div>\n');
		expect(bodyCodec.decode(body()).supported).toBe(false);
		expect(type('x')).toBe(false);
		follow();
		expect(view.shown()).toBe(state);
		expect(body()).toBe('<div>x</div>\n');
	});

	test('HTML that reads as the same text as the document is still not rich text', async () => {
		const { type, source, body } = await open('');
		type('<b>x</b>');
		expect(body()).toBe('\\<b>x\\</b>\n');
		// Raw HTML parses to the same literal text, and the editor refuses it.
		source('<b>x</b>\n');
		const rich = bodyCodec.decode(body());
		expect(rich.supported).toBe(false);
		if (!rich.supported) expect(rich.reasons).toEqual(['It contains HTML.']);
		expect(type('!')).toBe(false);
		expect(body()).toBe('<b>x</b>\n');
	});
});

describe('the editor follows the note', () => {
	test('a save landing keeps the state, its cursor, and its undo history', async () => {
		const { type, end, follow, settled, failures, stored, ...view } =
			await open('one\n');
		end();
		type('!');
		const state = view.shown();
		await settled();
		expect(failures()).toEqual([]);
		expect(await stored()).toContain('one!\n');
		follow();
		expect(view.shown()).toBe(state);
		expect(undoDepth(view.shown())).toBe(1);
	});

	test('a change another tab saved replaces a clean editor', async () => {
		const { fixture, follow, settled, body, ...view } = await open('one\n');
		const tab = await fixture.otherTab();
		expectOk(await tab.tables.notes.document('a').refresh());

		expectOk(tab.tables.notes.document('a').patch({ body: 'theirs\n' }));
		expectOk(await tab.tables.notes.document('a').save());
		await until(() => body() === 'theirs\n', 'their save');
		await settled();
		follow();
		expect(view.shown().doc.textContent).toBe('theirs');
		expect(undoDepth(view.shown())).toBe(0);
	});

	test('typing in flight survives a read and publishes the whole source without resetting history', async () => {
		const {
			fixture,
			notes,
			type,
			end,
			follow,
			settled,
			body,
			failures,
			stored,
			...view
		} = await open('one\n');
		end();
		type('!');
		const state = view.shown();
		// Another tab adds a line. Its report arrives and the read lands while
		// the typing is held.
		const tab = await fixture.otherTab();
		expectOk(await tab.tables.notes.document('a').refresh());

		expectOk(tab.tables.notes.document('a').patch({ body: 'one\n\ntheirs\n' }));
		expectOk(await tab.tables.notes.document('a').save());
		await until(
			() => rows(notes)[0]?.body === 'one\n\ntheirs\n',
			'their save to be read',
		);
		follow();
		expect(view.shown()).toBe(state);
		expect(body()).toBe('one!\n');
		const edit = fixture.folder.tables.notes.document('a');
		await edit.save();
		expect(edit.getSnapshot().saveError).toBeUndefined();
		expect(failures()).toEqual([]);
		expect(await stored()).toContain('one!\n');
		expect(body()).toBe('one!\n');
		await edit.save();
		await settled();
		expect(failures()).toEqual([]);
		expect(await stored()).toContain('one!\n');
		expect(await stored()).not.toContain('theirs');
		follow();
		expect(view.shown()).toBe(state);
		expect(undoDepth(view.shown())).toBe(1);
	});

	test('discarding pending input then refreshing shows outside content and resets history', async () => {
		const { fixture, type, end, settled, body, failures, follow, ...view } =
			await open('one\n');
		end();
		expect(type('!')).toBe(true);
		const tab = await fixture.otherTab();
		expectOk(await tab.tables.notes.document('a').refresh());

		expectOk(tab.tables.notes.document('a').patch({ body: 'theirs\n' }));
		expectOk(await tab.tables.notes.document('a').save());
		const edit = fixture.folder.tables.notes.document('a');
		expect(body()).toBe('one!\n');
		edit.discard();
		await edit.refresh();
		await settled();
		expect(failures()).toEqual([]);
		expect(body()).toBe('theirs\n');
		follow();
		expect(view.shown().doc.textContent).toBe('theirs');
		expect(undoDepth(view.shown())).toBe(0);
	});
});
