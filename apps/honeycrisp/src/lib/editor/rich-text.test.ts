/**
 * Rich Text Tests
 *
 * Drives the rich-text view's two rules the way the view does, over the real
 * notes state and folder mirror: each transaction goes through `stateAfter`
 * before it is shown, and the body is followed
 * with `stateShowing`. The state the harness keeps is what the view would
 * display; the note's body draft holds an edit until its save lands, and
 * the mirror holds the note after.
 *
 * Key behaviors:
 * - Every displayed edit is in the note, including spaces, Enter, and
 *   Shift-Enter, and saves the body alone: every field, and a key Honeycrisp
 *   does not declare, stays as it was
 * - Moving the cursor or setting pending formatting writes nothing
 * - An edit Markdown cannot express is refused before it is displayed
 * - A lone surrogate becomes U+FFFD in the same transaction, as the file
 *   stores it, so the screen shows what is saved
 * - A body read from a CRLF file shows and saves with line feeds
 * - The same content keeps the state, its cursor, pending formatting, and
 *   undo history; different content replaces it; a body that is not rich
 *   text is never written over
 * - A transaction built before the body changed is dropped
 * - A change another tab saved replaces a clean editor; a save landing
 *   does not
 * - A pending body draft keeps typing and history through a save; a failed
 *   save makes the state follow disk again
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
import { bodyCodec, equivalentNoteDocs, parseNoteBody } from './markdown.js';
import { noteSchema } from './schema.js';

// The notes state is a runes module: load it, and the rules, after the
// compiler plugin.
const { openNotes, quiet, until, noteText } = await import(
	'../local.test-support.ts'
);
const { editingPlugins, noteBody, stateAfter, stateShowing } = await import(
	'./rich-text.js'
);

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

const PATH = 'notes/a.md';

/** The notes state over a folder holding one note with `text`, open as a note. */
async function noteOver(text: string) {
    const fixture = await openNotes();
    cleanup.push(() => fixture.close());
    await fixture.write(PATH, text);
    const { notes, raw } = fixture;
    notes.open(PATH);
    const table = notes.folder.tables.notes;
    let typed: string | null = null;
    let latest = 0;
    let landed = 0;
    let pending: Promise<unknown> = Promise.resolve();
    const failures: string[] = [];
    const note = {
        read: () => typed ?? noteBody(table.row('a')),
        write(body: string) {
            typed = body;
            const mine = ++latest;
            landed++;
            pending = table.update('a', { body }).then(({ error }) => {
                if (error !== null) failures.push(error.message);
                if (mine === latest) typed = null;
            });
        },
    };
    return {
        fixture, notes, note,
        failures: () => failures,
        draft: () => {
            const row = table.row('a');
            if (row?.issues !== null || row === undefined) throw new Error('The note does not read as one');
            return { ...row, body: note.read() ?? row.body };
        },
        settled: async () => { await pending; await quiet(notes); },
        writes: () => landed,
        stored: () => fixture.text(PATH),
        theirs: async (body: string) => {
            const tab = await fixture.otherTab();
            expectOk(await tab.tables.notes.update('a', { body }));
            await until(() => table.row('a')?.body === body, 'outside body');
        },
    };
}

/** One rich-text view over `body`, as the view holds it, and its note. */
async function open(
	initialBody: string,
	{ text = noteText({ body: initialBody }) } = {},
) {
	const opened = await noteOver(text);
	const { note } = opened;
	const body = () => note.read() ?? '';
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
		const next = stateAfter(state, transaction, note, (reason) => {
			refusal = reason;
		});
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
	const source = (text: string) => note.write(text);
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
		const { type, end, body, settled, failures, stored, writes } =
			await open('', {
				text: crlf,
			});
		expect(body()).toBe('\none\n\ntwo\n');
		expect(crlf).toContain('\r\none\r\n\r\ntwo\r\n');
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
		const { theirs, follow, settled, body, ...view } = await open('one\n');
		await theirs('theirs\n');
		await until(() => body() === 'theirs\n', 'their save');
		await settled();
		follow();
		expect(view.shown().doc.textContent).toBe('theirs');
		expect(undoDepth(view.shown())).toBe(0);
	});

	test('a source change during a pending draft does not replace history when the draft lands', () => {
		let source = 'one\n';
		let typed: string | null = null;
		const note = {
			read: () => typed ?? source,
			write: (body: string) => { typed = body; },
		};
		const initial = bodyCodec.decode(source);
		if (!initial.supported) throw new Error('Initial body is not rich text');
		const state = EditorState.create({ doc: initial.doc, plugins: editingPlugins() });
		const transaction = state.tr.setSelection(TextSelection.atEnd(state.doc)).insertText('!');
		const shown = stateAfter(state, transaction, note, () => {});
		if (shown === undefined) throw new Error('Edit was refused');
		expect(note.read()).toBe('one!\n');
		source = 'theirs\n';
		const whilePending = bodyCodec.decode(note.read());
		if (!whilePending.supported) throw new Error('Draft is not rich text');
		expect(stateShowing(shown, whilePending.doc)).toBe(shown);
		source = typed ?? source;
		typed = null;
		const landed = bodyCodec.decode(note.read());
		if (!landed.supported) throw new Error('Landed body is not rich text');
		expect(stateShowing(shown, landed.doc)).toBe(shown);
		expect(undoDepth(shown)).toBe(1);
	});

	test('a failed save replaces the editor state with the disk body', async () => {
		const { fixture, type, end, settled, follow, body, ...view } = await open('one\n');
		fixture.failSaves();
		end();
		type('!');
		const typed = view.shown();
		expect(body()).toBe('one!\n');
		await settled();
		follow();
		expect(body()).toBe('one\n');
		expect(view.shown()).not.toBe(typed);
		expect(undoDepth(view.shown())).toBe(0);
	});


});
