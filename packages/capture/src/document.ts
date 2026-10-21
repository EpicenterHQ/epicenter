/**
 * Capture's interpretation of a Markdown body. Folder owns frontmatter and
 * publication; this module owns the capture text, ordered thoughts, and source
 * spans that must survive structured edits.
 *
 * Thoughts are strings selected by position. List edits use consistent bullet
 * formatting; the editing session owns protection against stale positions.
 * Encode accepts one complete desired value and the current body, then verifies
 * that Markdown reads back as intended. Source remains available for repair.
 */
import MarkdownIt from 'markdown-it';
import { Err, Ok, type Result } from 'wellcrafted/result';

export type Newline = '\n' | '\r\n';

export type RefusalCode =
	| 'duplicate-heading'
	| 'heading-form'
	| 'section-shape'
	| 'unverified';

export type Refusal = { readonly code: RefusalCode; readonly message: string };

type Edit =
	| { readonly ok: true; readonly source: string }
	| { readonly ok: false; readonly refusal: Refusal };

/** Offsets into a body: `start` inclusive, `end` exclusive. */
export type Span = { readonly start: number; readonly end: number };

/** Offsets into `source`. Meaningful only with the document that holds them. */
type Layout = {
	/** The first offset after the frontmatter's closing line. */
	readonly bodyStart: number;
	/** The capture text's exact span. */
	readonly text: Span;
	/** Start of the heading line, or the end of the source. */
	readonly regionEnd: number;
	/** The `## Thoughts` line, without its terminator. */
	readonly heading: Span | undefined;
	readonly items: readonly Span[];
};

/** A body as read: its text and thoughts, or why they are not offered. */
type CaptureDocument = {
	readonly source: string;
	/** The line ending new lines are written with. */
	readonly newline: Newline;
	/** Why structured editing is unavailable, when it is. */
	readonly refusal: Refusal | undefined;
	/** The capture text with LF lines; `undefined` when refused. */
	readonly text: string | undefined;
	/** Empty when refused or when there is no Thoughts section. */
	readonly thoughts: string[];
	/** Whether the source has its `## Thoughts` heading. */
	readonly hasSection: boolean;
	/**
	 * Whether the source holds Markdown the structured view does not show:
	 * blocks after the thoughts list, or anything from the next heading on.
	 */
	readonly hasOtherContent: boolean;
	/** Source offsets used internally for reconstruction. */
	readonly layout: Layout | undefined;
};

const THOUGHTS = 'thoughts';
const markdown = new MarkdownIt('commonmark');

// ============================================================================
// Lines
// ============================================================================

type Line = {
	readonly start: number;
	/** End of the line's content, before its terminator. */
	readonly end: number;
};

/** The same lines markdown-it counts: `\r\n`, `\n`, and a lone `\r` each end one. */
function lineTable(source: string, from: number): Line[] {
	const lines: Line[] = [];
	let start = from;
	while (start <= source.length) {
		let end = start;
		while (end < source.length && source[end] !== '\n' && source[end] !== '\r')
			end++;
		lines.push({ start, end });
		if (end >= source.length) break;
		start = end + (source[end] === '\r' && source[end + 1] === '\n' ? 2 : 1);
	}
	return lines;
}

/** A line's content with up to `columns` of leading whitespace removed. */
function dedent(text: string, columns: number): string {
	let column = 0;
	let cursor = 0;
	while (
		cursor < text.length &&
		column < columns &&
		(text[cursor] === ' ' || text[cursor] === '\t')
	) {
		column += text[cursor] === '\t' ? 4 - (column % 4) : 1;
		cursor++;
	}
	return text.slice(cursor);
}

/** Text as a textarea shows it: every line ending is a line feed. */
export function toTextarea(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

// ============================================================================
// Reading
// ============================================================================

const TERMINATOR = /(?:\r\n|\n|\r)$/;

function refused(
	source: string,
	newline: Newline,
	code: RefusalCode,
	message: string,
): CaptureDocument {
	return {
		source,
		newline,
		refusal: { code, message },
		text: undefined,
		thoughts: [],
		hasSection: false,
		hasOtherContent: false,
		layout: undefined,
	};
}

/** A root block as markdown-it reported it. */
type RootBlock = {
	readonly type: string;
	readonly first: number;
	/** Exclusive. */
	readonly last: number;
	readonly markup: string;
	readonly tag: string;
	/** A heading's text. */
	readonly content: string;
	/** A list's direct items, as line ranges. */
	readonly items: readonly { readonly first: number; readonly last: number }[];
};

function rootBlocks(body: string): RootBlock[] {
	const tokens = markdown.parse(body, {});
	const blocks: RootBlock[] = [];
	for (let at = 0; at < tokens.length; at++) {
		const token = tokens[at];
		if (token === undefined || token.level !== 0 || token.nesting < 0) continue;
		if (token.map === null) continue;
		const items: { first: number; last: number }[] = [];
		let content = '';
		if (token.type === 'heading_open') content = tokens[at + 1]?.content ?? '';
		if (token.type === 'bullet_list_open')
			for (let inner = at + 1; inner < tokens.length; inner++) {
				const child = tokens[inner];
				if (child === undefined || child.level === 0) break;
				if (
					child.type === 'list_item_open' &&
					child.level === 1 &&
					child.map !== null
				)
					items.push({ first: child.map[0], last: child.map[1] });
			}
		blocks.push({
			type: token.type,
			first: token.map[0],
			last: token.map[1],
			markup: token.markup,
			tag: token.tag,
			content,
			items,
		});
	}
	return blocks;
}

function parseBody(source: string): CaptureDocument {
	const bodyStart = 0;
	const newline: Newline = source.includes('\r\n') ? '\r\n' : '\n';
	const lines = lineTable(source, bodyStart);
	const blocks = rootBlocks(source.slice(bodyStart));
	const lineText = (at: number) => {
		const line = lines[at] as Line;
		return source.slice(line.start, line.end);
	};

	const named = blocks.filter(
		(block) =>
			block.type === 'heading_open' &&
			block.content.trim().toLowerCase() === THOUGHTS,
	);
	if (named.length > 1)
		return refused(
			source,
			newline,
			'duplicate-heading',
			`${named.length} headings read "Thoughts". The thoughts list needs exactly one.`,
		);
	const heading = named[0];
	if (
		heading !== undefined &&
		(heading.tag !== 'h2' ||
			!heading.markup.startsWith('#') ||
			!lineText(heading.first).startsWith('##'))
	)
		return refused(
			source,
			newline,
			'heading-form',
			'The Thoughts heading must be written as "## Thoughts" at the start of a line.',
		);

	const headingLine =
		heading === undefined ? undefined : (lines[heading.first] as Line);
	const regionEnd = headingLine?.start ?? source.length;

	// The capture text, between its separators: one blank line after
	// frontmatter, and one before the heading.
	let textStart = bodyStart;
	const lead = /^(?:\r\n|\n|\r)/.exec(source.slice(bodyStart, regionEnd));
	if (lead) textStart += lead[0].length;
	let textEnd = regionEnd;
	if (headingLine !== undefined)
		for (let count = 0; count < 2; count++) {
			const trail = TERMINATOR.exec(source.slice(textStart, textEnd));
			if (!trail) break;
			textEnd -= trail[0].length;
		}

	const items: Span[] = [];
	const thoughts: string[] = [];
	let hasOtherContent = false;
	if (heading !== undefined) {
		const from = blocks.indexOf(heading) + 1;
		let to = from;
		while (to < blocks.length && blocks[to]?.type !== 'heading_open') to++;
		const section = blocks.slice(from, to);
		const list = section[0];
		if (
			list !== undefined &&
			(list.type !== 'bullet_list_open' ||
				section.slice(1).some((block) => block.type === 'bullet_list_open'))
		)
			return refused(
				source,
				newline,
				'section-shape',
				list.type !== 'bullet_list_open'
					? 'The Thoughts section must start with its bulleted list. Other Markdown sits between the heading and the list, so it is unclear which items are thoughts.'
					: 'The Thoughts section holds more than one bulleted list, so it is unclear which items are thoughts.',
			);
		hasOtherContent = to < blocks.length || section.length > 1;
		for (const item of list?.items ?? []) {
			// markdown-it's range can run past the item's last line of content.
			let last = Math.min(item.last, lines.length) - 1;
			while (last > item.first && lineText(last).trim() === '') last--;
			const first = lineText(item.first);
			const match = /^([ \t]*)([-*+])([ \t]*)(.*)$/.exec(first);
			if (match === null) continue;
			const [, lead = '', marker = '-', gap = '', content = ''] = match;
			let column = 0;
			for (const char of lead) column += char === '\t' ? 4 - (column % 4) : 1;
			column += marker.length;
			let gapColumns = 0;
			for (const char of gap) {
				const width = char === '\t' ? 4 - ((column + gapColumns) % 4) : 1;
				gapColumns += width;
			}
			// Five or more columns after the marker begin indented code in the
			// item: the content starts one column after the marker, and the rest
			// of the gap is the code's indentation, kept so it renders as code.
			const code = content !== '' && gapColumns >= 5;
			const contentIndent = column + (content === '' || code ? 1 : gapColumns);
			const body = [code ? `${' '.repeat(gapColumns - 1)}${content}` : content];
			for (let at = item.first + 1; at <= last; at++) {
				const line = lineText(at);
				body.push(line.trim() === '' ? '' : dedent(line, contentIndent));
			}
			items.push({
				start: (lines[item.first] as Line).start,
				end: (lines[last] as Line).end,
			});
			thoughts.push(body.join('\n'));
		}
	}

	return {
		source,
		newline,
		refusal: undefined,
		text: toTextarea(source.slice(textStart, textEnd)),
		thoughts,
		hasSection: heading !== undefined,
		hasOtherContent,
		layout: {
			bodyStart,
			text: { start: textStart, end: textEnd },
			regionEnd,
			heading:
				headingLine === undefined
					? undefined
					: { start: headingLine.start, end: headingLine.end },
			items,
		},
	};
}

// ============================================================================
// Textarea input
// ============================================================================

/**
 * Carry a textarea's value back into text that may use other line endings.
 *
 * A textarea reports every line ending as a line feed. Replacing the original
 * with that value would rewrite every CRLF in the file. Instead, the unchanged
 * start and end of the value are matched against the original, those parts of
 * the original are kept byte for byte, and only the changed middle is written,
 * with `newline` for its line endings.
 */
export function fromTextarea(
	original: string,
	value: string,
	newline: Newline,
): string {
	// offsets[k] is where the k-th character of the textarea form sits in `original`.
	const offsets: number[] = [];
	let shown = '';
	for (let at = 0; at < original.length; at++) {
		offsets.push(at);
		if (original[at] === '\r') {
			shown += '\n';
			if (original[at + 1] === '\n') at++;
		} else shown += original[at];
	}
	offsets.push(original.length);
	const incoming = toTextarea(value);
	if (incoming === shown) return original;
	const limit = Math.min(shown.length, incoming.length);
	let prefix = 0;
	while (prefix < limit && shown[prefix] === incoming[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		shown[shown.length - 1 - suffix] === incoming[incoming.length - 1 - suffix]
	)
		suffix++;
	const middle = incoming.slice(prefix, incoming.length - suffix);
	return (
		original.slice(0, offsets[prefix]) +
		(newline === '\n' ? middle : middle.replace(/\n/g, newline)) +
		original.slice(offsets[shown.length - suffix])
	);
}

// ============================================================================
// Operations
// ============================================================================

const refuse = (code: RefusalCode, message: string): Edit => ({
	ok: false,
	refusal: { code, message },
});

/**
 * A thought's text as it is stored: LF lines, no blank edges, and no
 * whitespace-only lines. Markdown reads up to three spaces or a tab after a
 * list marker as part of the marker, so that leading whitespace is dropped;
 * four spaces start indented code, which reads back and stays.
 */
export function normalizeThought(text: string): string {
	return toTextarea(text)
		.split('\n')
		.map((line) => (line.trim() === '' ? '' : line))
		.join('\n')
		.replace(/^\n+|\n+$/g, '')
		.replace(/^(?! {4})[ \t]+/, '');
}

function renderItem(
	lead: string,
	marker: string,
	text: string,
	newline: Newline,
): string {
	const [first = '', ...rest] = text.split('\n');
	const indent = `${lead}${' '.repeat(marker.length + 1)}`;
	return [
		`${lead}${marker}${first === '' ? '' : ` ${first}`}`,
		...rest.map((line) => (line === '' ? '' : `${indent}${line}`)),
	].join(newline);
}

/** One thought written as a root-level bullet item. */
function renderThought(text: string, newline: Newline = '\n'): string {
	return renderItem('', '-', normalizeThought(text), newline);
}

function sameThoughts(actual: string[], expected: readonly string[]): boolean {
	return (
		actual.length === expected.length &&
		actual.every((thought, index) => thought === expected[index])
	);
}

/** Why `source` does not read back as exactly this text and these thoughts. */
function readsBack(
	source: string,
	expected: { text: string; thoughts: readonly string[] },
): Refusal | undefined {
	const result = parseBody(source);
	if (result.refusal !== undefined) return result.refusal;
	if (
		result.text !== expected.text ||
		!sameThoughts(result.thoughts, expected.thoughts)
	)
		return {
			code: 'unverified',
			message:
				'Markdown around it, such as an unclosed code fence or HTML comment, would absorb or change it.',
		};
	return undefined;
}

/**
 * Accept `source` only if it reads back as intended. This is what makes a
 * splice safe: whatever the surrounding Markdown does to it, the result is
 * checked, not assumed.
 */
function verified(
	source: string,
	expected: { text: string; thoughts: readonly string[] },
	what: string,
): Edit {
	const problem = readsBack(source, expected);
	if (problem === undefined) return { ok: true, source };
	return refuse(
		'unverified',
		`${what} would not read back as written. ${problem.message}`,
	);
}

function ready(
	document: CaptureDocument,
): { layout: Layout; text: string } | Refusal {
	if (document.refusal !== undefined) return document.refusal;
	return {
		layout: document.layout as Layout,
		text: document.text as string,
	};
}

const splice = (source: string, span: Span, replacement: string) =>
	source.slice(0, span.start) + replacement + source.slice(span.end);

/**
 * Replace the capture text. `text` is a textarea value.
 *
 * The separators around the text are kept as they are. Only when the text
 * could not read back between them (text ending in a line break before a
 * heading with no blank line, for example) are they written as one blank line
 * at the body's start and one before the heading.
 */
function setText(document: CaptureDocument, text: string): Edit {
	const state = ready(document);
	if ('code' in state) return { ok: false, refusal: state };
	const { layout } = state;
	const { source, newline } = document;
	const current = source.slice(layout.text.start, layout.text.end);
	const next = fromTextarea(current, text, newline);
	if (next === current) return { ok: true, source };
	const expected = {
		text: toTextarea(next),
		thoughts: document.thoughts,
	};
	const kept = splice(source, layout.text, next);
	if (readsBack(kept, expected) === undefined)
		return { ok: true, source: kept };
	return verified(
		splice(
			source,
			{ start: layout.bodyStart, end: layout.regionEnd },
			newline +
				next +
				(layout.heading === undefined ? '' : `${newline}${newline}`),
		),
		expected,
		'This text',
	);
}

/** The complete structured value written by the Capture view. */
export type CaptureBody = {
	text: string;
	thoughts: string[];
};

/** Information a view needs in addition to the complete structured value. */
export type CaptureBodyReading = CaptureBody & {
	hasSection: boolean;
	hasOtherContent: boolean;
};

/** Reads and reconstructs a Markdown body while preserving untouched source. */
export const captureBody = {
	decode(body: string): Result<CaptureBodyReading, Refusal> {
		const document = parseBody(body);
		if (document.refusal !== undefined) return Err(document.refusal);
		return Ok({
			text: document.text as string,
			thoughts: document.thoughts,
			hasSection: document.hasSection,
			hasOtherContent: document.hasOtherContent,
		});
	},
	/**
	 * Where each thought sits in `body`, in order: from its bullet marker to
	 * the end of its last line with content, without the line ending.
	 */
	locate(body: string): Result<{ thoughts: readonly Span[] }, Refusal> {
		const document = parseBody(body);
		if (document.refusal !== undefined) return Err(document.refusal);
		return Ok({ thoughts: (document.layout as Layout).items });
	},
	encode(value: CaptureBody, body: string): Result<string, Refusal> {
		const document = parseBody(body);
		if (document.refusal !== undefined) return Err(document.refusal);
		const layout = document.layout as Layout;
		let source = body;
		const changedThoughts = !sameThoughts(document.thoughts, value.thoughts);
		const desired = changedThoughts
			? value.thoughts.map(normalizeThought)
			: value.thoughts;
		if (changedThoughts) {
			const first = layout.items[0];
			const last = layout.items.at(-1);
			if (first && last) {
				const replacement = desired
					.map((text) => renderItem('', '-', text, document.newline))
					.join(document.newline);
				const terminator = /^(?:\r\n|\n|\r)/.exec(body.slice(last.end));
				const end =
					desired.length === 0
						? last.end + (terminator?.[0].length ?? 0)
						: last.end;
				source = splice(body, { start: first.start, end }, replacement);
				if (desired.length > 0 && last.end === body.length)
					source += document.newline;
			} else if (desired.length > 0) {
				const list = desired
					.map((text) => renderItem('', '-', text, document.newline))
					.join(document.newline);
				const newline = document.newline;
				if (layout.heading !== undefined) {
					const at = layout.heading.end;
					source = splice(
						body,
						{ start: at, end: at },
						`${newline}${newline}${list}`,
					);
					if (at === body.length) source += newline;
				} else {
					// Append a section without rewriting the original text's separators.
					const gap =
						body === ''
							? newline
							: /\n[ \t]*\n$/.test(toTextarea(body)) ||
									/^[ \t]*\n$/.test(toTextarea(body))
								? ''
								: TERMINATOR.test(body)
									? newline
									: `${newline}${newline}`;
					source = `${body}${gap}## Thoughts${newline}${newline}${list}${newline}`;
				}
			}
		}
		// With no original section, appending one keeps existing text bytes and
		// consumes its trailing separator lines, as creating that section always did.
		if (value.text !== document.text) {
			const edit = setText(parseBody(source), value.text);
			if (!edit.ok) return Err(edit.refusal);
			source = edit.source;
		}
		const expectedText =
			!document.hasSection && desired.length > 0 && value.text === document.text
				? value.text.replace(/\n+$/, '')
				: toTextarea(value.text);
		const problem = readsBack(source, {
			text: expectedText,
			thoughts: desired,
		});
		if (problem === undefined) return Ok(source);
		// With no list left, what follows the heading would read as the section's start.
		if (problem.code === 'section-shape' && desired.length === 0)
			return Err({
				code: 'section-shape',
				message:
					'The last thought cannot be deleted while other Markdown follows it under the Thoughts heading. Edit as text to remove both.',
			});
		return Err({
			code: 'unverified',
			message: `This capture would not read back as written. ${problem.message}`,
		});
	},
};

// ============================================================================
// New captures
// ============================================================================

/**
 * The Markdown body for a new capture: the text exactly as given (a textarea
 * value, or an imported body), then the Thoughts section with any thoughts.
 * The text's bytes are always written whole and in order.
 *
 * What the capture is when created is what it is when opened again:
 *
 * - Ordinary text reads back as that text and those thoughts.
 * - Text with its own "Thoughts" heading makes two headings. `refusal` says
 *   so, and it stays refused on reopening: the original's list is never read
 *   as this app's thoughts.
 * - Text that leaves a code fence or HTML block open absorbs the section.
 *   `absorbed` is true; the section is in the file and appears once the text
 *   above it is closed.
 * - Text that does both (its own Thoughts list, then an open fence) would
 *   absorb the second heading and leave its own list reading as thoughts.
 *   Only then, one empty `## Thoughts` heading is written before the text, so
 *   the file has two visible headings and stays refused.
 */
export function composeBody(
	text: string,
	thoughts: readonly string[] = [],
): {
	readonly body: string;
	readonly refusal: Refusal | undefined;
	readonly absorbed: boolean;
} {
	const expected = thoughts.map(normalizeThought);
	const list =
		expected.length === 0
			? ''
			: `\n${expected.map((thought) => renderThought(thought)).join('\n')}\n`;
	const body = `\n${text}\n\n## Thoughts\n${list}`;
	const read = parseBody(body);
	if (read.refusal !== undefined)
		return { body, refusal: read.refusal, absorbed: false };
	if (
		read.hasSection &&
		read.text === toTextarea(text) &&
		sameThoughts(read.thoughts, expected)
	)
		return { body, refusal: undefined, absorbed: false };
	// The section was absorbed. With no heading left to read, the file has no
	// thoughts and says so. A heading still read is the text's own.
	if (!read.hasSection) return { body, refusal: undefined, absorbed: true };
	const marked = `\n## Thoughts\n${body}`;
	const reread = parseBody(marked);
	return reread.refusal?.code === 'duplicate-heading'
		? { body: marked, refusal: reread.refusal, absorbed: true }
		: { body, refusal: undefined, absorbed: true };
}

/** A short excerpt of capture text for a list. */
export function excerpt(text: string, limit = 240): string {
	const full = toTextarea(text).trim();
	if (full.length <= limit) return full;
	return `${full.slice(0, limit).trimEnd()}…`;
}
