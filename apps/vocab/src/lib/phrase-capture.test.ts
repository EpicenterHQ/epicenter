/**
 * Phrase capture tests.
 * A phrase is exact text from one line of one saved tutor message. These run
 * over a jsdom tree: they establish what the functions do with a given tree
 * and range, not how a browser makes a selection with a mouse, a keyboard, or
 * touch handles.
 *
 * Key behaviors:
 * - A selection yields the message's own characters, across inline Markdown
 * - A selection across messages, lines, or text that is not a saved tutor
 *   message yields nothing
 * - A typed phrase must be one exact run within one line of its message
 * - A phrase is accepted only while its message is still a connected source
 * - No script or spelling is rejected or normalized
 */
import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
	capturePhrase,
	messageHasPhrase,
	messageText,
	sourceHoldsPhrase,
} from './phrase-capture.js';

/**
 * A conversation as Vocab renders it: two saved tutor messages, a learner
 * message, a tutor answer not yet saved, and a partial reply.
 * Only the saved tutor messages are phrase sources.
 */
function exchange() {
	const { window } = new JSDOM(
		'<!doctype html><body><div id="list">' +
			// vocab-check: ignore-next-line (Tailwind typography class)
			'<div class="bubble"><div data-phrase-source="one"><div class="prose">' +
			'<p>A <strong>laconic</strong> reply is <a href="https://example.invalid">brief</a>, not rude.</p>' +
			'<p>Café and café differ; 顺便 too.<br>Third line \u{1F600} here</p>' +
			'<ul><li>pragmatic</li><li>ephemeral</li></ul>' +
			'</div></div>' +
			'<button data-capture-skip data-save-phrase="one">Save a phrase</button></div>\n' +
			'<div class="bubble"><div id="learner">Is "terse" the same?</div></div>' +
			// vocab-check: ignore-next-line (Tailwind typography class)
			'<div class="bubble"><div data-phrase-source="two"><div class="prose"><p>  by and large  </p></div></div></div>' +
			'<div class="bubble"><div id="unsaved"><p>an unsaved answer</p></div></div>' +
			'<div class="bubble"><div id="streaming">a partial rep</div></div>' +
			'</div></body>',
	);
	const { document } = window;
	const one = document.querySelector<HTMLElement>('[data-phrase-source="one"]');
	const two = document.querySelector<HTMLElement>('[data-phrase-source="two"]');
	if (!one || !two) throw new Error('the fixture has no phrase sources');
	/** The text node holding `text`. */
	const node = (text: string) => {
		const walker = document.createTreeWalker(document.body, 4);
		for (
			let current = walker.nextNode();
			current;
			current = walker.nextNode()
		) {
			if (current.textContent?.includes(text)) return current as Text;
		}
		throw new Error(`no text node holds ${text}`);
	};
	/** A point just before (`0`) or just after (`1`) `text` in its text node. */
	const at = (text: string, edge: 0 | 1): [Node, number] => {
		const holder = node(text);
		return [holder, holder.data.indexOf(text) + edge * text.length];
	};
	const select = (start: [Node, number], end: [Node, number]) => {
		const selection = window.getSelection();
		if (!selection) throw new Error('jsdom has no selection');
		selection.removeAllRanges();
		const range = document.createRange();
		range.setStart(start[0], start[1]);
		range.setEnd(end[0], end[1]);
		selection.addRange(range);
		return capturePhrase(selection);
	};
	return { window, document, one, two, at, select };
}

test('a selection is captured as the message’s own text, across inline Markdown', () => {
	const { window, one, two, at, select } = exchange();
	expect(capturePhrase(null)).toBeUndefined();
	window.getSelection()?.removeAllRanges();
	expect(capturePhrase(window.getSelection())).toBeUndefined();

	const captured = select(at('laconic', 0), at('laconic', 1));
	expect(captured?.text).toBe('laconic');
	expect(captured?.messageId).toBe('one');
	expect(captured?.message).toBe(one);
	expect(captured?.range.toString()).toBe('laconic');

	// Part of a text node, across the emphasis and the link, to part of another.
	expect(select(at('A ', 1), at(', not', 1))?.text).toBe(
		'laconic reply is brief, not',
	);
	// Punctuation alone is a phrase like any other text.
	expect(
		select(at(', not', 0), [at(', not', 0)[0], at(', not', 0)[1] + 1])?.text,
	).toBe(',');

	// Endpoints on elements rather than in text, as a triple click makes them.
	const [first, second] = one.querySelectorAll('p');
	if (!first || !second) throw new Error('the fixture has no paragraphs');
	expect(select([first, 0], [first, first.childNodes.length])?.text).toBe(
		'A laconic reply is brief, not rude.',
	);
	// Running on to the start of the next block takes nothing from it.
	expect(select([first, 0], [second, 0])?.text).toBe(
		'A laconic reply is brief, not rude.',
	);

	// One list item is one line.
	expect(select(at('pragmatic', 0), at('pragmatic', 1))?.text).toBe(
		'pragmatic',
	);

	// Surrounding whitespace is trimmed, as a pasted line's is.
	const padded = two.querySelector('p');
	if (!padded) throw new Error('the fixture has no padded paragraph');
	expect(select([padded, 0], [padded, 1])?.text).toBe('by and large');
});

test('captured text keeps its exact characters, whatever the script or spelling', () => {
	const { at, select } = exchange();
	// The decomposed and the composed é stay different spellings.
	const spelled = select(at('Café', 0), at('café', 1));
	expect(spelled?.text).toBe('Café and café');
	expect(spelled?.text).not.toBe(spelled?.text.normalize('NFC'));
	// Han text and an emoji outside the basic plane are text like any other.
	expect(select(at('顺便', 0), at('顺便', 1))?.text).toBe('顺便');
	expect(select(at('Third', 0), at(' here', 1))?.text).toBe(
		'Third line \u{1F600} here',
	);
});

test('a selection across messages, lines, or text that is not a saved tutor message is refused', () => {
	const { document, one, two, at, select } = exchange();
	// Two saved tutor messages.
	expect(select(at('laconic', 0), at('by and large', 1))).toBeUndefined();
	expect(select([one, 0], [two, two.childNodes.length])).toBeUndefined();
	// A learner message, an unsaved answer, and a reply that is still arriving.
	for (const id of ['#learner', '#unsaved p', '#streaming']) {
		const element = document.querySelector(id);
		if (!element) throw new Error(`the fixture has no ${id}`);
		expect(
			select([element, 0], [element, element.childNodes.length]),
		).toBeUndefined();
	}
	// A saved message together with any of them.
	expect(select(at('by and large', 0), at('unsaved', 1))).toBeUndefined();
	expect(select(at('by and large', 0), at('partial', 1))).toBeUndefined();
	expect(select(at('ephemeral', 0), at('terse', 1))).toBeUndefined();
	// Two paragraphs, two lines of one paragraph, or two list items.
	expect(select(at('rude', 0), at('Café', 1))).toBeUndefined();
	expect(select(at('differ', 0), at('Third', 1))).toBeUndefined();
	expect(select(at('pragmatic', 0), at('ephemeral', 1))).toBeUndefined();
	// Whitespace alone.
	const padding = at('by and large', 0);
	expect(select([padding[0], 0], padding)).toBeUndefined();
});

test('the button and whitespace beside a message do not spoil a selection', () => {
	const { document, at, select } = exchange();
	const button = document.querySelector('[data-save-phrase="one"]');
	const label = button?.firstChild;
	const next = document.querySelectorAll('.bubble')[1];
	if (!label || !next) throw new Error('the fixture has no button');
	// From the last line over the button and the space between bubbles.
	expect(select(at('ephemeral', 0), [next, 0])?.text).toBe('ephemeral');
	expect(select(at('ephemeral', 0), [label, 4])?.text).toBe('ephemeral');
	// The button alone is not a phrase.
	expect(select([label, 0], [label, 4])).toBeUndefined();
});

test('a typed phrase must be one exact run within one line of the message', () => {
	const { one, two } = exchange();
	expect(messageText(one)).toBe(
		[
			'A laconic reply is brief, not rude.',
			'Café and café differ; 顺便 too.',
			'Third line \u{1F600} here',
			'pragmatic',
			'ephemeral',
		].join('\n'),
	);
	expect(messageText(two)).toBe('  by and large  ');
	expect(messageHasPhrase(one, 'laconic reply is brief')).toBe(true);
	expect(messageHasPhrase(one, 'Café and')).toBe(true);
	expect(messageHasPhrase(one, '顺便')).toBe(true);
	expect(messageHasPhrase(two, 'by and large')).toBe(true);
	// Text of another message, a different case or spelling, and a run across lines.
	expect(messageHasPhrase(one, 'by and large')).toBe(false);
	expect(messageHasPhrase(one, 'Laconic')).toBe(false);
	expect(messageHasPhrase(one, 'Café and')).toBe(false);
	expect(messageHasPhrase(one, 'rude.Café')).toBe(false);
	expect(messageHasPhrase(one, 'rude.\nCafé')).toBe(false);
	expect(messageHasPhrase(one, 'pragmaticephemeral')).toBe(false);
	expect(messageHasPhrase(one, '')).toBe(false);
});

test('a phrase is accepted only while its message is still a connected phrase source', () => {
	const { one } = exchange();
	expect(sourceHoldsPhrase(one, 'laconic')).toBe(true);
	expect(sourceHoldsPhrase(one, 'terse')).toBe(false);
	// The message stops being a source: storage fell behind after it was read.
	one.removeAttribute('data-phrase-source');
	expect(sourceHoldsPhrase(one, 'laconic')).toBe(false);
	one.setAttribute('data-phrase-source', 'one');
	// The message leaves the page: its chat was switched or its tree rebuilt.
	one.remove();
	expect(sourceHoldsPhrase(one, 'laconic')).toBe(false);
});
