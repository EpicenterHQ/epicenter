/**
 * The one three-way merge of a folder file, by the file's kind (ADR-0551).
 *
 * Save and Sync both merge here, so they cannot disagree about what merges:
 *
 * | Kind | Merges by | A competing unit |
 * | --- | --- | --- |
 * | `kv.json` | key, through `reconcileKv` | one setting |
 * | a row of a declared table | field, and the body by line | one field; the body |
 * | other UTF-8 text | line | the file's text |
 * | binary, or a side absent | none | the whole file |
 *
 * A row or `kv.json` version that does not read as its kind merges as text
 * (ADR-0503): the result is a file a person can repair, not a refusal.
 *
 * Rows are compared by the values `parseRow` reads, never by their spelling,
 * so key order, quoting, and frontmatter comments never compete; a merged row
 * is written in canonical form by `writeRow`. Values compare as JSON, so
 * object key order does not matter and arrays and objects are one unit each.
 *
 * Each side of a text unit is a line merge with that side winning every
 * competing region, never a captured version: taking a side keeps the other
 * side's lines that did not compete.
 *
 * This module writes nothing and loads no Git implementation.
 */
import type { FieldMap } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderDefinition, PreparedFolderTable } from './definition.js';
import { mergeLines, type SettledRegion } from './git/merge-lines.js';
import { KV_PATH, settingText } from './kv.js';
import { reconcileKv } from './kv-merge.js';
import { ROW_EXTENSION } from './paths.js';
import { type AnyRow, mergeRows, setField } from './row-merge.js';
import { parseRow, writeRow } from './row-text.js';

/** How a path merges: decided by its place in the folder, for save and Sync alike. */
export type FileKind =
	| { readonly kind: 'kv'; readonly schemas: FieldMap }
	| { readonly kind: 'row'; readonly table: PreparedFolderTable }
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
