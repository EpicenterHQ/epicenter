/**
 * The three-way merge of a folder file, by its content and its extension
 * (ADR-0551, ADR-0576, ADR-0591). No definition takes part: a file merges
 * the same wherever it is in the folder and whatever reads it.
 *
 * `merge` is the one merge every write and Sync make: `ours` is the writer
 * acting, and it wins every unit both sides changed differently.
 *
 * | File | Unit |
 * | --- | --- |
 * | `.md` whose present versions all have frontmatter `parseRowSource` reads | one frontmatter field; one region of body lines |
 * | `.json` whose present versions all parse as JSON objects, a byte-order mark aside | one key; a key whose value is an object on both sides is its own keys |
 * | other `.json` JSON, such as an array | the whole file |
 * | other UTF-8 text, `.json` that does not parse or holds a number a rewrite would change included | one region of lines |
 * | binary, or a side absent | the whole file |
 *
 * Units only one side changed all survive. Two insertions at one place in a
 * body or a text both survive, and identical ones are one (`mergeLines`).
 * A delete beats an edit the deleting side never saw: only a side with no
 * base brings a file into existence. A Markdown version whose frontmatter
 * does not read merges as text: the result is a file a person can repair,
 * never a refusal (ADR-0503).
 *
 * Fields and keys compare by value as JSON, never by spelling, so key order,
 * quoting, and frontmatter comments never compete with a value, and an array
 * is one unit. A merged file keeps a side's bytes wherever its values are
 * that side's: frontmatter whose merged fields equal ours' or theirs' is
 * that side's frontmatter, comments included, joined by line with the other
 * side's presentation edits where they do not compete, and its body takes
 * that frontmatter's line endings. A JSON file whose merged value equals a
 * side's is that side's file. Only a result that differs from both is
 * written canonically, keys in ours' order and then keys only theirs added:
 * frontmatter by `formatRowSource`, JSON by `JSON.stringify` with a
 * two-space indent, which puts integer-like keys first as JavaScript orders
 * them. JSON holding a number that rewrite would change, such as an integer
 * past 2^53, merges by line instead, so no number is rewritten.
 *
 * Nothing is checked against a schema. Every merged value is ours' or
 * theirs', and a field is checked alone, with no rule across fields, so a
 * field merge of two valid rows is a valid row.
 *
 * This module writes nothing and loads no Git implementation.
 */
import {
	type CanonicalDocument,
	formatRowSource,
	parseRowSource,
} from './canonical.js';
import { mergeLines, type SettledRegion } from './git/merge-lines.js';
import { frameRowText } from './markdown.js';
import { type AnyRow, mergeRows, sameValue, setField } from './row-merge.js';
import { lineFeeds } from './row-text.js';

const MARKDOWN_EXTENSION = '.md';
const JSON_EXTENSION = '.json';

/** A file's content as a merge reads it: text, or bytes that may be text. */
export type FileContent = string | Uint8Array;

/** A file at the merge base and on each side, `null` for no file. */
export type FileVersions = {
	readonly base: FileContent | null;
	readonly ours: FileContent | null;
	readonly theirs: FileContent | null;
};

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A version as text, `null` for no file, `undefined` for content that is not text. */
function textOf(content: FileContent | null): string | null | undefined {
	if (content === null) return null;
	if (typeof content === 'string') return content;
	if (content.includes(0)) return undefined;
	try {
		return strict.decode(content);
	} catch {
		return undefined;
	}
}

/**
 * A unit of a file where `ours`, the writer acting, replaced the other
 * side's change, or a whole file one side lost to a delete. A merge where
 * `theirs` wins names no unit `theirs` kept: the file as it is stood there,
 * and nothing of it was replaced.
 *
 * - `field`: one frontmatter field, or one key of a JSON file, named by its
 *   path from the top: keys joined with `/`, each `~` and `/` in a key
 *   written `~0` and `~1` as in a JSON Pointer, so `title` is a top-level
 *   field and `tables/todos` the key `todos` inside `tables`.
 * - `lines`: one region of a Markdown body or frontmatter, or of a text
 *   file. The writer's `count` lines stand there from `line`, 1-based within
 *   the body (`part: 'body'`) or the whole file (`part: 'text'`); a `count`
 *   of 0 is a removal at that place.
 * - `file`: the whole file, because a side has none, a version is not
 *   UTF-8 text, or a version of a `.json` file is not a JSON object. `lost`
 *   names the side whose edit of it did not stand: `theirs` under the writer
 *   acting, or either side's under a delete, since a delete beats an edit it
 *   never saw.
 *
 * It names the unit, never the content that lost: the other version is
 * still in whatever held it, such as a commit.
 */
export type Overridden =
	| { readonly kind: 'field'; readonly field: string }
	| {
			readonly kind: 'lines';
			readonly part: 'body' | 'text';
			readonly line: number;
			readonly count: number;
	  }
	| { readonly kind: 'file'; readonly lost: 'ours' | 'theirs' };

/** A merge's result: the file, `null` for no file, and what the writer acting overrode. */
export type Merged = {
	readonly content: FileContent | null;
	/** Each unit `Overridden` names, in file order. Empty when nothing competed. */
	readonly overridden: readonly Overridden[];
};

const encoder = new TextEncoder();

/** Whether two versions hold the same bytes; `null` is no file. */
export function sameContent(
	left: FileContent | null,
	right: FileContent | null,
) {
	if (left === null || right === null) return left === right;
	if (typeof left === 'string' && typeof right === 'string')
		return left === right;
	const [a, b] = [left, right].map((side) =>
		typeof side === 'string' ? encoder.encode(side) : side,
	) as [Uint8Array, Uint8Array];
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * A side that changed nothing yields, leaving the other's bytes exactly as
 * they are, in whatever spelling; `undefined` when both changed the file.
 */
function oneSided({ base, ours, theirs }: FileVersions): Merged | undefined {
	if (sameContent(ours, theirs) || sameContent(theirs, base))
		return { content: ours, overridden: [] };
	if (sameContent(ours, base)) return { content: theirs, overridden: [] };
	return undefined;
}

/**
 * The whole file as one unit: a side that changed nothing yields. Where
 * both changed it, a delete beats the edit it never saw, and otherwise
 * `winner`'s file stands. Whether a file exists is decided by a delete;
 * what it holds, by the winner.
 */
export function wholeFile(
	versions: FileVersions,
	winner: Winner = 'ours',
): Merged {
	const settled = oneSided(versions);
	if (settled !== undefined) return settled;
	const { ours, theirs } = versions;
	if (ours === null)
		return { content: null, overridden: [{ kind: 'file', lost: 'theirs' }] };
	if (theirs === null)
		return { content: null, overridden: [{ kind: 'file', lost: 'ours' }] };
	return winner === 'ours'
		? { content: ours, overridden: [{ kind: 'file', lost: 'theirs' }] }
		: { content: theirs, overridden: [] };
}

/**
 * The side whose change stands on a unit both changed differently: the
 * writer acting, `ours`, everywhere but Sync's publish of a merged tree
 * over the files, where the file as it is now, `theirs`, stands.
 */
export type Winner = 'ours' | 'theirs';

/** A competing region the writer's lines won, as `overridden` names it. */
const linesOf = (part: 'body' | 'text', region: SettledRegion): Overridden => ({
	kind: 'lines',
	part,
	line: region.line + 1,
	count: region.kept.split('\n').length - 1,
});

/**
 * Three texts by line, `winner` winning each competing region. With `union:
 * false`, two different insertions at one place compete too.
 */
async function textWins(
	base: string | null,
	ours: string,
	theirs: string,
	winner: Winner,
	{ union = true }: { readonly union?: boolean } = {},
): Promise<Merged> {
	const merged = await mergeLines(
		{ base: base ?? '', ours, theirs },
		{ union },
	);
	return {
		content: merged[winner],
		overridden: merged.regions.map((region) => linesOf('text', region)),
	};
}

/**
 * A Markdown version whose frontmatter does not read, merged as text: its
 * frontmatter and its body apart when every version has closed
 * frontmatter, so insertions at one place join in the body and compete in
 * the frontmatter, where two lines added side by side could write one key
 * twice. A version without closed frontmatter merges the whole text with no
 * insertions joined.
 */
async function rowTextWins(
	base: string | null,
	ours: string,
	theirs: string,
	winner: Winner,
): Promise<Merged> {
	const split = (text: string) => {
		const frame = frameRowText(text);
		return frame.kind === 'frontmatter'
			? {
					head: text.slice(0, frame.bodyStart),
					body: text.slice(frame.bodyStart),
				}
			: undefined;
	};
	const [b, o, t] = [
		base === null ? { head: '', body: '' } : split(base),
		split(ours),
		split(theirs),
	];
	if (b === undefined || o === undefined || t === undefined) {
		const merged = await mergeLines(
			{ base: base ?? '', ours, theirs },
			{ union: false },
		);
		return {
			content: merged[winner],
			overridden: merged.regions.map((region) => linesOf('text', region)),
		};
	}
	const head = await mergeLines(
		{ base: b.head, ours: o.head, theirs: t.head },
		{ union: false },
	);
	const body = await mergeLines({ base: b.body, ours: o.body, theirs: t.body });
	const headLines = head[winner].split('\n').length - 1;
	return {
		content: head[winner] + body[winner],
		overridden: [
			...head.regions.map((region) => linesOf('text', region)),
			...body.regions.map((region) =>
				linesOf('text', { ...region, line: region.line + headLines }),
			),
		],
	};
}

/** A key path as `Overridden` names it: JSON Pointer segments, joined, with no leading `/`. */
const pointer = (path: readonly string[]) =>
	path.map((key) => key.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

/**
 * A Markdown version: its frontmatter as written, its fields, its body with
 * `\n` line endings as a row's body is read (ADR-0572), and the whole text.
 */
type Framed = AnyRow & { readonly head: string; readonly text: string };

/** `text` with its frontmatter read, or `undefined` when it does not read. */
function framed(text: string): Framed | undefined {
	const { data, error } = parseRowSource(text);
	if (error !== null) return undefined;
	const { fields, body } = data.document;
	return {
		head: text.slice(0, text.length - body.length),
		fields: fields as AnyRow['fields'],
		body: lineFeeds(body),
		text,
	};
}

/** The lines of `text` a frontmatter head spans, its closing fence included. */
const lineCount = (text: string) => text.split('\n').length - 1;

/**
 * The frontmatter a Markdown merge keeps when its fields are `kept`'s. The
 * other side's edit of the frontmatter since the base, such as a comment or
 * a quote, joins `kept`'s by line when the two do not compete and the
 * joined frontmatter still reads as `fields`. Otherwise `kept`'s
 * frontmatter stands. When that drops a presentation-only edit of `theirs`,
 * one whose fields are the base's, the lines that competed are named, or the
 * whole frontmatter when none did; an edit that also changed values is
 * named by its fields already, and `ours` losing names nothing, since
 * `overridden` names only what `ours` replaced.
 */
async function keptHead(
	base: Framed | null,
	ours: Framed,
	theirs: Framed,
	kept: Framed,
	fields: AnyRow['fields'],
): Promise<{ head: string; overridden: Overridden[] }> {
	const other = kept === ours ? theirs : ours;
	const stands = { head: kept.head, overridden: [] };
	if (base === null || other.head === base.head || other.head === kept.head)
		return stands;
	const merged = await mergeLines(
		{ base: base.head, ours: ours.head, theirs: theirs.head },
		{ union: false },
	);
	if (merged.regions.length === 0) {
		const read = framed(merged.ours);
		if (read !== undefined && sameValue(read.fields, fields))
			return { head: merged.ours, overridden: [] };
	}
	if (other === ours || !sameValue(theirs.fields, base.fields)) return stands;
	return {
		head: kept.head,
		overridden:
			merged.regions.length === 0
				? [
						{
							kind: 'lines',
							part: 'text',
							line: 1,
							count: lineCount(kept.head),
						},
					]
				: merged.regions.map((region) => linesOf('text', region)),
	};
}

/**
 * Markdown with frontmatter by field and body, `winner` winning each
 * competing unit. The frontmatter is a side's own when the merged fields
 * are that side's, with the other side's presentation edits joined where
 * they do not compete (`keptHead`), and the whole file is a side's when its
 * body is too; otherwise the frontmatter is canonical. The body takes the
 * frontmatter's line endings. `undefined` when a present version's
 * frontmatter does not read or the merged fields have no canonical form.
 */
async function markdownWins(
	base: string | null,
	ours: string,
	theirs: string,
	winner: Winner,
): Promise<Merged | undefined> {
	const [b, o, t] = [
		base === null ? null : framed(base),
		framed(ours),
		framed(theirs),
	];
	if (b === undefined || o === undefined || t === undefined) return undefined;
	const merged = await mergeRows(b, o, t);
	const fields = { ...merged.fields };
	for (const unit of merged.conflicts)
		setField(fields, unit.field, unit[winner]);
	const body = merged.body[winner];
	const units = [
		...merged.conflicts.map(
			(unit): Overridden => ({ kind: 'field', field: pointer([unit.field]) }),
		),
		...merged.body.regions.map((region) => linesOf('body', region)),
	];
	const kept = [o, t].find((side) => sameValue(fields, side.fields));
	if (kept !== undefined) {
		const head = await keptHead(b, o, t, kept, fields);
		const overridden = [...head.overridden, ...units];
		if (head.head === kept.head && body === kept.body)
			return { content: kept.text, overridden };
		const crlf = head.head.includes('\r\n');
		return {
			content: head.head + (crlf ? body.replaceAll('\n', '\r\n') : body),
			overridden,
		};
	}
	const { data, error } = formatRowSource(
		{ fields, body } as CanonicalDocument,
		[...new Set([...Object.keys(o.fields), ...Object.keys(t.fields)])],
	);
	return error === null ? { content: data.text, overridden: units } : undefined;
}

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const BOM = '\uFEFF';
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * Whether every number in valid JSON `text` is written as JavaScript writes
 * the value `JSON.parse` reads, so a rewrite changes none: not an integer
 * past 2^53, `1.0`, or `1e3`.
 */
function exactNumbers(text: string): boolean {
	for (const [token] of text.replace(JSON_STRING, '""').matchAll(JSON_NUMBER))
		if (String(Number(token)) !== token) return false;
	return true;
}

/**
 * A JSON version as a merge reads it, a leading byte-order mark aside: an
 * object to merge by key, `other` JSON to merge whole, or `text` to merge by
 * line, for a version that does not parse or holds a number a rewrite would
 * change.
 */
type JsonRead =
	| { readonly kind: 'object'; readonly value: JsonObject }
	| { readonly kind: 'other' }
	| { readonly kind: 'text' };

function readJson(text: string): JsonRead {
	const bare = text.startsWith(BOM) ? text.slice(1) : text;
	let value: unknown;
	try {
		value = JSON.parse(bare);
	} catch {
		return { kind: 'text' };
	}
	if (!exactNumbers(bare)) return { kind: 'text' };
	return isJsonObject(value) ? { kind: 'object', value } : { kind: 'other' };
}

const keyOf = (object: JsonObject | undefined, key: string) =>
	object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * Three JSON objects merged key by key, `winner` winning each key both
 * sides changed differently, which is added to `overridden`. A key whose
 * value both sides changed and both hold as an object merges its own keys
 * the same way, over the base's object or none. Keys are in ours' order,
 * then keys only theirs added. `base` absent is two additions, so only what
 * both added alike agrees.
 */
function mergeObjects(
	base: JsonObject | undefined,
	ours: JsonObject,
	theirs: JsonObject,
	winner: Winner,
	path: readonly string[],
	overridden: Overridden[],
): JsonObject {
	const merged: JsonObject = {};
	const keys = new Set([
		...Object.keys(ours),
		...Object.keys(theirs),
		...Object.keys(base ?? {}),
	]);
	for (const key of keys) {
		const [b, o, t] = [keyOf(base, key), keyOf(ours, key), keyOf(theirs, key)];
		let value: unknown;
		if (sameValue(o, t) || sameValue(t, b)) value = o;
		else if (sameValue(o, b)) value = t;
		else if (isJsonObject(o) && isJsonObject(t))
			value = mergeObjects(
				isJsonObject(b) ? b : undefined,
				o,
				t,
				winner,
				[...path, key],
				overridden,
			);
		else {
			value = winner === 'ours' ? o : t;
			overridden.push({ kind: 'field', field: pointer([...path, key]) });
		}
		setField(merged, key, value);
	}
	return merged;
}

/**
 * A JSON file by key, `winner` winning each competing key. A version that
 * does not parse, or holds a number a rewrite would change, merges by line,
 * so neither side's edit leaves the file, with two insertions at one place
 * competing, since joining them could write one key twice; JSON that is not
 * an object merges whole. A result equal to a side is that side's bytes;
 * otherwise it is written with a two-space indent, after a byte-order mark
 * when either side has one.
 */
async function jsonWins(
	versions: FileVersions,
	base: string | null,
	ours: string,
	theirs: string,
	winner: Winner,
): Promise<Merged> {
	const [b, o, t] = [
		base === null ? null : readJson(base),
		readJson(ours),
		readJson(theirs),
	];
	if ([b, o, t].some((read) => read?.kind === 'text'))
		return textWins(base, ours, theirs, winner, { union: false });
	if (
		o.kind !== 'object' ||
		t.kind !== 'object' ||
		(b !== null && b.kind !== 'object')
	)
		return wholeFile(versions, winner);
	const overridden: Overridden[] = [];
	const value = mergeObjects(
		b?.value,
		o.value,
		t.value,
		winner,
		[],
		overridden,
	);
	const content = sameValue(value, o.value)
		? ours
		: sameValue(value, t.value)
			? theirs
			: `${[ours, theirs].some((text) => text.startsWith(BOM)) ? BOM : ''}${JSON.stringify(value, null, 2)}\n`;
	return { content, overridden };
}

/**
 * Whether `path` is Markdown and some present version opens with closed
 * frontmatter. A `---` first line with no closing fence is a thematic break
 * in plain text.
 */
const hasFrontmatter = (path: string, texts: readonly (string | null)[]) =>
	path.endsWith(MARKDOWN_EXTENSION) &&
	texts.some(
		(text) => text !== null && frameRowText(text).kind === 'frontmatter',
	);

/**
 * Merge three versions of the file at `path`, `ours` the writer acting,
 * by its content and extension. A side with no file, or a version that is
 * not UTF-8 text without a NUL byte, makes the whole file one unit, where a
 * delete beats an edit. With `theirs` winning, `overridden` names only a
 * file lost to a delete: every unit theirs won kept what was there.
 */
export async function merge(
	path: string,
	versions: FileVersions,
	{ winner = 'ours' }: { readonly winner?: Winner } = {},
): Promise<Merged> {
	const merged = await mergeBy(path, versions, winner);
	return winner === 'ours'
		? merged
		: {
				...merged,
				overridden: merged.overridden.filter((unit) => unit.kind === 'file'),
			};
}

async function mergeBy(
	path: string,
	versions: FileVersions,
	winner: Winner,
): Promise<Merged> {
	// Only competing changes are merged by unit.
	const settled = oneSided(versions);
	if (settled !== undefined) return settled;
	const [base, ours, theirs] = [
		textOf(versions.base),
		textOf(versions.ours),
		textOf(versions.theirs),
	];
	if (
		base === undefined ||
		ours === undefined ||
		theirs === undefined ||
		ours === null ||
		theirs === null
	)
		return wholeFile(versions, winner);
	if (path.endsWith(JSON_EXTENSION))
		return jsonWins(versions, base, ours, theirs, winner);
	if (hasFrontmatter(path, [base, ours, theirs]))
		return (
			(await markdownWins(base, ours, theirs, winner)) ??
			rowTextWins(base, ours, theirs, winner)
		);
	return textWins(base, ours, theirs, winner);
}
