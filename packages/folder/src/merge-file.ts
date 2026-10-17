/**
 * The three-way merge of a folder file, by its content and its extension
 * (ADR-0551, ADR-0576, ADR-0585). No definition takes part: a file merges
 * the same wherever it is in the folder and whatever reads it.
 *
 * `merge` is the one merge every write and Sync make: `ours` is the writer
 * acting, and it wins every unit both sides changed differently.
 *
 * | File | Unit |
 * | --- | --- |
 * | `.md` whose present versions all have frontmatter `parseRowSource` reads | one frontmatter field; one region of body lines |
 * | `.json` whose present versions all parse as JSON objects | one key; a key whose value is an object on both sides is its own keys |
 * | other UTF-8 text | one region of lines |
 * | binary, or a side absent | the whole file |
 *
 * Units only one side changed all survive. Two insertions at one place in a
 * body or a text both survive, and identical ones are one (`mergeLines`).
 * A delete beats an edit the deleting side never saw: only a side with no
 * base brings a file into existence. A Markdown version whose frontmatter
 * does not read merges as text, and a JSON version that is not an object
 * merges as the whole file: the result is a file a person can repair, never
 * a refusal (ADR-0503).
 *
 * Fields and keys compare by value as JSON, never by spelling, so key order,
 * quoting, and frontmatter comments never compete, and an array is one unit.
 * A merged file keeps a side's bytes wherever its values are that side's:
 * frontmatter whose merged fields equal ours' or theirs' is that side's
 * frontmatter exactly, comments included, and a JSON file whose merged value
 * equals a side's is that side's file. Only a result that differs from both
 * is written canonically, keys in ours' order and then keys only theirs
 * added: frontmatter by `formatRowSource`, JSON by `JSON.stringify` with a
 * two-space indent, which puts integer-like keys first as JavaScript orders
 * them.
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
import { ROW_EXTENSION } from './paths.js';
import { type AnyRow, mergeRows, sameValue, setField } from './row-merge.js';
import { lineFeeds } from './row-text.js';

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
 * A unit of a file where the writer acting replaced another writer's change.
 *
 * - `field`: one frontmatter field, or one key of a JSON file, named by its
 *   path from the top: keys joined with `/`, each `~` and `/` in a key
 *   written `~0` and `~1` as in a JSON Pointer, so `title` is a top-level
 *   field and `tables/todos` the key `todos` inside `tables`.
 * - `lines`: one region of a Markdown body or a text file. The writer's `count`
 *   lines stand there from `line`, 1-based within the body or the file; a
 *   `count` of 0 is a removal at that place.
 * - `file`: the whole file, because a side has none, a version is not
 *   UTF-8 text, or a version of a `.json` file is not a JSON object. `lost` names the side whose edit of it did not stand: the
 *   other writer's, under the writer acting, or either side's under a
 *   delete, since a delete beats an edit it never saw.
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
	/** Each unit both sides changed differently, in file order. Empty when nothing competed. */
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
 * The whole file as one unit: a side that changed nothing yields. Where
 * both changed it, a delete beats the edit it never saw, and otherwise ours
 * wins. Whether a file exists is decided by a delete; what it holds, by the
 * writer acting.
 */
export function wholeFile(
	{ base, ours, theirs }: FileVersions,
	winner: Winner = 'ours',
): Merged {
	if (sameContent(ours, theirs) || sameContent(theirs, base))
		return { content: ours, overridden: [] };
	if (sameContent(ours, base)) return { content: theirs, overridden: [] };
	if (ours === null)
		return { content: null, overridden: [{ kind: 'file', lost: 'theirs' }] };
	if (theirs === null)
		return { content: null, overridden: [{ kind: 'file', lost: 'ours' }] };
	return winner === 'ours'
		? { content: ours, overridden: [{ kind: 'file', lost: 'theirs' }] }
		: { content: theirs, overridden: [{ kind: 'file', lost: 'ours' }] };
}

/** The patterns `epicenter.json`'s `local` lists, or `undefined` when it does not read as a definition. */
export function localPatterns(
	content: FileContent | null,
): string[] | undefined {
	const text = content === null ? undefined : textOf(content);
	if (text === undefined || text === null) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== 'object' || value === null || Array.isArray(value))
			return undefined;
		const local = (value as { local?: unknown }).local;
		if (local === undefined) return [];
		if (!Array.isArray(local) || local.some((item) => typeof item !== 'string'))
			return undefined;
		return local as string[];
	} catch {
		return undefined;
	}
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

/** Three texts by line, `winner` winning each competing region. */
async function textWins(
	base: string | null,
	ours: string,
	theirs: string,
	winner: Winner,
): Promise<Merged> {
	const merged = await mergeLines({ base: base ?? '', ours, theirs });
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

/**
 * Markdown with frontmatter by field and body, `winner` winning each
 * competing unit. The frontmatter is a side's own bytes when the merged
 * fields are that side's, and the whole file is when the body is too;
 * otherwise the frontmatter is canonical. `undefined` when a present
 * version's frontmatter does not read or the merged fields have no
 * canonical form.
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
	const overridden = [
		...merged.conflicts.map(
			(unit): Overridden => ({ kind: 'field', field: pointer([unit.field]) }),
		),
		...merged.body.regions.map((region) => linesOf('body', region)),
	];
	const kept = [o, t].find((side) => sameValue(fields, side.fields));
	if (kept !== undefined)
		return {
			content: body === kept.body ? kept.text : kept.head + body,
			overridden,
		};
	const { data, error } = formatRowSource(
		{ fields, body } as CanonicalDocument,
		[...new Set([...Object.keys(o.fields), ...Object.keys(t.fields)])],
	);
	return error === null ? { content: data.text, overridden } : undefined;
}

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** `text` as a JSON object, or `undefined` when it is not one. */
function jsonObject(text: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return isJsonObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
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
 * A JSON file by key, `winner` winning each competing key; `undefined` when
 * a present version is not a JSON object.
 */
function jsonWins(
	base: string | null,
	ours: string,
	theirs: string,
	winner: Winner,
): Merged | undefined {
	const [b, o, t] = [
		base === null ? null : jsonObject(base),
		jsonObject(ours),
		jsonObject(theirs),
	];
	if (b === undefined || o === undefined || t === undefined) return undefined;
	const overridden: Overridden[] = [];
	const value = mergeObjects(b ?? undefined, o, t, winner, [], overridden);
	const content = sameValue(value, o)
		? ours
		: sameValue(value, t)
			? theirs
			: `${JSON.stringify(value, null, 2)}\n`;
	return { content, overridden };
}

/** Whether `path` is Markdown and some present version opens with frontmatter. */
const hasFrontmatter = (path: string, texts: readonly (string | null)[]) =>
	path.endsWith(ROW_EXTENSION) &&
	texts.some((text) => text !== null && frameRowText(text).kind !== 'missing');

/**
 * Merge three versions of the file at `path`, `ours` the writer acting,
 * by its content and extension. A side with no file, or a version that is
 * not UTF-8 text without a NUL byte, makes the whole file one unit, where a
 * delete beats an edit.
 */
export async function merge(
	path: string,
	versions: FileVersions,
	{ winner = 'ours' }: { readonly winner?: Winner } = {},
): Promise<Merged> {
	// A side that changed nothing leaves the other's bytes exactly as they
	// are, in whatever spelling: only competing changes are merged by unit.
	if (
		sameContent(versions.theirs, versions.base) ||
		sameContent(versions.ours, versions.theirs)
	)
		return { content: versions.ours, overridden: [] };
	if (sameContent(versions.ours, versions.base))
		return { content: versions.theirs, overridden: [] };
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
		return jsonWins(base, ours, theirs, winner) ?? wholeFile(versions, winner);
	if (hasFrontmatter(path, [base, ours, theirs]))
		return (
			(await markdownWins(base, ours, theirs, winner)) ??
			rowTextWins(base, ours, theirs, winner)
		);
	return textWins(base, ours, theirs, winner);
}
