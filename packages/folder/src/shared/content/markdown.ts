/**
 * Markdown row framing: where a row file's frontmatter and body are
 * (ADR-0518, ADR-0519).
 *
 * Row text is the whole file: an opening `---` line, a YAML mapping with
 * string keys, a closing `---` line, and a body. Framing only locates those
 * parts; `parseRowSource` reads them, and Git merge splits text with the same
 * frame.
 */
const BOM = '﻿';

/** The located parts of a row file's whole text. Offsets index into that string. */
export type RowTextFrame =
	| {
			readonly kind: 'frontmatter';
			readonly bom: string;
			/** Offset of the first byte of YAML, after the opening fence line. */
			readonly yamlStart: number;
			/** Offset of the closing fence line. */
			readonly yamlEnd: number;
			readonly bodyStart: number;
			readonly newline: '\n' | '\r\n';
	  }
	/** The text does not start with an exact `---` line. */
	| { readonly kind: 'missing'; readonly bom: string }
	/** The opening line has no exact `---` line after it. */
	| { readonly kind: 'unclosed'; readonly bom: string };

/**
 * Locate frontmatter. Only an exact `---` first line opens it, after an
 * optional byte-order mark; the next exact `---` line closes it.
 */
export function frameRowText(source: string): RowTextFrame {
	const bom = source.startsWith(BOM) ? BOM : '';
	const start = bom.length;
	const openingNewline = source.startsWith('---\r\n', start)
		? '\r\n'
		: source.startsWith('---\n', start)
			? '\n'
			: undefined;
	if (openingNewline === undefined)
		return source.slice(start) === '---'
			? { kind: 'unclosed', bom }
			: { kind: 'missing', bom };
	const yamlStart = start + 3 + openingNewline.length;
	let lineStart = yamlStart;
	while (lineStart <= source.length) {
		const lineFeed = source.indexOf('\n', lineStart);
		const lineEnd = lineFeed < 0 ? source.length : lineFeed;
		const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
		if (line === '---') {
			return {
				kind: 'frontmatter',
				bom,
				yamlStart,
				yamlEnd: lineStart,
				bodyStart: lineFeed < 0 ? source.length : lineFeed + 1,
				newline: openingNewline,
			};
		}
		if (lineFeed < 0) break;
		lineStart = lineFeed + 1;
	}
	return { kind: 'unclosed', bom };
}

/** A body added to an EOF closing fence still needs its separating newline. */
export function joinRowText(head: string, body: string): string {
	const frame = frameRowText(head);
	if (frame.kind !== 'frontmatter')
		throw new Error('Row header has no closing fence');
	return (
		head + (body !== '' && !head.endsWith('\n') ? frame.newline : '') + body
	);
}
