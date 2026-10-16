/**
 * The three-way merge of a folder file, by the file's kind (ADR-0551,
 * ADR-0576).
 *
 * `merge` is the one merge every write makes: `ours` is the writer acting,
 * and it wins every unit both sides changed differently.
 *
 * | Kind | Unit |
 * | --- | --- |
 * | `kv.json` | one root key |
 * | a row of a declared table | one frontmatter field; one region of body lines |
 * | other UTF-8 text | one region of lines |
 * | binary, or a side absent | the whole file |
 *
 * Units only one side changed all survive. Two insertions at one place in a
 * body or a text both survive, and identical ones are one (`mergeLines`).
 * A delete beats an edit the deleting side never saw: only a side with no
 * base brings a file into existence.
 * A row or `kv.json` version that does not read as its kind merges as text,
 * and so does a merge of rows that does not write as one: the result is a
 * file a person can repair, never a refusal (ADR-0503).
 *
 * Rows are compared by the values `parseRow` reads, never by their spelling,
 * so key order, quoting, and frontmatter comments never compete, and a
 * merged row is written in canonical form by `writeRow`. Values compare as
 * JSON, so object key order does not matter and arrays and objects are one
 * unit each. A row `ours` left as `base` had it is no change: `theirs`
 * stands as it is, spelling included.
 *
 * `mergeFile` is the earlier form, which returns the competing units and a
 * `settle(pick)` for each caller to drive. Sync's choices and the Git merge
 * driver still settle through it.
 *
 * This module writes nothing and loads no Git implementation.
 */
import type { FieldMap } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderDefinition, PreparedFolderTable } from './definition.js';
import { mergeLines, type SettledRegion } from './git/merge-lines.js';
import { KV_PATH, settingText } from './kv.js';
import { reconcileKv } from './kv-merge.js';
import { frameRowText } from './markdown.js';
import { DECLARATION_PATH, ROW_EXTENSION } from './paths.js';
import { type AnyRow, mergeRows, sameValue, setField } from './row-merge.js';
import { parseRow, writeRow } from './row-text.js';

/** How a path merges: decided by its place in the folder, for save and Sync alike. */
export type FileKind =
	| { readonly kind: 'kv'; readonly schemas: FieldMap }
	| { readonly kind: 'row'; readonly table: PreparedFolderTable }
	/** `epicenter.json`, which merges whole but for the union of `local`. */
	| { readonly kind: 'declaration' }
	| { readonly kind: 'file' };

/** A file's content as a merge reads it: text, or bytes that may be text. */
export type FileContent = string | Uint8Array;

/** A file at the merge base and on each side, `null` for no file. */
export type FileVersions = {
	readonly base: FileContent | null;
	readonly ours: FileContent | null;
	readonly theirs: FileContent | null;
};

/**
 * One unit both sides changed differently.
 *
 * - `setting`: one root key of `kv.json`; values are JSON, `undefined` for
 *   no such key.
 * - `field`: one frontmatter field of a row; `undefined` for no such field.
 * - `text`: a row's body or a whole text file, merged by line. `ours` and
 *   `theirs` are the merge with that side winning every competing region,
 *   and `regions` name those regions. `base` is `undefined` with no base.
 * - `whole`: the file as one unit, because a side has none or a version is
 *   not UTF-8 text. `binary` says a version is not text.
 */
export type MergeUnit =
	| {
			readonly kind: 'setting';
			readonly key: string;
			readonly base: unknown;
			readonly ours: unknown;
			readonly theirs: unknown;
	  }
	| {
			readonly kind: 'field';
			readonly field: string;
			readonly base: unknown;
			readonly ours: unknown;
			readonly theirs: unknown;
	  }
	| {
			readonly kind: 'text';
			readonly part: 'body' | 'file';
			readonly base: string | undefined;
			readonly ours: string;
			readonly theirs: string;
			readonly regions: readonly SettledRegion[];
	  }
	| {
			readonly kind: 'whole';
			readonly binary: boolean;
			readonly base: FileContent | null;
			readonly ours: FileContent | null;
			readonly theirs: FileContent | null;
	  };

/**
 * What one unit settles to: a side's version of it, a new value (JSON for a
 * setting or field, text for a text unit, text or bytes for a whole file),
 * or nothing. A body cannot be removed.
 */
export type UnitPick =
	| { readonly kind: 'take'; readonly side: 'ours' | 'theirs' }
	| { readonly kind: 'replace'; readonly value: unknown }
	| { readonly kind: 'remove' };

/** Why a pick cannot settle its unit. */
export type SettleProblem = {
	readonly unit: MergeUnit;
	readonly message: string;
};

/** A merge: what competes, and the file under a pick for each. */
export type FileMerge = {
	/** Every unit both sides changed differently; empty when the merge is clean. */
	readonly units: readonly MergeUnit[];
	/**
	 * The merged file with each unit settled by `pick`, `null` for no file,
	 * or every problem at once. A settled row is checked against its table.
	 */
	settle(
		pick: (unit: MergeUnit) => UnitPick,
	): Result<FileContent | null, readonly SettleProblem[]>;
};

/** The kind of `path` under `definition`; no definition knows only plain files. */
export function fileKindOf(
	definition: FolderDefinition | undefined,
	path: string,
): FileKind {
	if (path === DECLARATION_PATH) return { kind: 'declaration' };
	if (definition === undefined) return { kind: 'file' };
	if (path === KV_PATH) return { kind: 'kv', schemas: definition.kv };
	const table = tableAt(definition, path);
	return table === undefined ? { kind: 'file' } : { kind: 'row', table };
}

/** The table whose row lives at `path`, if any. */
function tableAt(
	definition: FolderDefinition,
	path: string,
): PreparedFolderTable | undefined {
	if (!path.endsWith(ROW_EXTENSION)) return undefined;
	const slash = path.indexOf('/');
	if (slash < 0 || path.indexOf('/', slash + 1) >= 0) return undefined;
	const name = path.slice(0, slash);
	return Object.hasOwn(definition.tables, name)
		? (definition.tables[name] as PreparedFolderTable)
		: undefined;
}

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

/** The settled value of a JSON unit under `pick`, `undefined` for none. */
function jsonPick(
	unit: Extract<MergeUnit, { kind: 'setting' | 'field' }>,
	pick: UnitPick,
): unknown {
	if (pick.kind === 'remove') return undefined;
	if (pick.kind === 'take')
		return pick.side === 'ours' ? unit.ours : unit.theirs;
	return pick.value;
}

/** The settled text of a text unit under `pick`, or why it is not text. */
function textPick(
	unit: Extract<MergeUnit, { kind: 'text' }>,
	pick: UnitPick,
): Result<string | null, string> {
	if (pick.kind === 'take')
		return Ok(pick.side === 'ours' ? unit.ours : unit.theirs);
	if (pick.kind === 'remove')
		return unit.part === 'body'
			? Err('A body cannot be removed; replace it with empty text')
			: Ok(null);
	if (typeof pick.value !== 'string' || !pick.value.isWellFormed())
		return Err(
			unit.part === 'body'
				? 'A body is replaced with text'
				: 'A file is replaced with well-formed text',
		);
	return Ok(pick.value);
}

/** One merge whose only unit is `unit`, settled by `content`. */
function single(
	unit: MergeUnit,
	content: (pick: UnitPick) => Result<FileContent | null, string>,
): FileMerge {
	return {
		units: [unit],
		settle(pick) {
			const { data, error } = content(pick(unit));
			return error === null ? Ok(data) : Err([{ unit, message: error }]);
		},
	};
}

/** A merge with nothing competing. */
const clean = (content: FileContent | null): FileMerge => ({
	units: [],
	settle: () => Ok(content),
});

/** The whole file as one unit: each side as it is, or a replacement. */
function whole(versions: FileVersions, binary: boolean): FileMerge {
	const unit: MergeUnit = { kind: 'whole', binary, ...versions };
	return single(unit, (pick) => {
		if (pick.kind === 'remove') return Ok(null);
		if (pick.kind === 'take')
			return Ok(pick.side === 'ours' ? versions.ours : versions.theirs);
		if (binary) return Err('A file that is not text is taken or removed');
		if (typeof pick.value !== 'string' || !pick.value.isWellFormed())
			return Err('A file is replaced with well-formed text');
		return Ok(pick.value);
	});
}

/** Three texts merged by line, competing regions one `file` unit. */
async function mergeText(
	base: string | null,
	ours: string,
	theirs: string,
): Promise<FileMerge> {
	const merged = await mergeLines({ base: base ?? '', ours, theirs });
	if (merged.regions.length === 0) return clean(merged.ours);
	const unit: MergeUnit = {
		kind: 'text',
		part: 'file',
		base: base ?? undefined,
		ours: merged.ours,
		theirs: merged.theirs,
		regions: merged.regions,
	};
	return single(unit, (pick) => textPick(unit, pick));
}

/** `kv.json` by key; versions that do not read as settings merge as text. */
function mergeSettings(
	schemas: FieldMap,
	base: string | null,
	ours: string,
	theirs: string,
): FileMerge | undefined {
	const texts = { base, ours, theirs };
	const merged = reconcileKv(texts, new Map());
	if (merged.kind === 'merged') return clean(merged.text);
	if (merged.kind !== 'conflict') return undefined;
	const json = (raw: string | null) =>
		raw === null ? undefined : (JSON.parse(raw) as unknown);
	const keys = merged.conflicts;
	const units: MergeUnit[] = keys.map((key) => ({
		kind: 'setting',
		key: key.key,
		base: json(key.base),
		ours: json(key.ours),
		theirs: json(key.theirs),
	}));
	return {
		units,
		settle(pick) {
			const resolutions = new Map<string, string | null>();
			const problems: SettleProblem[] = [];
			keys.forEach((key, index) => {
				const unit = units[index]!;
				const chosen = pick(unit);
				if (chosen.kind === 'remove') resolutions.set(key.key, null);
				else if (chosen.kind === 'take')
					resolutions.set(
						key.key,
						chosen.side === 'ours' ? key.ours : key.theirs,
					);
				else {
					const { data, error } = settingText(schemas, key.key, chosen.value);
					if (error === null && data !== null) resolutions.set(key.key, data);
					else
						problems.push({
							unit,
							message:
								error?.issues.map((issue) => issue.message).join(' ') ??
								`${key.key} is replaced with a value`,
						});
				}
			});
			if (problems.length > 0) return Err(problems);
			const settled = reconcileKv(texts, resolutions);
			if (settled.kind !== 'merged')
				throw new Error('Settled kv.json keys did not merge');
			return Ok(settled.text);
		},
	};
}

/** A row by field and body; versions that do not read as rows merge as text. */
async function mergeRow(
	table: PreparedFolderTable,
	base: string | null,
	ours: string,
	theirs: string,
): Promise<FileMerge | undefined> {
	const read = (text: string) => {
		const { data, error } = parseRow(table, text);
		return error === null ? (data as AnyRow) : undefined;
	};
	const [b, o, t] = [
		base === null ? null : read(base),
		read(ours),
		read(theirs),
	];
	if (b === undefined || o === undefined || t === undefined) return undefined;
	const merged = await mergeRows(b, o, t);
	const units: MergeUnit[] = [...merged.conflicts];
	if (merged.body.regions.length > 0)
		units.push({
			kind: 'text',
			part: 'body',
			base: b?.body,
			ours: merged.body.ours,
			theirs: merged.body.theirs,
			regions: merged.body.regions,
		});
	const write = (fields: Record<string, unknown>, body: string) =>
		writeRow(table, { fields, body } as Parameters<typeof writeRow>[1]);
	if (units.length === 0) {
		const { data: written, error } = write(merged.fields, merged.body.ours);
		// Each side was a valid row, but the merge of them is not: the whole
		// file is one unit for a person to settle.
		if (error !== null) return whole({ base, ours, theirs }, false);
		return clean(written.text);
	}
	return {
		units,
		settle(pick) {
			const fields = { ...merged.fields };
			let body = merged.body.ours;
			const problems: SettleProblem[] = [];
			for (const unit of units) {
				if (unit.kind === 'field') {
					setField(fields, unit.field, jsonPick(unit, pick(unit)));
					continue;
				}
				if (unit.kind !== 'text') continue;
				const { data, error } = textPick(unit, pick(unit));
				if (error !== null) problems.push({ unit, message: error });
				else body = data ?? '';
			}
			if (problems.length > 0) return Err(problems);
			const { data: written, error: issues } = write(fields, body);
			if (issues === null) return Ok(written.text);
			// Each issue belongs to the unit that chose its field; a field
			// nobody chose was valid on both sides.
			const bodyUnit = units.find((unit) => unit.kind === 'text');
			return Err(
				issues.map(({ message, field }) => ({
					unit:
						units.find(
							(unit) => unit.kind === 'field' && unit.field === field,
						) ??
						bodyUnit ??
						units[0]!,
					message,
				})),
			);
		},
	};
}

/**
 * Merge three versions of one file by its kind. A side with no file, or a
 * version that is not UTF-8 text without a NUL byte, makes the whole file
 * one unit.
 */
export async function mergeFile(
	kind: FileKind,
	versions: FileVersions,
): Promise<FileMerge> {
	const [base, ours, theirs] = [
		textOf(versions.base),
		textOf(versions.ours),
		textOf(versions.theirs),
	];
	if (base === undefined || ours === undefined || theirs === undefined)
		return whole(versions, true);
	if (ours === null || theirs === null) return whole(versions, false);
	const structured =
		kind.kind === 'kv'
			? mergeSettings(kind.schemas, base, ours, theirs)
			: kind.kind === 'row'
				? await mergeRow(kind.table, base, ours, theirs)
				: undefined;
	return structured ?? mergeText(base, ours, theirs);
}

/**
 * A unit of a file where the writer acting replaced another writer's change.
 *
 * - `field`: one frontmatter field of a row.
 * - `setting`: one root key of `kv.json`.
 * - `lines`: one region of a row's body or a text file. The writer's `count`
 *   lines stand there from `line`, 1-based within the body or the file; a
 *   `count` of 0 is a removal at that place.
 * - `file`: the whole file, because a side has none or a version is not
 *   UTF-8 text. `lost` names the side whose edit of it did not stand: the
 *   other writer's, under the writer acting, or either side's under a
 *   delete, since a delete beats an edit it never saw.
 *
 * It names the unit, never the content that lost: the other version is
 * still in whatever held it, such as a commit.
 */
export type Overridden =
	| { readonly kind: 'field'; readonly field: string }
	| { readonly kind: 'setting'; readonly key: string }
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

/** The patterns a declaration's `local` lists, or `undefined` when it is no declaration. */
function localPatterns(content: FileContent | null): string[] | undefined {
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
 * `epicenter.json` (ADR-0576, ADR-0577): the writer's whole file, with
 * `local` listing every pattern either side lists, sorted, so a path one
 * device keeps local is never committed because another device's
 * declaration won. A side that does not read as a declaration keeps the
 * whole-file result as it is.
 */
function declarationWins(versions: FileVersions, winner: Winner): Merged {
	const won = wholeFile(versions, winner);
	if (won.content === null) return won;
	const sides = [localPatterns(versions.ours), localPatterns(versions.theirs)];
	if (sides.some((side) => side === undefined)) return won;
	const local = [...new Set(sides.flat() as string[])].sort();
	const text = textOf(won.content) as string;
	const value = JSON.parse(text) as Record<string, unknown>;
	const current = (value.local as string[] | undefined) ?? [];
	if (
		current.length === local.length &&
		current.every((pattern, index) => pattern === local[index])
	)
		return won;
	const { title, local: _local, ...rest } = value;
	const joined = {
		...(title === undefined ? {} : { title }),
		...(local.length === 0 ? {} : { local }),
		...rest,
	};
	return {
		content: `${JSON.stringify(joined, null, 2)}\n`,
		overridden: won.overridden,
	};
}

/**
 * The side whose change stands on a unit both changed differently: the
 * writer acting, `ours`, everywhere but the Git merge driver, which also
 * asks for `theirs` to write both sides inside its conflict markers.
 */
export type Winner = 'ours' | 'theirs';

/** A competing region the writer's lines won, as `overridden` names it. */
export const linesOf = (
	part: 'body' | 'text',
	region: SettledRegion,
): Overridden => ({
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
 * A row version that does not read, merged as text: its frontmatter and its
 * body apart when every version has closed frontmatter, so insertions at one
 * place join in the body and compete in the frontmatter, where two lines
 * added side by side could write one key twice. A version without closed
 * frontmatter merges the whole text with no insertions joined.
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

/** `kv.json` by key, ours winning each competing key; `undefined` when a version does not read. */
function settingsWin(
	base: string | null,
	ours: string,
	theirs: string,
	winner: Winner,
): Merged | undefined {
	const texts = { base, ours, theirs };
	const merged = reconcileKv(texts, new Map());
	if (merged.kind === 'merged') return { content: merged.text, overridden: [] };
	if (merged.kind !== 'conflict') return undefined;
	const settled = reconcileKv(
		texts,
		new Map(merged.conflicts.map((key) => [key.key, key[winner]])),
	);
	if (settled.kind !== 'merged') return undefined;
	return {
		content: settled.text,
		overridden: merged.conflicts.map((key) => ({
			kind: 'setting',
			key: key.key,
		})),
	};
}

const sameRow = (left: AnyRow, right: AnyRow) =>
	left.body === right.body && sameValue(left.fields, right.fields);

/**
 * A row by field and body, ours winning each competing unit, written
 * canonically; `undefined` when a present version does not read as a row or
 * the merge does not write as one.
 */
async function rowWins(
	table: PreparedFolderTable,
	texts: { base: string | null; ours: string | null; theirs: string | null },
	winner: Winner,
): Promise<Merged | undefined> {
	const read = (text: string | null) => {
		if (text === null) return null;
		const { data, error } = parseRow(table, text);
		return error === null ? (data as AnyRow) : undefined;
	};
	const [b, o, t] = [read(texts.base), read(texts.ours), read(texts.theirs)];
	if (b === undefined || o === undefined || t === undefined) return undefined;
	const canonical = (row: AnyRow) => {
		const { data, error } = writeRow(
			table,
			row as Parameters<typeof writeRow>[1],
		);
		return error === null ? data.text : undefined;
	};
	// The writer changed nothing: their file stands as it is.
	if (o !== null && b !== null && sameRow(o, b))
		return { content: texts.theirs, overridden: [] };
	if (o === null || t === null) {
		const whole = wholeFile(texts, winner);
		if (whole.content === null || whole.content === texts.theirs) return whole;
		const text = canonical(o as AnyRow);
		return text === undefined ? undefined : { ...whole, content: text };
	}
	const merged = await mergeRows(b, o, t);
	const fields = { ...merged.fields };
	for (const unit of merged.conflicts)
		setField(fields, unit.field, unit[winner]);
	const text = canonical({ fields, body: merged.body[winner] });
	if (text === undefined) return undefined;
	return {
		content: text,
		overridden: [
			...merged.conflicts.map(
				(unit): Overridden => ({ kind: 'field', field: unit.field }),
			),
			...merged.body.regions.map((region) => linesOf('body', region)),
		],
	};
}

/**
 * Merge three versions of one file by its kind, `ours` the writer acting.
 * A side with no file, or a version that is not UTF-8 text without a NUL
 * byte, makes the whole file one unit, where a delete beats an edit; a row
 * is still written canonically when ours wins it.
 */
export async function merge(
	kind: FileKind,
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
	if (kind.kind === 'declaration') return declarationWins(versions, winner);
	const [base, ours, theirs] = [
		textOf(versions.base),
		textOf(versions.ours),
		textOf(versions.theirs),
	];
	if (base === undefined || ours === undefined || theirs === undefined)
		return wholeFile(versions, winner);
	if (kind.kind === 'row') {
		const row = await rowWins(kind.table, { base, ours, theirs }, winner);
		if (row !== undefined) return row;
	}
	if (ours === null || theirs === null) return wholeFile(versions, winner);
	if (kind.kind === 'row') return rowTextWins(base, ours, theirs, winner);
	const structured =
		kind.kind === 'kv' ? settingsWin(base, ours, theirs, winner) : undefined;
	return structured ?? textWins(base, ours, theirs, winner);
}
