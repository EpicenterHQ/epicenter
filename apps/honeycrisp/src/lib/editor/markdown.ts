/**
 * Markdown for a note's body: the pair of pure functions between the body
 * text in the file and the ProseMirror document the rich-text view edits.
 *
 * The contract is `document -> Markdown -> document`: what the serializer
 * writes parses back to an equivalent document. Equivalent is defined by
 * `canonicalNoteDoc`, and it forgives exactly three things Markdown has no
 * spelling for:
 *
 * - a paragraph with nothing in it;
 * - a line break with nothing after it in its block;
 * - bold, italic, or strikethrough on a whitespace character.
 *
 * Every character of text and every other mark and node is kept. Spaces and
 * tabs at the edge of a block, or beside a line break, are written as
 * character references (`&#32;`, `&#9;`), because Markdown drops them
 * otherwise. Serializing may respell source Markdown (`_a_` becomes `*a*`, a
 * setext heading becomes `#`), which changes no document.
 *
 * `checkNoteDoc` is the gate for a rich-text edit: it returns the Markdown
 * only when the round trip is equivalent and the Markdown holds nothing the
 * gate for opening refuses. `inspectNoteBody` is the gate for opening source
 * as rich text. Source the schema cannot represent is refused with reasons and
 * stays editable as text in the Source view.
 *
 * `bodyCodec` is the pair the rich-text view uses on a note's whole body:
 * `decode` opens it through the opening gate, and `encode` writes a document
 * through the edit gate in the body's own leading blank lines and line endings.
 */
import MarkdownIt from 'markdown-it';
import {
	defaultMarkdownParser,
	defaultMarkdownSerializer,
	MarkdownParser,
	MarkdownSerializer,
} from 'prosemirror-markdown';
import {
	Fragment,
	Mark,
	type MarkType,
	type Node,
	type NodeType,
} from 'prosemirror-model';
import { Err, Ok, type Result } from 'wellcrafted/result';

import { noteSchema } from './schema.js';

// Through `unknown` because the schema's maps are typed by their OrderedMap
// specs, not by name.
const { hard_break, paragraph } = noteSchema.nodes as unknown as Record<
	'hard_break' | 'paragraph',
	NodeType
>;
const { code: codeMark } = noteSchema.marks as unknown as Record<
	'code',
	MarkType
>;

// ── Whitespace Markdown would drop ──────────────────────────────────────────

/**
 * Stand-ins for a space and a tab that Markdown would drop. They are not
 * whitespace, so the serializer leaves them where they are; the finished
 * text has them replaced by character references.
 */
const KEPT_SPACE = '';
const KEPT_TAB = '';
const keep = (text: string) =>
	text.replaceAll(' ', KEPT_SPACE).replaceAll('\t', KEPT_TAB);

const LEADING = /^[ \t]+/;
const TRAILING = /[ \t]+$/;

/**
 * Mark the spaces and tabs Markdown would drop: those at the start or end of
 * a block's text, and those beside a line break. Text in inline code is left
 * alone, since a code span keeps its own spaces and reads no references.
 */
function keepEdgeWhitespace(node: Node): Node {
	if (node.isText) return node;
	const children: Node[] = [];
	node.forEach((child) => {
		children.push(child);
	});
	if (!node.isTextblock)
		return node.copy(Fragment.from(children.map(keepEdgeWhitespace)));
	if (node.type.spec.code) return node;

	const edge = (order: number[], pattern: RegExp) => {
		let atEdge = true;
		for (const index of order) {
			const child = children[index] as Node;
			if (!child.isText) {
				atEdge = child.type === hard_break;
				continue;
			}
			if (!atEdge || codeMark.isInSet(child.marks)) {
				atEdge = false;
				continue;
			}
			const text = child.text ?? '';
			const run = pattern.exec(text)?.[0] ?? '';
			if (run !== '')
				children[index] = noteSchema.text(
					pattern === LEADING
						? keep(run) + text.slice(run.length)
						: text.slice(0, text.length - run.length) + keep(run),
					child.marks,
				);
			// Text that is all whitespace does not end the edge.
			atEdge = run.length === text.length;
		}
	};
	const forward = children.map((_, index) => index);
	edge(forward, LEADING);
	edge(forward.toReversed(), TRAILING);
	return node.copy(Fragment.from(children));
}

// ── Serializing ─────────────────────────────────────────────────────────────

/**
 * How many siblings of the same list type sit directly before this one.
 * Two adjacent lists of one type would read back as a single list, so every
 * other one switches its marker, which is what starts a new list in Markdown.
 */
function adjacentBefore(parent: Node, index: number): number {
	const type = parent.child(index).type;
	let count = 0;
	for (let at = index - 1; at >= 0; at -= 1) {
		const sibling = parent.child(at);
		// A paragraph that writes nothing does not separate two lists.
		if (sibling.type === paragraph && isBlank(sibling)) continue;
		if (sibling.type !== type) break;
		count += 1;
	}
	return count;
}

/** A block that writes no text: nothing in it, or only line breaks. */
function isBlank(block: Node): boolean {
	let blank = true;
	block.forEach((child) => {
		if (child.type !== hard_break) blank = false;
	});
	return blank;
}

/** Escapes the default serializer does not make and this schema needs. */
function escapeMore(text: string, startOfLine: boolean): string {
	const escaped = text
		// A literal `<` would read back as HTML, which the editor refuses.
		.replace(/</g, '\\<')
		// `&amp;` typed as text must not read back as `&`.
		.replace(/&(?=#?[0-9a-zA-Z]+;)/g, '\\&')
		// The default escapes an underscore at a word edge only, which leaves
		// `__b__` half escaped. Escape every underscore in a run of them.
		.replace(/(?:\\?_){2,}/g, (run) =>
			run.replaceAll('\\', '').replaceAll('_', '\\_'),
		);
	if (!startOfLine) return escaped;
	return (
		escaped
			// `1)` and a bare `1.` start a list. The default escapes `1. ` already.
			.replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')
			// `=` under a line of text makes that line a heading.
			.replace(/^=/, '\\=')
			// A line starting `|`, `-`, or `:` can be a table's delimiter row
			// (`|---|`, `:--`) under any line with a pipe, even an escaped one or
			// one in code. The default escapes `-` already.
			.replace(/^[|:]/, '\\$&')
	);
}

type SerializerState = Parameters<
	(typeof defaultMarkdownSerializer.nodes)[string]
>[0];
/**
 * Two fields the serializer state has and its types leave out: the text
 * written so far, and whether the next text starts a line. prosemirror-markdown
 * 1.13 reads and writes both in its own node serializers.
 */
type SerializerInternals = { out: string; atBlockStart: boolean };
const internals = (state: SerializerState) =>
	state as unknown as SerializerInternals;
const extended = new WeakSet<object>();

/** Add `escapeMore` to a serializer state, once. */
function withMoreEscapes(state: SerializerState) {
	if (extended.has(state)) return;
	extended.add(state);
	const esc = state.esc.bind(state);
	state.esc = (text: string, startOfLine = false) => {
		let escaped = esc(text, startOfLine);
		// The default writes `1\. ` with a space whatever followed the dot; put
		// a tab back.
		const numbered = startOfLine ? /^(\s*\d+)\.(\s)/.exec(text) : null;
		if (numbered && numbered[2] !== ' ')
			escaped = escaped.replace(/^(\s*\d+\\\.) /, `$1${numbered[2]}`);
		return escapeMore(escaped, startOfLine);
	};
}

const {
	// Images are outside the schema.
	image: _image,
	...serializerNodes
} = defaultMarkdownSerializer.nodes;
const serializeText = serializerNodes.text as NonNullable<
	typeof serializerNodes.text
>;

/**
 * The backticks around inline code. A span is padded with a space when its
 * text starts or ends with a backtick, and also when it both starts and ends
 * with a space: Markdown strips one space from each side of such a span.
 */
function codeFence(text: string, side: 'open' | 'close'): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? [])
		longest = Math.max(longest, run.length);
	const ticks = '`'.repeat(longest + 1);
	const spaced = /^ [\s\S]* $/.test(text) && /[^ ]/.test(text);
	const pad =
		spaced || (side === 'open' ? text.startsWith('`') : text.endsWith('`'))
			? ' '
			: '';
	return side === 'open' ? ticks + pad : pad + ticks;
}

const isList = (node: Node) =>
	node.type.name === 'bullet_list' ||
	node.type.name === 'ordered_list' ||
	node.type.name === 'taskList';

/**
 * Whether a list can be written without blank lines between its blocks.
 * That holds when each item is one paragraph, optionally followed by lists
 * that can start directly under that text: an ordered list that does not
 * start at 1 cannot, and neither can a list whose first item is empty. Any
 * other shape is written loose.
 */
function canBeTight(list: Node): boolean {
	let tight = true;
	list.forEach((item) => {
		item.forEach((child, _offset, index) => {
			if (index === 0) return;
			const firstText = child.firstChild?.firstChild;
			if (
				!isList(child) ||
				(child.type.name === 'ordered_list' &&
					(child.attrs.order || 1) !== 1) ||
				!firstText ||
				isBlank(firstText)
			)
				tight = false;
		});
	});
	return tight;
}

function renderList(
	state: SerializerState,
	node: Node,
	indent: string,
	marker: (index: number) => string,
) {
	const options = state.options as { tightLists?: boolean };
	const outer = options.tightLists;
	options.tightLists = canBeTight(node);
	state.renderList(node, indent, marker);
	options.tightLists = outer;
}

const serializer = new MarkdownSerializer(
	{
		...serializerNodes,
		text(state, node, parent, index) {
			withMoreEscapes(state);
			// Text after a line break starts a line, where `#`, `-`, and `1.`
			// would start a block.
			if (index > 0 && parent.child(index - 1).type === hard_break)
				internals(state).atBlockStart = true;
			serializeText(state, node, parent, index);
		},
		heading(state, node) {
			state.write(`${state.repeat('#', node.attrs.level)} `);
			const written = internals(state);
			const start = written.out.length;
			state.renderInline(node, false);
			// `# A #` reads the last `#` as the heading's close; escape it.
			written.out =
				written.out.slice(0, start) +
				written.out.slice(start).replace(/(^|[ \t])(#+)$/, '$1\\$2');
			state.closeBlock(node);
		},
		bullet_list(state, node, parent, index) {
			// `-` is the task list's marker, so a bullet list never uses it and
			// a bullet list beside a task list stays a separate list.
			const marker = adjacentBefore(parent, index) % 2 === 0 ? '* ' : '+ ';
			renderList(state, node, '  ', () => marker);
		},
		ordered_list(state, node, parent, index) {
			const start: number = node.attrs.order || 1;
			const width = String(start + node.childCount - 1).length;
			const delimiter = adjacentBefore(parent, index) % 2 === 0 ? '.' : ')';
			renderList(state, node, state.repeat(' ', width + 2), (item) => {
				const number = String(start + item);
				return `${state.repeat(' ', width - number.length)}${number}${delimiter} `;
			});
		},
		list_item(state, node) {
			// An item that opens with empty paragraphs is written as its other
			// blocks alone (`* # Heading`): a blank first line followed by a blank
			// line would end the item. The parser puts one empty paragraph back.
			let skip = 0;
			let size = 0;
			while (
				skip < node.childCount - 1 &&
				node.child(skip).type === paragraph &&
				isBlank(node.child(skip))
			) {
				size += node.child(skip).nodeSize;
				skip += 1;
			}
			state.renderContent(
				skip === 0 ? node : node.copy(node.content.cut(size)),
			);
		},
		taskList(state, node, parent, index) {
			// A task list beside a task list switches to `+`, as bullet lists do.
			// A bullet list never follows with the same marker: it restarts at `*`.
			const marker = adjacentBefore(parent, index) % 2 === 0 ? '-' : '+';
			renderList(state, node, '  ', (item) =>
				node.child(item).attrs.checked ? `${marker} [x] ` : `${marker} [ ] `,
			);
		},
		taskItem(state, node) {
			state.renderContent(node);
		},
	},
	{
		...defaultMarkdownSerializer.marks,
		strike: {
			open: '~~',
			close: '~~',
			mixable: true,
			expelEnclosingWhitespace: true,
		},
		code: {
			open: (_state, _mark, parent, index) =>
				codeFence(parent.child(index).text ?? '', 'open'),
			close: (_state, _mark, parent, index) =>
				codeFence(parent.child(index - 1).text ?? '', 'close'),
			escape: false,
		},
	},
);

export function serializeNoteBody(body: Node): string {
	return (
		serializer
			.serialize(keepEdgeWhitespace(body), { tightLists: true })
			// An empty paragraph at the start writes a blank line: no content, and
			// a change to the body all the same.
			.replace(/^\n+/, '')
			.replaceAll(KEPT_SPACE, '&#32;')
			.replaceAll(KEPT_TAB, '&#9;')
	);
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * CommonMark plus strikethrough, matching what the serializer emits. Inline
 * HTML is not interpreted: `inspectNoteBody` refuses a body that contains
 * any, so it never reaches the rich-text view as literal text either.
 */
const tokenizer = MarkdownIt('commonmark', { html: false }).enable(
	'strikethrough',
);

/**
 * `[x] ` at the head of a list item's first paragraph, GFM's task marker,
 * matched against the source so an escaped `\[x\]` is text, not a marker.
 * A bare `[ ]` is an empty task: the serializer writes one for an item with
 * no text yet.
 */
const TASK_MARKER = /^\[([ xX])\](?: |$)/;

type Token = ReturnType<typeof tokenizer.parse>[number];

/**
 * Retag every task-shaped bullet list as a task list. markdown-it reads a
 * task list as a bullet list with the marker as text. A list converts only
 * when every item carries the marker, because a task list holds nothing but
 * task items; a list mixing both stays a bullet list with visible markers.
 */
tokenizer.core.ruler.push('honeycrisp_task_lists', (state) => {
	const tokens: Token[] = state.tokens;
	for (let open = 0; open < tokens.length; open += 1) {
		const list = tokens[open] as Token;
		if (list.type !== 'bullet_list_open') continue;
		const items: {
			open: Token;
			close: Token;
			inline: Token;
			checked: boolean;
		}[] = [];
		let close = open + 1;
		let shaped = true;
		for (; close < tokens.length; close += 1) {
			const token = tokens[close] as Token;
			if (token.type === 'bullet_list_close' && token.level === list.level)
				break;
			if (token.level !== list.level + 1) continue;
			if (token.type === 'list_item_close') {
				const item = items.at(-1);
				if (item) item.close = token;
				continue;
			}
			if (token.type !== 'list_item_open') continue;
			const inline = tokens[close + 2];
			const marker =
				tokens[close + 1]?.type === 'paragraph_open' &&
				inline?.type === 'inline' &&
				inline.children?.[0]?.type === 'text'
					? TASK_MARKER.exec(inline.content)
					: null;
			if (
				marker === null ||
				!inline?.children?.[0]?.content.startsWith(marker[0])
			) {
				shaped = false;
				break;
			}
			items.push({
				open: token,
				close: token,
				inline,
				checked: marker[1] !== ' ',
			});
		}
		if (!shaped || items.length === 0) continue;
		list.type = 'task_list_open';
		(tokens[close] as Token).type = 'task_list_close';
		for (const item of items) {
			item.open.type = 'task_item_open';
			item.open.attrSet('checked', String(item.checked));
			item.close.type = 'task_item_close';
			const length = (
				TASK_MARKER.exec(item.inline.content) as RegExpExecArray
			)[0].length;
			item.inline.content = item.inline.content.slice(length);
			const first = (item.inline.children as Token[])[0] as Token;
			first.content = first.content.slice(length);
			if (first.content === '') item.inline.children?.shift();
		}
	}
});

const { image: _imageToken, ...parserTokens } = defaultMarkdownParser.tokens;

const parser = new MarkdownParser(noteSchema, tokenizer, {
	...parserTokens,
	s: { mark: 'strike' },
	task_list: { block: 'taskList' },
	task_item: {
		block: 'taskItem',
		getAttrs: (token) => ({ checked: token.attrGet('checked') === 'true' }),
	},
});

/** Parse body text. Throws on a construct the schema has no node for. */
export function parseNoteBody(text: string): Node {
	return parser.parse(text);
}

// ── Equivalence ─────────────────────────────────────────────────────────────

/** Bold, italic, and strikethrough: marks Markdown cannot put on whitespace alone. */
const DELIMITED = new Set(['strong', 'em', 'strike']);

/**
 * The document with the three things Markdown cannot spell taken out: empty
 * paragraphs, a line break that ends its block, and bold, italic, or
 * strikethrough on whitespace. Two documents with equal canonical forms hold
 * the same text and formatting.
 */
export function canonicalNoteDoc(node: Node): Node {
	if (node.isText) return node;
	if (node.isTextblock) {
		if (node.type.spec.code) return node;
		const pieces: Node[] = [];
		const push = (piece: Node) => {
			const last = pieces.at(-1);
			if (last?.isText && piece.isText && Mark.sameSet(last.marks, piece.marks))
				pieces[pieces.length - 1] = noteSchema.text(
					(last.text ?? '') + (piece.text ?? ''),
					last.marks,
				);
			else pieces.push(piece);
		};
		node.forEach((child) => {
			if (
				!child.isText ||
				!child.marks.some((mark) => DELIMITED.has(mark.type.name))
			) {
				push(child);
				return;
			}
			const plain = child.marks.filter(
				(mark) => !DELIMITED.has(mark.type.name),
			);
			for (const part of (child.text ?? '').split(/(\s+)/))
				if (part !== '')
					push(noteSchema.text(part, /^\s+$/.test(part) ? plain : child.marks));
		});
		while (pieces.at(-1)?.type === hard_break) pieces.pop();
		return node.copy(Fragment.from(pieces));
	}
	const children: Node[] = [];
	node.forEach((child) => {
		// Canonical first: a paragraph holding only a line break is empty too.
		const canonical = canonicalNoteDoc(child);
		if (canonical.type === paragraph && canonical.content.size === 0) return;
		children.push(canonical);
	});
	// A parent that needs content keeps one empty paragraph, as the parser does.
	const content = Fragment.from(children);
	return node.type.validContent(content)
		? node.copy(content)
		: (node.type.createAndFill(node.attrs, content, node.marks) ?? node);
}

/** Whether two documents hold the same text and formatting. */
export function equivalentNoteDocs(left: Node, right: Node): boolean {
	return canonicalNoteDoc(left).eq(canonicalNoteDoc(right));
}

export type DocCheck =
	| { readonly ok: true; readonly markdown: string }
	| { readonly ok: false; readonly reason: string };

const WOULD_CHANGE =
	'This cannot be written as Markdown without changing it. Use Source for this part.';

/**
 * Serialize a document only if its Markdown opens again as the same document:
 * it holds nothing `inspectNoteBody` refuses, and it parses back to an
 * equivalent document. An edit that fails this is refused before it is shown,
 * so what is on screen and what is in the note never differ in content.
 */
export function checkNoteDoc(doc: Node): DocCheck {
	try {
		const markdown = serializeNoteBody(doc);
		return refusedIn(markdown).size === 0 &&
			equivalentNoteDocs(parseNoteBody(markdown), doc)
			? { ok: true, markdown }
			: { ok: false, reason: WOULD_CHANGE };
	} catch {
		return { ok: false, reason: WOULD_CHANGE };
	}
}

// ── Opening source as rich text ─────────────────────────────────────────────

/**
 * A second tokenizer that recognizes what the editor refuses: raw HTML,
 * images, and GFM tables. It only detects; nothing is parsed from it.
 */
const detector = MarkdownIt('commonmark', { html: true }).enable([
	'strikethrough',
	'table',
]);

const REFUSED: Record<string, string> = {
	html_block: 'HTML',
	html_inline: 'HTML',
	image: 'an image',
	table_open: 'a table',
};

/** What in `text` the editor refuses: HTML, an image, a table. */
function refusedIn(text: string): Set<string> {
	const reasons = new Set<string>();
	type Token = ReturnType<typeof detector.parse>[number];
	const visit = (tokens: readonly Token[]) => {
		for (const token of tokens) {
			const reason = REFUSED[token.type];
			if (reason !== undefined) reasons.add(reason);
			if (token.children) visit(token.children);
		}
	};
	visit(detector.parse(text, {}));
	return reasons;
}

export type BodyInspection =
	| { readonly supported: true; readonly doc: Node }
	| { readonly supported: false; readonly reasons: readonly string[] };

/**
 * Whether body text can be edited as rich text without changing its meaning.
 *
 * Supported means: it has no construct outside the schema, it parses, and the
 * parsed document passes `checkNoteDoc`.
 */
export function inspectNoteBody(text: string): BodyInspection {
	const reasons = refusedIn(text);
	if (reasons.size > 0)
		return {
			supported: false,
			reasons: [...reasons].map((reason) => `It contains ${reason}.`),
		};
	let doc: Node;
	try {
		doc = parseNoteBody(text);
	} catch (cause) {
		return {
			supported: false,
			reasons: [
				`It contains Markdown the editor cannot read: ${cause instanceof Error ? cause.message : String(cause)}`,
			],
		};
	}
	if (!checkNoteDoc(doc).ok)
		return {
			supported: false,
			reasons: [
				'Saving it from the rich-text editor would change its content.',
			],
		};
	return { supported: true, doc };
}

// ── A note's body ───────────────────────────────────────────────────────────

/**
 * The last body decoded, and its answer. The view, its edits, and its check
 * of the body all decode one body until it changes, and the answer depends on
 * nothing but the text.
 */
let decoded:
	| { readonly body: string; readonly inspection: BodyInspection }
	| undefined;

/** A note's whole body text, as the rich-text view reads and writes it. */
export const bodyCodec = {
	/** The body as a document (`inspectNoteBody`), or why it cannot be one. */
	decode(body: string): BodyInspection {
		if (decoded?.body === body) return decoded.inspection;
		const inspection = inspectNoteBody(body);
		decoded = { body, inspection };
		return inspection;
	},
	/**
	 * `doc` as the body that replaces `prior`, or why Markdown cannot spell it
	 * (`checkNoteDoc`). The blank lines at the start of `prior` are kept, and
	 * the text ends with one line break. A body is read with line feeds
	 * (ADR-0572), so the text is written with them.
	 */
	encode(doc: Node, prior: string): Result<string, string> {
		const check = checkNoteDoc(doc);
		if (!check.ok) return Err(check.reason);
		const lead = /^\n*/.exec(prior)?.[0] ?? '';
		return Ok(check.markdown === '' ? lead : `${lead}${check.markdown}\n`);
	},
};
