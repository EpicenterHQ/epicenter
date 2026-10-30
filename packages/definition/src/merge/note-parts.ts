/**
 * Where a note's header and its keys are, by position alone: the reader the
 * merge works on. The merge never parses a value to place it, so a key whose
 * value does not parse still merges as a key (see `merge.ts`).
 *
 * RULE: position decides the header and its keys. A note's header is the
 * text between a `---` first line and the next `---` line, whether or not it
 * parses; with no closing fence there is none, and the whole text is body.
 * Its keys are its key blocks (`keyBlocks`).
 *
 * Ported from `claude/repository-v2` `core/markdown.ts` at `c32dd466` (the
 * parts the merge reads); the codec that parses and formats values is
 * `../note`.
 */

const OPEN = '---\n';
const CLOSE = '\n---\n';

/**
 * Where the header is, by position alone: the text starts with a `---`
 * line and a later line is exactly `---`. The door bounds the cost of
 * parsing this span before it is parsed; whether it parses is
 * `parseMarkdown`'s question.
 */
export function splitMarkdown(text: string) {
	if (!text.startsWith(OPEN)) return { yaml: null, yamlStart: 0, bodyStart: 0 };
	const close = `${text}\n`.indexOf(CLOSE, OPEN.length - 1);
	if (close < 0) return { yaml: null, yamlStart: 0, bodyStart: 0 };
	const yamlEnd = close + 1;
	return {
		yaml: text.slice(OPEN.length, Math.max(OPEN.length, yamlEnd)),
		yamlStart: OPEN.length,
		bodyStart: Math.min(text.length, close + CLOSE.length),
	};
}

/** One top-level key of a header: its lines, from any comments just above its key line to the next key's. */
export type KeyBlock = { key: string; text: string };

/**
 * The key a block's first line names, by position alone: what precedes its
 * first unquoted `:` that ends the line or is followed by a space (a quoted
 * key unquoted), or the whole line where there is none. No parse, so it
 * names a key whose value does not parse.
 */
function keyText(line: string): string {
	const text = line.replace(/\r?\n$/, '');
	let quote: string | null = null;
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (quote !== null) {
			if (char === '\\' && quote === '"') at++;
			else if (char === quote) quote = null;
		} else if (
			(char === '"' || char === "'") &&
			text.slice(0, at).trim() === ''
		)
			quote = char;
		else if (char === ':' && /^(\s|$)/.test(text.slice(at + 1)))
			return unquoted(text.slice(0, at).trimEnd());
	}
	return text.trimEnd();
}

const unquoted = (key: string) => {
	if (key.length > 1 && key.startsWith("'") && key.endsWith("'"))
		return key.slice(1, -1).replaceAll("''", "'");
	if (key.length > 1 && key.startsWith('"') && key.endsWith('"'))
		try {
			return JSON.parse(key) as string;
		} catch {
			return key;
		}
	return key;
};

/**
 * RULE: a header is a list of key blocks, split by position, never by
 * `yaml`'s error recovery (which reads a broken line as part of its
 * neighbour). Each line at column 0 that is not blank, not a comment and
 * not a `- ` item (which continues the value above it) starts a block, which
 * runs to the next such line; comment lines at column 0 belong to the block
 * after them. Lines before the first block are the preamble. A header that
 * does not parse splits the same way.
 */
export function keyBlocks(yaml: string): {
	preamble: string;
	blocks: KeyBlock[];
} {
	const lines = yaml.split(/(?<=\n)/).filter((line) => line !== '');
	let preamble = '';
	const blocks: KeyBlock[] = [];
	let comments = '';
	for (const line of lines) {
		const last = blocks.at(-1);
		if (line.startsWith('#')) comments += line;
		else if (/^(\s|-(\s|$))/.test(line) || line.trim() === '') {
			if (last === undefined) preamble += comments + line;
			else last.text += comments + line;
			comments = '';
		} else {
			blocks.push({ key: keyText(line), text: comments + line });
			comments = '';
		}
	}
	const last = blocks.at(-1);
	if (last === undefined) preamble += comments;
	else last.text += comments;
	return { preamble, blocks };
}

/**
 * A note as its header's preamble and key blocks (null when it has no
 * header) and its body.
 */
export function readNote(text: string) {
	const { yaml, bodyStart } = splitMarkdown(text);
	return {
		header: yaml === null ? null : keyBlocks(yaml),
		body: text.slice(bodyStart),
	};
}

/** RULE: a body after no header must not itself read as one: one that opens with fences gets an empty header. */
export const emptyHeaderFor = (body: string) =>
	splitMarkdown(body).yaml === null ? '' : `${OPEN}---\n`;
