/**
 * Note Body Markdown Property Tests
 *
 * Builds thousands of random documents from the editor's schema, with text
 * chosen to collide with Markdown syntax, and holds each to the contract:
 * `document -> Markdown -> document` is equivalent, and the Markdown is one
 * the editor would open again.
 *
 * Four generators, four promises:
 * - typing: any characters, in any block, without formatting. Never refused.
 * - table-shaped typing: lines of `|`, `-`, `:`, and backslashes, some in
 *   code, joined by line breaks. Never refused, and never written as a table.
 * - formatting: marks on whole words. Never refused.
 * - adversarial: marks on any text. Some are not expressible in Markdown
 *   (bold that starts with punctuation right after a letter); those must be
 *   refused, never written wrongly.
 *
 * The generators are seeded, so a failure names a document that fails every
 * time until the codec is fixed.
 */
import { expect, test } from 'bun:test';
import type { Mark, Node } from 'prosemirror-model';
import {
	canonicalNoteDoc,
	checkNoteDoc,
	equivalentNoteDocs,
	inspectNoteBody,
	parseNoteBody,
	serializeNoteBody,
} from './markdown.js';
import { noteSchema as schema } from './schema.js';

/** A small deterministic generator (mulberry32). */
function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		int: (max: number) => Math.floor(next() * max),
		pick: <T>(items: readonly T[]): T =>
			items[Math.floor(next() * items.length)] as T,
		chance: (probability: number) => next() < probability,
	};
}
type Random = ReturnType<typeof random>;

/** Fragments of text, weighted toward what Markdown treats as syntax. */
const PIECES = [
	'a',
	'b',
	'word',
	'A',
	' ',
	' ',
	'  ',
	'\t',
	'*',
	'**',
	'_',
	'__',
	'~',
	'~~',
	'`',
	'``',
	'#',
	'# ',
	'## ',
	'>',
	'> ',
	'-',
	'- ',
	'+ ',
	'* ',
	'1.',
	'1. ',
	'2) ',
	'10. ',
	'[',
	']',
	'[x] ',
	'[ ] ',
	'[x]',
	'(',
	')',
	'!',
	'![',
	'<',
	'>',
	'<b>',
	'</b>',
	'<!--',
	'&',
	'&amp;',
	'&#32;',
	';',
	'=',
	'===',
	'---',
	'***',
	'|',
	'\\',
	'\\*',
	'http://e.com',
	'.',
	':',
	'"',
	"'",
];
const WORDS = ['a', 'b', 'word', 'A1', 'x-y', "it's", 'e.g', 'a_b', '2x'];
const MARKS = ['strong', 'em', 'strike', 'code', 'link'] as const;

function pieces(rng: Random): string {
	let result = '';
	for (let count = 1 + rng.int(5); count > 0; count -= 1)
		result += rng.pick(PIECES);
	return result;
}

/** A random set of marks, added the way the editor adds them, so exclusions hold. */
function marks(rng: Random): readonly Mark[] {
	let set: readonly Mark[] = [];
	for (const name of MARKS)
		if (rng.chance(0.2))
			set = schema
				.mark(name, name === 'link' ? { href: 'https://e.com/a' } : null)
				.addToSet(set);
	return set;
}

type Inline = (rng: Random, breaks: boolean) => Node[];

/** Any characters, no formatting. */
const typed: Inline = (rng, breaks) => {
	const nodes: Node[] = [];
	for (let count = rng.int(5); count > 0; count -= 1)
		if (breaks && rng.chance(0.15)) nodes.push(schema.node('hard_break'));
		else nodes.push(schema.text(pieces(rng)));
	return nodes;
};

/** What a table's lines are made of. */
const TABLE_PIECES = ['|', '|', '-', '---', ':', ' ', 'a', '\\', '\\|'];

/** Lines of table syntax, typed, with a line break between most of them. */
const tableShaped: Inline = (rng, breaks) => {
	const nodes: Node[] = [];
	for (let count = 1 + rng.int(4); count > 0; count -= 1) {
		if (breaks && nodes.length > 0 && rng.chance(0.7))
			nodes.push(schema.node('hard_break'));
		let text = '';
		for (let length = 1 + rng.int(6); length > 0; length -= 1)
			text += rng.pick(TABLE_PIECES);
		const last = nodes.at(-1);
		// Adjacent text joins into one node; code makes a separate span.
		const code = rng.chance(0.2) ? [schema.mark('code')] : [];
		if (last?.isText && code.length === 0 && last.marks.length === 0)
			nodes[nodes.length - 1] = schema.text(`${last.text}${text}`);
		else nodes.push(schema.text(text, code));
	}
	return nodes;
};

/** Words separated by spaces, each with its own marks. */
const formatted: Inline = (rng, breaks) => {
	const nodes: Node[] = [];
	for (let count = rng.int(6); count > 0; count -= 1) {
		if (breaks && rng.chance(0.1)) {
			nodes.push(schema.node('hard_break'));
			continue;
		}
		if (nodes.at(-1)?.isText) nodes.push(schema.text(' '));
		nodes.push(schema.text(rng.pick(WORDS), marks(rng)));
	}
	return nodes;
};

/** Any characters with any marks. */
const adversarial: Inline = (rng, breaks) => {
	const nodes: Node[] = [];
	for (let count = rng.int(5); count > 0; count -= 1)
		if (breaks && rng.chance(0.12)) nodes.push(schema.node('hard_break'));
		else nodes.push(schema.text(pieces(rng), marks(rng)));
	return nodes;
};

function block(rng: Random, inline: Inline, depth: number): Node {
	const kind = rng.int(depth > 2 ? 4 : 9);
	const blocks = () =>
		Array.from({ length: 1 + rng.int(2) }, () => block(rng, inline, depth + 1));
	const items = (type: string, attrs: () => object | null) =>
		Array.from({ length: 1 + rng.int(3) }, () =>
			schema.node(type, attrs(), [
				schema.node('paragraph', null, inline(rng, true)),
				...(rng.chance(0.3) ? blocks() : []),
			]),
		);
	switch (kind) {
		case 0:
		case 1:
			return schema.node('paragraph', null, inline(rng, true));
		case 2:
			// A heading is one line; Markdown has no line break inside one.
			return schema.node(
				'heading',
				{ level: 1 + rng.int(6) },
				inline(rng, false),
			);
		case 3:
			return rng.chance(0.5)
				? schema.node('horizontal_rule')
				: schema.node(
						'code_block',
						{ params: rng.pick(['', '', 'ts', 'sh']) },
						rng.chance(0.2)
							? []
							: [
									schema.text(
										`${pieces(rng)}${rng.chance(0.5) ? `\n${pieces(rng)}` : ''}`,
									),
								],
					);
		case 4:
			return schema.node('blockquote', null, blocks());
		case 5:
			return schema.node(
				'bullet_list',
				null,
				items('list_item', () => null),
			);
		case 6:
			return schema.node(
				'ordered_list',
				{ order: rng.pick([1, 1, 3, 10]) },
				items('list_item', () => null),
			);
		default:
			return schema.node(
				'taskList',
				null,
				items('taskItem', () => ({ checked: rng.chance(0.5) })),
			);
	}
}

const document = (rng: Random, inline: Inline) =>
	schema.node(
		'doc',
		null,
		Array.from({ length: 1 + rng.int(4) }, () => block(rng, inline, 0)),
	);

function describeFailure(seed: number, doc: Node): string {
	let markdown = '(serializer threw)';
	let back = '';
	try {
		markdown = serializeNoteBody(doc);
		back = String(canonicalNoteDoc(parseNoteBody(markdown)));
	} catch (cause) {
		back = String(cause);
	}
	return `seed ${seed}\n  document: ${canonicalNoteDoc(doc)}\n  markdown: ${JSON.stringify(markdown)}\n  parsed:   ${back}`;
}

/** Run a generator; return how many documents were refused and the first few. */
function run(inline: Inline, count: number) {
	const refused: string[] = [];
	const unopenable: string[] = [];
	for (let seed = 1; seed <= count; seed += 1) {
		const doc = document(random(seed), inline);
		const check = checkNoteDoc(doc);
		if (!check.ok) {
			refused.push(describeFailure(seed, doc));
			continue;
		}
		// The check is not taken on trust: parse what it returned again.
		if (!equivalentNoteDocs(parseNoteBody(check.markdown), doc))
			throw new Error(`seed ${seed}: an accepted document did not round-trip`);
		const reopened = inspectNoteBody(check.markdown);
		if (!reopened.supported)
			unopenable.push(
				`seed ${seed}: ${JSON.stringify(check.markdown)} (${reopened.reasons.join(' ')})`,
			);
	}
	return { refused, unopenable };
}

/**
 * Each property checks 5,000 documents: under a second alone, but past Bun's
 * five-second default on a loaded CI runner. The budget is for that work, not
 * a retry; a hang still fails.
 */
const PROPERTY_BUDGET_MS = 30_000;

function expectNone(list: string[], what: string) {
	if (list.length > 0)
		throw new Error(
			`${list.length} ${what}. First:\n${list.slice(0, 4).join('\n')}`,
		);
	expect(list).toEqual([]);
}

test(
	'typing any characters in any block is never refused',
	() => {
		const { refused, unopenable } = run(typed, 5000);
		expectNone(refused, 'typed documents were refused');
		expectNone(
			unopenable,
			'typed documents wrote Markdown the editor would not reopen',
		);
	},
	PROPERTY_BUDGET_MS,
);

test(
	'typing table syntax across line breaks is never refused, and never reopens as a table',
	() => {
		const { refused, unopenable } = run(tableShaped, 5000);
		expectNone(refused, 'table-shaped documents were refused');
		expectNone(
			unopenable,
			'table-shaped documents wrote Markdown the editor would not reopen',
		);
	},
	PROPERTY_BUDGET_MS,
);

test(
	'formatting whole words is never refused',
	() => {
		const { refused, unopenable } = run(formatted, 5000);
		expectNone(refused, 'formatted documents were refused');
		expectNone(
			unopenable,
			'formatted documents wrote Markdown the editor would not reopen',
		);
	},
	PROPERTY_BUDGET_MS,
);

test(
	'formatting Markdown cannot express is refused, never written wrongly',
	() => {
		const { refused, unopenable } = run(adversarial, 5000);
		// Accepted documents round-tripped (checked in `run`) and reopen.
		expectNone(
			unopenable,
			'accepted documents wrote Markdown the editor would not reopen',
		);
		// Most random formatting is still expressible; the rest is caught.
		expect(refused.length).toBeLessThan(2500);
	},
	PROPERTY_BUDGET_MS,
);

test('the two known inexpressible cases are refused', () => {
	const p = (...content: Node[]) =>
		schema.node('doc', null, [schema.node('paragraph', null, content)]);
	const bold = [schema.mark('strong')];
	// Bold that opens with punctuation directly after a letter.
	expect(checkNoteDoc(p(schema.text('a'), schema.text('(b)', bold))).ok).toBe(
		false,
	);
	// A line break inside a heading.
	expect(
		checkNoteDoc(
			schema.node('doc', null, [
				schema.node('heading', { level: 1 }, [
					schema.text('a'),
					schema.node('hard_break'),
					schema.text('b'),
				]),
			]),
		).ok,
	).toBe(false);
	// The same bold after a space is fine.
	expect(checkNoteDoc(p(schema.text('a '), schema.text('(b)', bold))).ok).toBe(
		true,
	);
});
