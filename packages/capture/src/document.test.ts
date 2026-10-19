/**
 * Capture Body Composition Tests
 *
 * Reads capture Markdown as text and thoughts, and checks composed values'
 * output against the literal bytes it must produce. The expectations are
 * written out by hand: they do not come from parsing the result again.
 *
 * Key behaviors:
 * - A thought owns its continuation lines, later paragraphs, nested lists,
 *   lazy continuation, and tab-indented lines; nothing after the list is one
 * - A "## Thoughts" line inside a fence or an HTML comment is not the heading
 * - Zero headings: the body is the text, and a thought appends the section
 * - Two Thoughts headings, prose before the list, or two lists refuse
 *   structured operations and leave the source as it is
 * - Edits replace one span: unknown frontmatter, a byte-order mark, CRLF
 *   lines, original leading and trailing whitespace, and trailing blocks stay
 * - An unclosed fence refuses an append that it would absorb
 * - List edits format positional thought strings as consistent bullet items
 */
import { expect, test } from 'bun:test';
import { fromTextarea } from './document.js';
import {
	type CaptureBody,
	type CaptureBodyReading,
	captureBody,
	composeBody,
	normalizeThought,
	type Refusal,
} from './index.js';

type Edit =
	| { ok: true; source: string }
	| { ok: false; refusal: { code: string; message: string } };

/** A whole capture file read the way an open capture reads its row's body. */
type CaptureDocument = Omit<CaptureBodyReading, 'text'> & {
	readonly source: string;
	readonly refusal: Refusal | undefined;
	readonly text: string | undefined;
};

// Golden file expectations retain their original headers. Only the body goes
// through the codec; Folder's own tests cover frontmatter serialization.
function bodyStart(source: string): number {
	const header = /^\uFEFF?---\r?\n(?:[^\r\n]*\r?\n)*?---\r?\n/.exec(source);
	if (header === null) throw new Error('fixture: a capture file has frontmatter');
	return header[0].length;
}

function parseCapture(source: string): CaptureDocument {
	const result = captureBody.decode(source.slice(bodyStart(source)));
	return result.error === null
		? { ...result.data, source, refusal: undefined }
		: {
				source,
				refusal: result.error,
				text: undefined,
				thoughts: [],
				hasSection: false,
				hasOtherContent: false,
			};
}
function write(document: CaptureDocument, value: CaptureBody): Edit {
	if (document.refusal) return { ok: false, refusal: document.refusal };
	const start = bodyStart(document.source);
	const result = captureBody.encode(
		value,
		document.source.slice(start),
	);
	return result.error === null
		? {
				ok: true,
				source: document.source.slice(0, start) + result.data,
			}
		: { ok: false, refusal: result.error };
}
const setText = (document: CaptureDocument, text: string) =>
	write(document, { text, thoughts: document.thoughts });
const addThought = (document: CaptureDocument, text: string) =>
	write(document, {
		text: document.text ?? '',
		thoughts: [...document.thoughts, text],
	});
const editThought = (document: CaptureDocument, index: number, text: string) =>
	write(document, {
		text: document.text ?? '',
		thoughts: document.thoughts.map((thought, at) =>
			at === index ? text : thought,
		),
	});
const deleteThought = (document: CaptureDocument, index: number) =>
	write(document, {
		text: document.text ?? '',
		thoughts: document.thoughts.filter((_, at) => at !== index),
	});
function swapThoughts(
	document: CaptureDocument,
	from: number,
	to: number,
): Edit {
	if (document.refusal) return { ok: false, refusal: document.refusal };
	const thoughts = [...document.thoughts];
	const first = thoughts[from];
	const second = thoughts[to];
	if (first === undefined || second === undefined) throw new Error('fixture');
	thoughts[from] = second;
	thoughts[to] = first;
	return write(document, { text: document.text ?? '', thoughts });
}

function sourceOf(edit: Edit): string {
	if (!edit.ok) throw new Error(`Refused: ${edit.refusal.message}`);
	return edit.source;
}

function nth(document: CaptureDocument, index: number): number {
	if (document.thoughts[index] === undefined)
		throw new Error(`No thought ${index}`);
	return index;
}

function refusalOf(edit: Edit) {
	if (edit.ok) throw new Error(`Accepted: ${JSON.stringify(edit.source)}`);
	return edit.refusal;
}

const read = (source: string) => {
	const document = parseCapture(source);
	return {
		refusal: document.refusal?.code,
		text: document.text,
		thoughts: document.thoughts,
	};
};

/** The smallest frontmatter a capture file can have: both lines, no fields. */
const HEAD = '---\n---\n';

// ============================================================================
// Reading
// ============================================================================

test('the accepted layout reads as text and ordered thoughts', () => {
	expect(
		read(
			'---\ncapturedAt: 2026-10-01T10:30:00+08:00\n---\n\nThe original capture text.\n\n## Thoughts\n\n- First thought.\n- Another thought.\n  It can continue across multiple lines.\n',
		),
	).toEqual({
		refusal: undefined,
		text: 'The original capture text.',
		thoughts: [
			'First thought.',
			'Another thought.\nIt can continue across multiple lines.',
		],
	});
});

test('an item owns its later paragraph, nested list, fence, and lazy line', () => {
	const source = [
		'---',
		'---',
		'Text',
		'',
		'## Thoughts',
		'',
		'- First',
		'  continues',
		'',
		'  second paragraph',
		'  - nested',
		'    deeper',
		'lazy line',
		'- Second',
		'  ```',
		'  ## Thoughts',
		'  ```',
		'',
	].join('\n');
	expect(read(source)).toEqual({
		refusal: undefined,
		text: 'Text',
		thoughts: [
			'First\ncontinues\n\nsecond paragraph\n- nested\n  deeper\nlazy line',
			'Second\n```\n## Thoughts\n```',
		],
	});
});

test('tab-indented continuation lines belong to their item', () => {
	expect(
		read(`${HEAD}## Thoughts\n\n-\tone\n\ttwo\n- three\n`).thoughts,
	).toEqual(['one\ntwo', 'three']);
});

test('a Thoughts line inside a fence, comment, or quote is not the heading', () => {
	expect(
		read(`${HEAD}a\n\n\`\`\`\n## Thoughts\n\`\`\`\n\n## Thoughts\n\n- real\n`),
	).toEqual({
		refusal: undefined,
		text: 'a\n\n```\n## Thoughts\n```',
		thoughts: ['real'],
	});
	expect(
		read(
			`${HEAD}a\n\n<!--\n## Thoughts\n-->\n\n> ## Thoughts\n\n## Thoughts\n\n- real\n`,
		),
	).toEqual({
		refusal: undefined,
		text: 'a\n\n<!--\n## Thoughts\n-->\n\n> ## Thoughts',
		thoughts: ['real'],
	});
});

test('with no heading the whole body is the text', () => {
	expect(read(`${HEAD}Just some\nMarkdown\n\n- a list\n`)).toEqual({
		refusal: undefined,
		text: 'Just some\nMarkdown\n\n- a list\n',
		thoughts: [],
	});
});

test('blocks after the list and after the next heading are never thoughts', () => {
	const document = parseCapture(
		`${HEAD}T\n\n## Thoughts\n\n- one\n\nTrailing paragraph.\n\n## Later\n\n- not a thought\n`,
	);
	expect(document.thoughts).toEqual(['one']);
	expect(document.hasOtherContent).toBe(true);
});

test('an empty section followed by another heading reads as no thoughts', () => {
	expect(
		read(`${HEAD}T\n\n## Thoughts\n\n## Later\n\n- not a thought\n`),
	).toEqual({
		refusal: undefined,
		text: 'T',
		thoughts: [],
	});
});

test.each([
	[
		'two headings',
		'a\n\n## Thoughts\n\n- x\n\n## Thoughts\n\n- y\n',
		'duplicate-heading',
	],
	[
		'an underlined heading too',
		'Thoughts\n---\n\n## Thoughts\n',
		'duplicate-heading',
	],
	['a level three heading', 'a\n\n### Thoughts\n\n- x\n', 'heading-form'],
	['an underlined heading', 'a\n\nThoughts\n--------\n\n- x\n', 'heading-form'],
	[
		'prose before the list',
		'a\n\n## Thoughts\n\nIntro.\n\n- x\n',
		'section-shape',
	],
	['prose and no list', 'a\n\n## Thoughts\n\nIntro.\n', 'section-shape'],
	[
		'two separated lists',
		'a\n\n## Thoughts\n\n- x\n\nBetween.\n\n- y\n',
		'section-shape',
	],
	['two marker styles', 'a\n\n## Thoughts\n\n- x\n* y\n', 'section-shape'],
	['an ordered list', 'a\n\n## Thoughts\n\n1. x\n', 'section-shape'],
] as const)('%s refuses structured reading and every operation', (_name, body, code) => {
	const document = parseCapture(`${HEAD}${body}`);
	expect(document.refusal?.code).toBe(code);
	expect(document.text).toBeUndefined();
	expect(document.thoughts).toEqual([]);
	const seen = 0;
	for (const edit of [
		setText(document, 'new'),
		addThought(document, 'new'),
		editThought(document, seen, 'new'),
		deleteThought(document, seen),
		swapThoughts(document, seen, 1),
	])
		expect(refusalOf(edit).code).toBe(code);
});

// ============================================================================
// Preservation
// ============================================================================

const PRESERVED =
	'﻿---\r\n# a comment\r\ncapturedAt: 2026-10-01T10:30:00+08:00\r\nunknown: [1, 2]\r\n---\r\n\r\n  Original text  \r\nsecond line\r\n\r\n## Thoughts\r\n\r\n- one\r\n- two\r\n  more\r\n\r\nTrailing paragraph.\r\n\r\n## Later\r\n\r\nbody\r\n';

test('reading reports the text with its own whitespace and LF lines', () => {
	expect(read(PRESERVED)).toEqual({
		refusal: undefined,
		text: '  Original text  \nsecond line',
		thoughts: ['one', 'two\nmore'],
	});
});

test('adding a thought inserts one CRLF item and changes nothing else', () => {
	expect(sourceOf(addThought(parseCapture(PRESERVED), 'three\nlines'))).toBe(
		PRESERVED.replace(
			'- two\r\n  more\r\n',
			'- two\r\n  more\r\n- three\r\n  lines\r\n',
		),
	);
});

test('editing a thought rewrites only that item', () => {
	const document = parseCapture(PRESERVED);
	expect(sourceOf(editThought(document, nth(document, 1), 'changed'))).toBe(
		PRESERVED.replace('- two\r\n  more\r\n', '- changed\r\n'),
	);
});

test('deleting a thought removes its lines and nothing else', () => {
	const document = parseCapture(PRESERVED);
	expect(sourceOf(deleteThought(document, nth(document, 0)))).toBe(
		PRESERVED.replace('- one\r\n', ''),
	);
	expect(sourceOf(deleteThought(document, nth(document, 1)))).toBe(
		PRESERVED.replace('\r\n- two\r\n  more', ''),
	);
});

test('swapping exchanges the two items and keeps the bytes between them', () => {
	const document = parseCapture(PRESERVED);
	const swapped = PRESERVED.replace(
		'- one\r\n- two\r\n  more\r\n',
		'- two\r\n  more\r\n- one\r\n',
	);
	expect(
		sourceOf(swapThoughts(document, nth(document, 1), nth(document, 0))),
	).toBe(swapped);
	expect(
		sourceOf(swapThoughts(document, nth(document, 0), nth(document, 1))),
	).toBe(swapped);
});

test('list edits use consistent spacing while retaining surrounding blank lines', () => {
	const source = `${HEAD}T\n\n## Thoughts\n\n- a\n\n- b\n\nAfter.\n`;
	const document = parseCapture(source);
	expect(sourceOf(addThought(document, 'c'))).toBe(
		`${HEAD}T\n\n## Thoughts\n\n- a\n- b\n- c\n\nAfter.\n`,
	);
	expect(
		sourceOf(swapThoughts(document, nth(document, 0), nth(document, 1))),
	).toBe(`${HEAD}T\n\n## Thoughts\n\n- b\n- a\n\nAfter.\n`);
	expect(sourceOf(deleteThought(document, nth(document, 0)))).toBe(
		`${HEAD}T\n\n## Thoughts\n\n- b\n\nAfter.\n`,
	);
	expect(sourceOf(deleteThought(document, nth(document, 1)))).toBe(
		`${HEAD}T\n\n## Thoughts\n\n- a\n\nAfter.\n`,
	);
});

test('editing the text keeps untouched CRLF lines and every other byte', () => {
	const document = parseCapture(PRESERVED);
	expect(
		sourceOf(setText(document, '  Original text  \nsecond line\nthird')),
	).toBe(PRESERVED.replace('second line\r\n', 'second line\r\nthird\r\n'));
	expect(sourceOf(setText(document, '  Original text  \nsecond line'))).toBe(
		PRESERVED,
	);
});

test('text may begin and end with blank lines and reads back exactly', () => {
	const source = '---\nx: 1\n---\n\na\n\n## Thoughts\n\n- t\n';
	const next = sourceOf(setText(parseCapture(source), '\n  a  \n\n'));
	expect(next).toBe('---\nx: 1\n---\n\n\n  a  \n\n\n\n## Thoughts\n\n- t\n');
	expect(read(next)).toEqual({
		refusal: undefined,
		text: '\n  a  \n\n',
		thoughts: ['t'],
	});
});

test('separators are rewritten only when the text cannot read back between them', () => {
	// No blank line before the heading: a plain edit keeps it that way.
	const tight = '---\nx: 1\n---\na\n## Thoughts\n';
	expect(sourceOf(setText(parseCapture(tight), 'ab'))).toBe(
		'---\nx: 1\n---\nab\n## Thoughts\n',
	);
	// Text ending in a line break needs the blank line to be told apart.
	expect(sourceOf(setText(parseCapture(tight), 'a\n'))).toBe(
		'---\nx: 1\n---\n\na\n\n\n## Thoughts\n',
	);
});

test('the full-source textarea round trip keeps mixed line endings', () => {
	const original = 'one\r\ntwo\nthree\rfour\r\n';
	expect(fromTextarea(original, 'one\ntwo\nthree\nfour\n', '\r\n')).toBe(
		original,
	);
	expect(fromTextarea(original, 'one\ntwo!\nnew\nthree\nfour\n', '\r\n')).toBe(
		'one\r\ntwo!\r\nnew\nthree\rfour\r\n',
	);
});

// ============================================================================
// Sections that do not exist yet, and Markdown that would absorb one
// ============================================================================

test('a thought on external Markdown with no heading appends the section', () => {
	expect(sourceOf(addThought(parseCapture(`${HEAD}Just text`), 'hi'))).toBe(
		`${HEAD}Just text\n\n## Thoughts\n\n- hi\n`,
	);
	expect(sourceOf(addThought(parseCapture(`${HEAD}Just text\n`), 'hi'))).toBe(
		`${HEAD}Just text\n\n## Thoughts\n\n- hi\n`,
	);
	expect(
		sourceOf(addThought(parseCapture('---\nx: 1\n---\n'), 'multi\nline')),
	).toBe('---\nx: 1\n---\n\n## Thoughts\n\n- multi\n  line\n');
});

test('a thought on an empty section lands under the heading, before what follows', () => {
	expect(
		sourceOf(
			addThought(
				parseCapture(`${HEAD}T\n\n## Thoughts\n\n## Later\n\nb\n`),
				'x',
			),
		),
	).toBe(`${HEAD}T\n\n## Thoughts\n\n- x\n\n## Later\n\nb\n`);
	expect(
		sourceOf(addThought(parseCapture(`${HEAD}T\n\n## Thoughts`), 'x')),
	).toBe(`${HEAD}T\n\n## Thoughts\n\n- x\n`);
});

test('an unclosed fence refuses an appended section and leaves the source', () => {
	const document = parseCapture('---\nx: 1\n---\n\ntext\n```\nopen');
	expect(refusalOf(addThought(document, 'hi')).code).toBe('unverified');
});

test('text that would absorb or duplicate the section is refused', () => {
	const document = parseCapture(`${HEAD}a\n\n## Thoughts\n\n- t\n`);
	expect(refusalOf(setText(document, 'a\n```\nopen')).code).toBe('unverified');
	expect(refusalOf(setText(document, 'a\n\n## Thoughts')).code).toBe(
		'unverified',
	);
	expect(sourceOf(setText(document, 'a\n```\nclosed\n```'))).toBe(
		`${HEAD}a\n\`\`\`\nclosed\n\`\`\`\n\n## Thoughts\n\n- t\n`,
	);
});

test('a heading typed inside a thought stays inside that thought', () => {
	const document = parseCapture(`${HEAD}a\n\n## Thoughts\n\n- t\n- u\n`);
	const next = sourceOf(
		editThought(document, nth(document, 0), 'x\n\n## Thoughts'),
	);
	expect(next).toBe(`${HEAD}a\n\n## Thoughts\n\n- x\n\n  ## Thoughts\n- u\n`);
	expect(read(next).thoughts).toEqual(['x\n\n## Thoughts', 'u']);
	expect(read(sourceOf(addThought(document, '  \n '))).thoughts).toEqual([
		't',
		'u',
		'',
	]);
});

test('thought normalization removes blank edges and marker whitespace, and keeps code indentation and interior lines', () => {
	expect(
		normalizeThought(
			'\r\n \t\r\n  first  \r\n \t\r\n  continuation  \r\n\t\r\n',
		),
	).toBe('first  \n\n  continuation  ');
	expect(normalizeThought(' \t\r\n \n\t')).toBe('');
	expect(normalizeThought('  only  ')).toBe('only  ');
	expect(normalizeThought('    code()')).toBe('    code()');
});

// ============================================================================
// New captures
// ============================================================================

test('a new body keeps the text exactly and adds an empty section', () => {
	expect(composeBody('\n  original text  \n\n')).toEqual({
		body: '\n\n  original text  \n\n\n\n## Thoughts\n',
		refusal: undefined,
		absorbed: false,
	});
	expect(
		read(
			`---\ncapturedAt: 2026-01-01T00:00:00.000Z\n---\n${composeBody('\n  original text  \n\n').body}`,
		),
	).toEqual({
		refusal: undefined,
		text: '\n  original text  \n\n',
		thoughts: [],
	});
});

test('pasted text with its own Thoughts list stays source-only after reopening', () => {
	const pasted =
		'Pasted article\n\n## Thoughts\n\n- This belongs to the original article';
	const composed = composeBody(pasted);
	expect(composed.refusal?.code).toBe('duplicate-heading');
	expect(composed.body).toBe(`\n${pasted}\n\n## Thoughts\n`);
	// What the saved file reads as when it is opened again.
	const reopened = parseCapture(
		`---\ncapturedAt: 2026-01-01T00:00:00.000Z\n---\n${composed.body}`,
	);
	expect(reopened.refusal?.code).toBe('duplicate-heading');
	expect(reopened.thoughts).toEqual([]);
	expect(refusalOf(addThought(reopened, 'mine')).code).toBe(
		'duplicate-heading',
	);
});

test('text with an open fence keeps its section in the file and says it is absorbed', () => {
	const composed = composeBody('```\nnever closed');
	expect(composed).toEqual({
		body: '\n```\nnever closed\n\n## Thoughts\n',
		refusal: undefined,
		absorbed: true,
	});
	const reopened = parseCapture(`---\nx: 1\n---\n${composed.body}`);
	expect(reopened.hasSection).toBe(false);
	expect(reopened.thoughts).toEqual([]);
	expect(refusalOf(addThought(reopened, 'mine')).code).toBe('unverified');
});

test('an item that is indented code keeps its code indentation through a list edit', () => {
	const document = parseCapture(
		`${HEAD}T\n\n## Thoughts\n\n-     code()\n      more()\n- b\n`,
	);
	expect(document.thoughts).toEqual(['    code()\n    more()', 'b']);
	const next = sourceOf(editThought(document, nth(document, 1), 'c'));
	expect(next).toBe(
		`${HEAD}T\n\n## Thoughts\n\n-     code()\n      more()\n- c\n`,
	);
	expect(parseCapture(next).thoughts).toEqual(['    code()\n    more()', 'c']);
});

test('deleting the last thought with Markdown after the list is refused with why', () => {
	const document = parseCapture(
		`${HEAD}T\n\n## Thoughts\n\n- only\n\nA paragraph.\n`,
	);
	const refusal = refusalOf(deleteThought(document, nth(document, 0)));
	expect(refusal.message).toContain('The last thought cannot be deleted');
	// With nothing after the list, it is deleted.
	const alone = parseCapture(`${HEAD}T\n\n## Thoughts\n\n- only\n`);
	expect(sourceOf(deleteThought(alone, nth(alone, 0)))).toBe(
		`${HEAD}T\n\n## Thoughts\n\n`,
	);
});
