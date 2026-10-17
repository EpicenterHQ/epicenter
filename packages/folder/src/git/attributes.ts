/**
 * Which incoming paths a commit's own `.gitattributes` would filter or convert.
 *
 * A fast-forward writes each blob's bytes as they are stored. A commit that
 * declares a filter or a conversion for a path means something else by those
 * bytes: under `filter=lfs` the blob is a pointer, not the audio. Such a
 * commit is refused before anything is written. This is refusal of a
 * repository the folder cannot represent, not support for filters.
 *
 * The folder on disk asks Git itself (`git check-attr --source`). A browser
 * folder has no Git program, so this module evaluates the attribute files of
 * the pinned tree the way Git's `attr.c` and `wildmatch.c` do: line order,
 * nested files, macros, and pattern matching follow Git, and matching works
 * on bytes as Git's does. Patterns are matched as a case-insensitive checkout
 * matches them (`core.ignorecase`), which is the wider of Git's two answers.
 * `attributes.test.ts` compares the two.
 *
 * Only attribute files inside the tree are read. Nothing looks at file
 * contents, and nothing consults attributes of the files currently in the
 * folder.
 */

/** Attributes that make Git store different bytes than the working file. */
export const NORMALIZING = [
	'text',
	'eol',
	'crlf',
	'filter',
	'ident',
	'working-tree-encoding',
] as const;

export type DeclaredAttribute = {
	readonly path: string;
	/** `name` when set, `name=value` when it carries a value. */
	readonly attribute: string;
};

/** A state as `git check-attr` prints it: `set`, `unset`, `unspecified`, or a value. */
type State = string;
const SET = 'set';
const UNSET = 'unset';
const UNSPECIFIED = 'unspecified';

type Assignment = { readonly name: string; readonly state: State };

type Line = {
	/** The macro this line defines, or undefined for a path pattern. */
	readonly macro: string | undefined;
	/** Pattern bytes as a binary string, without a trailing slash. */
	readonly pattern: string;
	/** No slash in the pattern: it is matched against the filename alone. */
	readonly basenameOnly: boolean;
	/** A trailing slash: the pattern matches directories only, so never a file. */
	readonly directoryOnly: boolean;
	readonly assignments: readonly Assignment[];
};

const BLANK = ' \t\r\n';
const MACRO_PREFIX = '[attr]';
/** Git ignores an attribute line this long or longer. */
const MAX_LINE_LENGTH = 2048;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One character per byte, so every string operation below is a byte operation. */
function binary(bytes: Uint8Array): string {
	let value = '';
	for (let offset = 0; offset < bytes.length; offset += 16384)
		value += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
	return value;
}
const fromBinary = (value: string) =>
	decoder.decode(Uint8Array.from(value, (char) => char.charCodeAt(0)));

function span(text: string, from: number, accept: (char: string) => boolean) {
	let index = from;
	while (index < text.length && accept(text[index]!)) index++;
	return index;
}
const isBlank = (char: string) => BLANK.includes(char);

/** Git's `unquote_c_style`: the unquoted text and where the quote ended. */
function unquote(
	text: string,
	from: number,
): { value: string; end: number } | undefined {
	if (text[from] !== '"') return undefined;
	let index = from + 1;
	let value = '';
	for (;;) {
		const start = index;
		while (index < text.length && text[index] !== '"' && text[index] !== '\\')
			index++;
		value += text.slice(start, index);
		if (index >= text.length) return undefined;
		if (text[index++] === '"') return { value, end: index };
		const escaped = text[index++];
		const simple: Record<string, string> = {
			a: '\x07',
			b: '\b',
			f: '\f',
			n: '\n',
			r: '\r',
			t: '\t',
			v: '\v',
			'\\': '\\',
			'"': '"',
		};
		if (escaped !== undefined && Object.hasOwn(simple, escaped)) {
			value += simple[escaped];
			continue;
		}
		if (escaped === undefined || escaped < '0' || escaped > '3')
			return undefined;
		const second = text[index++];
		const third = text[index++];
		if (
			second === undefined ||
			third === undefined ||
			second < '0' ||
			second > '7' ||
			third < '0' ||
			third > '7'
		)
			return undefined;
		value += String.fromCharCode(
			((escaped.charCodeAt(0) - 48) << 6) |
				((second.charCodeAt(0) - 48) << 3) |
				(third.charCodeAt(0) - 48),
		);
	}
}

const validName = (name: string) =>
	/^[A-Za-z0-9_.][-A-Za-z0-9_.]*$/.test(name) && !name.startsWith('builtin_');

/** One line of an attribute file, or undefined when Git would ignore it. */
function parseLine(line: string, macrosAllowed: boolean): Line | undefined {
	const start = span(line, 0, isBlank);
	if (start >= line.length || line[start] === '#') return undefined;
	if (line.length >= MAX_LINE_LENGTH) return undefined;
	let name: string;
	let rest: number;
	const quoted = unquote(line, start);
	if (quoted !== undefined) {
		name = quoted.value;
		rest = quoted.end;
	} else {
		rest = span(line, start, (char) => !isBlank(char));
		name = line.slice(start, rest);
	}
	let macro: string | undefined;
	if (name.length > MACRO_PREFIX.length && name.startsWith(MACRO_PREFIX)) {
		if (!macrosAllowed) return undefined;
		const from = span(name, MACRO_PREFIX.length, isBlank);
		macro = name.slice(
			from,
			span(name, from, (char) => !isBlank(char)),
		);
		if (!validName(macro)) return undefined;
	}
	const assignments: Assignment[] = [];
	let index = span(line, rest, isBlank);
	while (index < line.length) {
		const end = span(line, index, (char) => !isBlank(char));
		const token = line.slice(index, end);
		const equals = token.indexOf('=');
		let attribute = equals < 0 ? token : token.slice(0, equals);
		let state: State;
		if (attribute.startsWith('-') || attribute.startsWith('!')) {
			state = attribute.startsWith('-') ? UNSET : UNSPECIFIED;
			attribute = attribute.slice(1);
		} else state = equals < 0 ? SET : token.slice(equals + 1);
		// One invalid attribute name makes Git drop the whole line.
		if (!validName(attribute)) return undefined;
		assignments.push({ name: attribute, state });
		index = span(line, end, isBlank);
	}
	if (macro !== undefined)
		return {
			macro,
			pattern: '',
			basenameOnly: false,
			directoryOnly: false,
			assignments,
		};
	// Negative patterns are refused by Git in attribute files.
	if (name.startsWith('!')) return undefined;
	const directoryOnly = name.endsWith('/');
	const pattern = directoryOnly ? name.slice(0, -1) : name;
	return {
		macro: undefined,
		pattern,
		basenameOnly: !pattern.includes('/'),
		directoryOnly,
		assignments,
	};
}

function parseFile(bytes: Uint8Array, macrosAllowed: boolean): Line[] {
	let text = binary(bytes);
	// Git reads the file as a C string.
	const nul = text.indexOf('\0');
	if (nul >= 0) text = text.slice(0, nul);
	const lines: Line[] = [];
	const rows = text.split('\n');
	rows.forEach((row, number) => {
		const parsed = parseLine(row, macrosAllowed);
		if (parsed !== undefined) lines.push(parsed);
		// Whether Git skips a byte-order mark depends on how it read the file.
		// Read the first line both ways, so a declaration behind one is never
		// missed; the cost is refusing where Git might not.
		if (number === 0 && row.startsWith('\xef\xbb\xbf')) {
			const bare = parseLine(row.slice(3), macrosAllowed);
			if (bare !== undefined) lines.push(bare);
		}
	});
	return lines;
}

const MATCH = 0;
const NOMATCH = 1;
const ABORT_ALL = -1;
const ABORT_TO_STARSTAR = -2;

const CLASSES: Record<string, (char: string) => boolean> = {
	alnum: (c) => /[A-Za-z0-9]/.test(c),
	alpha: (c) => /[A-Za-z]/.test(c),
	blank: (c) => c === ' ' || c === '\t',
	cntrl: (c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f,
	digit: (c) => /[0-9]/.test(c),
	graph: (c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) < 0x7f,
	lower: (c) => /[a-z]/.test(c),
	print: (c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7f,
	punct: (c) =>
		c.charCodeAt(0) > 0x20 && c.charCodeAt(0) < 0x7f && !/[A-Za-z0-9]/.test(c),
	space: (c) => /[ \t\n\v\f\r]/.test(c),
	upper: (c) => /[A-Z]/.test(c),
	xdigit: (c) => /[0-9A-Fa-f]/.test(c),
};

const isGlobSpecial = (char: string | undefined) =>
	char === '*' || char === '?' || char === '[' || char === '\\';

const isUpper = (char: string | undefined) =>
	char !== undefined && char >= 'A' && char <= 'Z';
const isLower = (char: string | undefined) =>
	char !== undefined && char >= 'a' && char <= 'z';

/**
 * Git's `dowild` from `wildmatch.c`. `pathname` is `WM_PATHNAME`: `*` and `?`
 * do not cross a slash, and `**` spans directories only as a whole path
 * component. `fold` is `WM_CASEFOLD`, with Git's own quirks: ASCII only, and
 * a literal inside a bracket set is not folded.
 */
function dowild(
	pattern: string,
	p: number,
	text: string,
	t: number,
	pathname: boolean,
	fold: boolean,
): number {
	const start = p;
	const lower = (char: string | undefined) =>
		fold && isUpper(char) ? (char as string).toLowerCase() : char;
	for (; p < pattern.length; t++, p++) {
		let pch: string = lower(pattern[p]) as string;
		let tch = lower(text[t]);
		if (tch === undefined && pch !== '*') return ABORT_ALL;
		if (pch === '\\') {
			// A literal match with the following character.
			pch = pattern[++p] ?? '';
			if (tch !== pch) return NOMATCH;
			continue;
		}
		switch (pch) {
			case '?':
				if (pathname && tch === '/') return NOMATCH;
				continue;
			case '*': {
				let matchSlash: boolean;
				if (pattern[++p] === '*') {
					const before = p - 2;
					while (pattern[++p] === '*');
					if (!pathname) matchSlash = true;
					else if (
						(before < start || pattern[before] === '/') &&
						(p >= pattern.length ||
							pattern[p] === '/' ||
							(pattern[p] === '\\' && pattern[p + 1] === '/'))
					) {
						// `**/` may match no directory at all.
						if (
							pattern[p] === '/' &&
							dowild(pattern, p + 1, text, t, pathname, fold) === MATCH
						)
							return MATCH;
						matchSlash = true;
					} else matchSlash = false;
				} else matchSlash = !pathname;
				if (p >= pattern.length) {
					if (!matchSlash && text.indexOf('/', t) >= 0)
						return ABORT_TO_STARSTAR;
					return MATCH;
				}
				if (!matchSlash && pattern[p] === '/') {
					const slash = text.indexOf('/', t);
					if (slash < 0) return ABORT_ALL;
					t = slash;
					// The loop's own step consumes the slash in both.
					break;
				}
				for (;;) {
					if (tch === undefined) break;
					if (!isGlobSpecial(pattern[p])) {
						const literal = lower(pattern[p]);
						for (;;) {
							tch = lower(text[t]);
							if (tch === undefined || (!matchSlash && tch === '/')) break;
							if (tch === literal) break;
							t++;
						}
						if (tch !== literal)
							return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR;
					}
					const matched = dowild(pattern, p, text, t, pathname, fold);
					if (matched !== NOMATCH) {
						if (!matchSlash || matched !== ABORT_TO_STARSTAR) return matched;
					} else if (!matchSlash && tch === '/') return ABORT_TO_STARSTAR;
					tch = lower(text[++t]);
				}
				return ABORT_ALL;
			}
			case '[': {
				let cch = pattern[++p];
				const negated = cch === '!' || cch === '^';
				if (negated) cch = pattern[++p];
				let previous = '';
				let matched = false;
				do {
					if (cch === undefined) return ABORT_ALL;
					if (cch === '\\') {
						cch = pattern[++p];
						if (cch === undefined) return ABORT_ALL;
						if (tch === cch) matched = true;
					} else if (
						cch === '-' &&
						previous !== '' &&
						pattern[p + 1] !== undefined &&
						pattern[p + 1] !== ']'
					) {
						cch = pattern[++p]!;
						if (cch === '\\') {
							cch = pattern[++p];
							if (cch === undefined) return ABORT_ALL;
						}
						if (tch! <= cch && tch! >= previous) matched = true;
						else if (fold && isLower(tch)) {
							const upper = tch!.toUpperCase();
							if (upper <= cch && upper >= previous) matched = true;
						}
						// A range's end never starts another range.
						cch = '';
					} else if (cch === '[' && pattern[p + 1] === ':') {
						const from = p + 2;
						let end = from;
						while (end < pattern.length && pattern[end] !== ']') end++;
						if (end >= pattern.length) return ABORT_ALL;
						if (end - from - 1 < 0 || pattern[end - 1] !== ':') {
							// No `:]`: an ordinary `[` in the set.
							if (tch === '[') matched = true;
							cch = '[';
						} else {
							const test = CLASSES[pattern.slice(from, end - 1)];
							if (test === undefined) return ABORT_ALL;
							if (test(tch!)) matched = true;
							else if (fold && test === CLASSES.upper && isLower(tch))
								matched = true;
							p = end;
							cch = '';
						}
					} else if (tch === cch) matched = true;
					previous = cch;
					cch = pattern[++p];
				} while (cch !== ']');
				if (matched === negated || (pathname && tch === '/')) return NOMATCH;
				continue;
			}
			default:
				if (tch !== pch) return NOMATCH;
				continue;
		}
	}
	return t < text.length ? NOMATCH : MATCH;
}

/**
 * Whether Git's pattern matches. The pattern is matched as written; when it
 * holds something this port cannot evaluate, the answer is `true`, so an
 * unreadable declaration is refused, never skipped.
 */
function wildmatch(pattern: string, text: string, pathname: boolean): boolean {
	try {
		// A checkout on a case-insensitive filesystem matches attribute
		// patterns without regard to ASCII case. The stored bytes must be plain
		// wherever the repository is checked out, so matching folds here too.
		return dowild(pattern, 0, text, 0, pathname, true) === MATCH;
	} catch {
		return true;
	}
}

/**
 * Whether a line in the attribute file of `directory` (`''` for the root, or
 * `a/b`) selects the file at `path`. Both are binary strings.
 */
function selects(line: Line, directory: string, path: string): boolean {
	// A file is never a directory, and attributes do not pass from one down.
	if (line.directoryOnly) return false;
	if (line.basenameOnly)
		return wildmatch(
			line.pattern,
			path.slice(path.lastIndexOf('/') + 1),
			false,
		);
	const name = directory === '' ? path : path.slice(directory.length + 1);
	const pattern = line.pattern.startsWith('/')
		? line.pattern.slice(1)
		: line.pattern;
	return wildmatch(pattern, name, true);
}

/** Git's built-in macro, which a root attribute file may redefine. */
const BUILTIN_BINARY: readonly Assignment[] = [
	{ name: 'diff', state: UNSET },
	{ name: 'merge', state: UNSET },
	{ name: 'text', state: UNSET },
];

/** Byte order of the UTF-8 spellings, which is how Git orders paths. */
export const byCodePoint = (left: string, right: string) => {
	const a = [...left];
	const b = [...right];
	for (let index = 0; index < a.length && index < b.length; index++) {
		const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
};

/**
 * The first path, in byte order, that the tree's own attribute files give a
 * filtering or converting attribute, with that attribute as `git check-attr`
 * names it. `undefined` when every path is stored and checked out as plain
 * bytes.
 *
 * `attributeFiles` holds the bytes of every `.gitattributes` in the tree, by
 * its path.
 */
export function normalizingAttribute(
	attributeFiles: ReadonlyMap<string, Uint8Array>,
	paths: Iterable<string>,
): DeclaredAttribute | undefined {
	if (attributeFiles.size === 0) return undefined;
	/** Parsed lines by the binary directory of their file. */
	const byDirectory = new Map<string, Line[]>();
	for (const [path, bytes] of attributeFiles) {
		const directory = path.includes('/')
			? path.slice(0, path.lastIndexOf('/'))
			: '';
		byDirectory.set(
			binary(encoder.encode(directory)),
			parseFile(bytes, directory === ''),
		);
	}
	// Among a root file's definitions of one macro, the last wins.
	const macros = new Map<string, readonly Assignment[]>([
		['binary', BUILTIN_BINARY],
	]);
	for (const line of byDirectory.get('') ?? [])
		if (line.macro !== undefined) macros.set(line.macro, line.assignments);

	for (const path of [...paths].sort(byCodePoint)) {
		const target = binary(encoder.encode(path));
		const states = new Map<string, State>();
		/** Git's `fill_one`: later in a line wins, and nothing overrides a state already found. */
		const fill = (assignments: readonly Assignment[]) => {
			for (let index = assignments.length - 1; index >= 0; index--) {
				const { name, state } = assignments[index]!;
				if (states.has(name)) continue;
				states.set(name, state);
				const macro = macros.get(name);
				if (macro !== undefined && state === SET) fill(macro);
			}
		};
		// The file nearest the path decides first, and within a file the last
		// matching line does.
		const parts = target.split('/');
		for (let depth = parts.length - 1; depth >= 0; depth--) {
			const directory = parts.slice(0, depth).join('/');
			const lines = byDirectory.get(directory);
			if (lines === undefined) continue;
			for (let index = lines.length - 1; index >= 0; index--) {
				const line = lines[index]!;
				if (line.macro === undefined && selects(line, directory, target))
					fill(line.assignments);
			}
		}
		for (const name of NORMALIZING) {
			const state = states.get(name) ?? UNSPECIFIED;
			if (state === UNSPECIFIED || state === UNSET) continue;
			return {
				path,
				attribute: state === SET ? name : `${name}=${fromBinary(state)}`,
			};
		}
	}
	return undefined;
}

/** Whether a tree path is an attribute file. */
export const isAttributesPath = (path: string) =>
	path === '.gitattributes' || path.endsWith('/.gitattributes');
