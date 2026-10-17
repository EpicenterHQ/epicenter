/**
 * Note Body Markdown Tests
 *
 * The rich-text view edits a ProseMirror document and saves Markdown. These
 * tests hold the codec to its contract: a document the schema can hold comes
 * back equal after `document -> Markdown -> document`, and source the schema
 * cannot hold is refused instead of quietly changed.
 *
 * Key behaviors:
 * - Every supported block and mark round-trips to an equal document
 * - Respelled Markdown parses to the same document as its source
 * - HTML, images, and tables are refused with a reason
 * - The schema has no underline and no image
 * - A note's body decodes and encodes back byte-identical, keeping its
 *   leading blank lines
 */
import { describe, expect, test } from 'bun:test';
import type { Node } from 'prosemirror-model';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	bodyCodec,
	checkNoteDoc,
	equivalentNoteDocs,
	inspectNoteBody,
	parseNoteBody,
	serializeNoteBody,
} from './markdown.js';
import { noteSchema as schema } from './schema.js';

const n = (type: string, attrs: object | null, ...content: Node[]) =>
	schema.node(type, attrs, content);
const t = (text: string, ...marks: [string, object?][]) =>
	schema.text(
		text,
		marks.map(([name, attrs]) => schema.mark(name, attrs)),
	);
const p = (...content: Node[]) => n('paragraph', null, ...content);
const doc = (...content: Node[]) => n('doc', null, ...content);

/** `document -> Markdown -> document`. */
const roundTrip = (document: Node) =>
	parseNoteBody(serializeNoteBody(document));

function expectEquivalent(document: Node) {
	const back = roundTrip(document);
	if (!back.eq(document))
		throw new Error(
			`Not equivalent.\nMarkdown:\n${serializeNoteBody(document)}\nBefore: ${document}\nAfter:  ${back}`,
		);
	expect(back.eq(document)).toBe(true);
}

describe('document -> Markdown -> document keeps supported content equivalent', () => {
	const cases: Record<string, Node> = {
		paragraphs: doc(p(t('One')), p(t('Two'))),
		'headings 1 to 6': doc(
			...[1, 2, 3, 4, 5, 6].map((level) =>
				n('heading', { level }, t(`H${level}`)),
			),
		),
		bold: doc(p(t('a '), t('bold', ['strong']), t(' b'))),
		italic: doc(p(t('a '), t('italic', ['em']), t(' b'))),
		strikethrough: doc(p(t('keep '), t('gone', ['strike']), t(' keep'))),
		'inline code': doc(p(t('run '), t('ls -la', ['code']), t(' now'))),
		link: doc(
			p(t('see '), t('the site', ['link', { href: 'https://example.com' }])),
		),
		'link with a title': doc(
			p(t('x', ['link', { href: 'https://example.com/a', title: 'A title' }])),
		),
		'combined marks': doc(
			p(
				t('bold italic', ['strong'], ['em']),
				t(' '),
				t('struck bold', ['strong'], ['strike']),
				t(' '),
				t('linked bold', ['link', { href: 'https://e.com' }], ['strong']),
			),
		),
		'bullet list': doc(
			n(
				'bullet_list',
				null,
				n('list_item', null, p(t('milk'))),
				n('list_item', null, p(t('eggs'))),
			),
		),
		'ordered list': doc(
			n(
				'ordered_list',
				{ order: 1 },
				n('list_item', null, p(t('first'))),
				n('list_item', null, p(t('second'))),
			),
		),
		'ordered list from 3': doc(
			n(
				'ordered_list',
				{ order: 3 },
				n('list_item', null, p(t('third'))),
				n('list_item', null, p(t('fourth'))),
			),
		),
		'nested lists': doc(
			n(
				'bullet_list',
				null,
				n(
					'list_item',
					null,
					p(t('outer')),
					n('ordered_list', { order: 1 }, n('list_item', null, p(t('inner')))),
				),
			),
		),
		'task list': doc(
			n(
				'taskList',
				null,
				n('taskItem', { checked: true }, p(t('done'))),
				n('taskItem', { checked: false }, p(t('todo'))),
			),
		),
		'task list with formatting and nesting': doc(
			n(
				'taskList',
				null,
				n(
					'taskItem',
					{ checked: false },
					p(t('ship '), t('it', ['strong'])),
					n('taskList', null, n('taskItem', { checked: true }, p(t('sub')))),
				),
			),
		),
		'an empty task item': doc(
			n(
				'taskList',
				null,
				n('taskItem', { checked: false }, p()),
				n('taskItem', { checked: true }, p(t('x'))),
			),
		),
		'a bullet list beside a task list': doc(
			n('bullet_list', null, n('list_item', null, p(t('plain')))),
			n('taskList', null, n('taskItem', { checked: false }, p(t('task')))),
			n('bullet_list', null, n('list_item', null, p(t('plain again')))),
		),
		'two adjacent bullet lists': doc(
			n('bullet_list', null, n('list_item', null, p(t('a')))),
			n('bullet_list', null, n('list_item', null, p(t('b')))),
		),
		'two adjacent ordered lists': doc(
			n('ordered_list', { order: 1 }, n('list_item', null, p(t('a')))),
			n('ordered_list', { order: 1 }, n('list_item', null, p(t('b')))),
		),
		quote: doc(n('blockquote', null, p(t('quoted')), p(t('twice')))),
		'quote holding a list': doc(
			n(
				'blockquote',
				null,
				n('bullet_list', null, n('list_item', null, p(t('in a quote')))),
			),
		),
		'code block': doc(
			n('code_block', { params: '' }, t('const a = 1;\n  indented();')),
		),
		'code block with a language': doc(
			n('code_block', { params: 'ts' }, t('let x: number;')),
		),
		'code block holding Markdown syntax': doc(
			n(
				'code_block',
				{ params: '' },
				t('# not a heading\n- [x] not a task\n**plain**'),
			),
		),
		rule: doc(p(t('above')), n('horizontal_rule', null), p(t('below'))),
		'hard break': doc(p(t('line one'), n('hard_break', null), t('line two'))),
		'text that looks like Markdown': doc(
			p(t('# not a heading')),
			p(t('1. not a list')),
			p(t('- not a bullet')),
			p(t('[x] not a task, *not* emphasis, ~~not~~ struck, `not code`')),
			p(t('a <b>not html</b> & an [unlinked] bracket')),
		),
		'a literal task marker in a bullet list': doc(
			n(
				'bullet_list',
				null,
				n('list_item', null, p(t('[x] literal'))),
				n('list_item', null, p(t('plain'))),
			),
		),
		everything: doc(
			n('heading', { level: 1 }, t('Title')),
			p(
				t('Intro with '),
				t('bold', ['strong']),
				t(', '),
				t('italic', ['em']),
				t(', '),
				t('gone', ['strike']),
				t('.'),
			),
			n('blockquote', null, p(t('a quote'))),
			n('taskList', null, n('taskItem', { checked: true }, p(t('one')))),
			n('ordered_list', { order: 1 }, n('list_item', null, p(t('step')))),
			n('code_block', { params: 'sh' }, t('echo hi')),
			n('horizontal_rule', null),
			p(t('end')),
		),
	};
	for (const [name, document] of Object.entries(cases))
		test(name, () => expectEquivalent(document));
});

describe('Markdown that the editor respells keeps its meaning', () => {
	const respelled: [string, string, string][] = [
		['underscore emphasis', '_a_ and __b__', '*a* and **b**'],
		['setext heading', 'Title\n=====', '# Title'],
		['dash bullets', '- a\n- b', '* a\n* b'],
		['a loose list', '* a\n\n* b', '* a\n* b'],
		[
			'a reference link',
			'[site][1]\n\n[1]: https://example.com',
			'[site](https://example.com)',
		],
		['an indented code block', '    code', '```\ncode\n```'],
		['a soft line break', 'one\ntwo', 'one two'],
		['an uppercase task marker', '- [X] done', '- [x] done'],
	];
	for (const [name, source, expected] of respelled)
		test(name, () => {
			const parsed = parseNoteBody(source);
			expect(serializeNoteBody(parsed)).toBe(expected);
			expect(parseNoteBody(expected).eq(parsed)).toBe(true);
			expect(inspectNoteBody(source).supported).toBe(true);
		});

	test('serialized Markdown is a fixed point', () => {
		const source = [
			'# Groceries',
			'',
			'A list with **bold**, *emphasis*, ~~strike~~, `code`, and a [link](https://example.com).',
			'',
			'> quoted',
			'',
			'- [x] milk',
			'- [ ] eggs',
			'',
			'1. first',
			'2. second',
			'',
			'```js',
			'let a = 1;',
			'```',
		].join('\n');
		expect(serializeNoteBody(parseNoteBody(source))).toBe(source);
	});

	test('a code fence keeps its language', () => {
		const parsed = parseNoteBody('```ts\nlet x = 1;\n```');
		expect(parsed.firstChild?.attrs.params).toBe('ts');
	});

	test('an empty paragraph is not kept, and nothing else is lost with it', () => {
		const withEmpty = doc(p(t('a')), p(), p(t('b')));
		expect(roundTrip(withEmpty).eq(doc(p(t('a')), p(t('b'))))).toBe(true);
	});

	test('empty paragraphs at the start write nothing', () => {
		expect(serializeNoteBody(doc(p(), p(t('a'))))).toBe('a');
		expect(serializeNoteBody(doc(p(), p(), p(t('a')), p()))).toBe('a');
	});

	test('an empty body is an empty document and back', () => {
		expect(serializeNoteBody(parseNoteBody(''))).toBe('');
		expect(inspectNoteBody('').supported).toBe(true);
	});
});

describe('source the schema cannot hold is refused, not changed', () => {
	const refused: [string, string, string][] = [
		['inline HTML', 'some <u>underlined</u> text', 'HTML'],
		['an HTML block', '<div class="x">\nhello\n</div>', 'HTML'],
		['an HTML comment', 'text\n\n<!-- a comment -->', 'HTML'],
		['an image', 'look ![alt](pic.png)', 'an image'],
		['a table', '| a | b |\n| - | - |\n| 1 | 2 |', 'a table'],
	];
	for (const [name, source, reason] of refused)
		test(name, () => {
			const inspection = inspectNoteBody(source);
			expect(inspection.supported).toBe(false);
			if (!inspection.supported)
				expect(inspection.reasons.join(' ')).toContain(reason);
		});

	test('a list mixing task markers and plain items stays a bullet list with its text', () => {
		const inspection = inspectNoteBody('* [x] milk\n* eggs');
		expect(inspection.supported).toBe(true);
		if (!inspection.supported) return;
		let tasks = 0;
		inspection.doc.descendants((node) => {
			if (node.type.name === 'taskItem') tasks += 1;
		});
		expect(tasks).toBe(0);
		expect(inspection.doc.textContent).toBe('[x] milkeggs');
	});
});

describe('whitespace Markdown would drop is written so it survives', () => {
	const exact: Record<string, [Node, string]> = {
		'a trailing space': [doc(p(t('A '))), 'A&#32;'],
		'leading spaces': [doc(p(t('   A'))), '&#32;&#32;&#32;A'],
		'a leading tab': [doc(p(t('\tA'))), '&#9;A'],
		'a paragraph of spaces': [doc(p(t('  '))), '&#32;&#32;'],
		'spaces beside a line break': [
			doc(p(t('a '), n('hard_break', null), t(' b'))),
			'a&#32;\\\n&#32;b',
		],
		'a trailing space in a heading': [
			doc(n('heading', { level: 2 }, t('A '))),
			'## A&#32;',
		],
		'a trailing space in bold at the end of a block': [
			doc(p(t('bold ', ['strong']))),
			'**bold&#32;**',
		],
		'inline code with a space on both sides': [
			doc(p(t(' a ', ['code']))),
			'`  a  `',
		],
		'interior spaces are left alone': [doc(p(t('a  b'))), 'a  b'],
	};
	for (const [name, [document, markdown]] of Object.entries(exact))
		test(name, () => {
			expect(serializeNoteBody(document)).toBe(markdown);
			expect(parseNoteBody(markdown).eq(document)).toBe(true);
		});
});

describe('what counts as the same document', () => {
	test('an empty paragraph and a line break that ends a block are not content', () => {
		const typed = doc(p(t('a'), n('hard_break', null)), p(), p(t('b')));
		expect(equivalentNoteDocs(typed, doc(p(t('a')), p(t('b'))))).toBe(true);
		expect(checkNoteDoc(typed)).toEqual({ ok: true, markdown: 'a\n\nb' });
	});

	test('bold on a space is not formatting; bold on a letter is', () => {
		const spaced = doc(p(t('a', ['strong']), t(' ', ['strong']), t('b')));
		expect(
			equivalentNoteDocs(spaced, doc(p(t('a', ['strong']), t(' b')))),
		).toBe(true);
		expect(equivalentNoteDocs(spaced, doc(p(t('a b'))))).toBe(false);
	});

	test('text is never forgiven: one different character is a different document', () => {
		expect(equivalentNoteDocs(doc(p(t('A '))), doc(p(t('A'))))).toBe(false);
		expect(equivalentNoteDocs(doc(p(t('a  b'))), doc(p(t('a b'))))).toBe(false);
	});

	test('a document Markdown cannot express fails the check instead of being written', () => {
		const check = checkNoteDoc(doc(p(t('a'), t('(b)', ['strong']))));
		expect(check.ok).toBe(false);
	});
});

describe('text shaped like a table stays text', () => {
	/** One paragraph of plain lines joined by line breaks. */
	const lines = (...texts: string[]) =>
		doc(
			p(
				...texts.flatMap((text, index) =>
					index === 0 ? [t(text)] : [n('hard_break', null), t(text)],
				),
			),
		);
	const shaped: Record<string, [Node, string]> = {
		'a header line with pipes over a delimiter line': [
			lines('a | b', '|---|---|'),
			'a | b\\\n\\|---|---|',
		],
		'a delimiter line that starts with a colon': [
			lines('a | b', ':-|-:'),
			'a | b\\\n\\:-|-:',
		],
		'a delimiter line that starts with a dash': [
			lines('a | b', '-|-'),
			'a | b\\\n\\-|-',
		],
		'an escaped pipe over a one-column delimiter': [
			lines('a \\| b', ':-'),
			'a \\\\| b\\\n\\:-',
		],
		'a line starting with a pipe over a delimiter': [
			lines('|a', ':--'),
			'\\|a\\\n\\:--',
		],
		'a code span with a pipe over a delimiter': [
			doc(p(t('a|b', ['code']), n('hard_break', null), t(':-|-'))),
			'`a|b`\\\n\\:-|-',
		],
		'pipes and colons inside a line are left alone': [
			doc(p(t('a | b: c |'))),
			'a | b: c |',
		],
	};
	for (const [name, [document, markdown]] of Object.entries(shaped))
		test(name, () => {
			expect(checkNoteDoc(document)).toEqual({ ok: true, markdown });
			const reopened = inspectNoteBody(markdown);
			expect(reopened.supported).toBe(true);
			if (reopened.supported)
				expect(equivalentNoteDocs(reopened.doc, document)).toBe(true);
		});

	test('a code block holding a table is code, not a table', () => {
		const code = doc(
			n('code_block', { params: '' }, t('| a | b |\n|---|---|\n| 1 | 2 |')),
		);
		expect(checkNoteDoc(code)).toEqual({
			ok: true,
			markdown: '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```',
		});
		expect(inspectNoteBody('```\n| a | b |\n|---|---|\n```').supported).toBe(
			true,
		);
	});

	test('a table typed in Source still opens in Source only', () => {
		for (const source of [
			'a | b\n|---|---|',
			'a | b  \n|---|---|\n',
			'a \\| b\n:-',
			'`a|b`\n:-|-',
		]) {
			const inspection = inspectNoteBody(source);
			expect(inspection).toEqual({
				supported: false,
				reasons: ['It contains a table.'],
			});
		}
	});
});

describe("a note's whole body", () => {
	const BODY = '\n# List\n\n- [ ] milk\n';

	test('decoded and encoded again with nothing changed, it is the same bytes', () => {
		const decoded = bodyCodec.decode(BODY);
		if (!decoded.supported) throw new Error('The body is not rich text');
		expect(expectOk(bodyCodec.encode(decoded.doc, BODY))).toBe(BODY);
		// The same text decodes to the same answer.
		expect(bodyCodec.decode(BODY)).toBe(decoded);
	});

	test('one the editor cannot hold decodes to its reasons', () => {
		expect(bodyCodec.decode('<details>x</details>\n')).toEqual({
			supported: false,
			reasons: ['It contains HTML.'],
		});
		expect(bodyCodec.decode('a | b\n|---|---|\n')).toEqual({
			supported: false,
			reasons: ['It contains a table.'],
		});
	});

	test('encoding keeps the blank lines at the start and writes line feeds', () => {
		const two = doc(p(t('one')), p(t('two')));
		expect(expectOk(bodyCodec.encode(two, '\n\none\n'))).toBe(
			'\n\none\n\ntwo\n',
		);
		expect(expectOk(bodyCodec.encode(doc(p()), '\nold\n'))).toBe('\n');
		expect(expectOk(bodyCodec.encode(doc(p(t('new'))), 'old'))).toBe('new\n');
	});

	test('a document Markdown cannot spell is refused with the reason', () => {
		const bold = doc(p(t('a'), t('(b)', ['strong'])));
		expect(expectErr(bodyCodec.encode(bold, 'a(b)\n'))).toContain(
			'cannot be written as Markdown',
		);
	});
});

describe('task markers', () => {
	test('a literal [x] in a bullet list stays text when every item has one', () => {
		const literal = doc(
			n(
				'bullet_list',
				null,
				n('list_item', null, p(t('[x] literal'))),
				n('list_item', null, p(t('[ ] too'))),
			),
		);
		expect(serializeNoteBody(literal)).toBe('* \\[x\\] literal\n* \\[ \\] too');
		expectEquivalent(literal);
	});

	test('any bullet marker makes a task list in source', () => {
		for (const marker of ['-', '*', '+']) {
			const parsed = parseNoteBody(`${marker} [x] a\n${marker} [ ] b`);
			expect(parsed.firstChild?.type.name).toBe('taskList');
			expect(parsed.firstChild?.firstChild?.attrs.checked).toBe(true);
		}
	});

	test('two task lists in a row stay two lists', () => {
		const two = doc(
			n('taskList', null, n('taskItem', { checked: false }, p(t('a')))),
			n('taskList', null, n('taskItem', { checked: true }, p(t('b')))),
		);
		expectEquivalent(two);
	});
});

describe('inline code is literal', () => {
	test('bold cannot be added to code, and a link can', () => {
		const code = schema.mark('code');
		expect(schema.mark('strong').addToSet([code])).toEqual([code]);
		expect(
			schema.mark('link', { href: 'https://e.com' }).addToSet([code]),
		).toHaveLength(2);
	});
});

describe('the schema is bounded', () => {
	test('there is no underline mark and no image node', () => {
		expect(schema.marks.underline).toBeUndefined();
		expect(schema.nodes.image).toBeUndefined();
		expect(Object.keys(schema.marks).sort()).toEqual([
			'code',
			'em',
			'link',
			'strike',
			'strong',
		]);
	});
});
