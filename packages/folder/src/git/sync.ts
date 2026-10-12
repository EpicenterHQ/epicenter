/**
 * The plain data `folder.sync` exchanges with its caller, and the merge
 * rules sync adds to a Git merge (ADR-0514).
 *
 * `syncMerge(definition)` merges each text path both sides changed, as
 * `prepareMerge` asks: root `kv.json` by key, each row of a declared table
 * by field and body through `parseRow`, written back with `formatRow`, and
 * any other text file by line. A unit both sides changed differently is
 * held: both merge children keep our file there, and the merge records a
 * conflict. A deleted or unreadable version, or a text file whose lines
 * compete, holds the whole file as one unit. Binary files, modes, and file
 * against directory are left to Git's rules.
 *
 * `held.attempt(...)` turns what a merge held into a `SyncAttempt`, the
 * frozen report a caller reviews, and `settle(choices)`, which validates
 * one choice per conflict and answers the text each held path takes. The
 * owner keeps `settle`; the caller never sends source back, so `take` uses
 * what was captured. A second `syncMerge` given those texts merges the same
 * commits again with every held path settled.
 *
 * This module writes nothing and loads no Git implementation.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderDefinition, PreparedFolderTable } from '../definition.js';
import { KV_PATH, settingText } from '../kv.js';
import { reconcileKv } from '../kv-merge.js';
import { ROW_EXTENSION } from '../paths.js';
import { type AnyRow, type FieldConflict, mergeRow } from '../row-merge.js';
import { writeRow } from '../row-text.js';
import { type SyncChoiceProblem, SyncError } from './errors.js';
import type { PushOutcome } from './history.js';
import type { MergePath, TextVersions } from './merge.js';
import { mergeLines } from './merge-lines.js';

/** Which captured history a version or a `take` comes from. */
export type SyncSide = 'local' | 'incoming';

/**
 * One captured version of a conflict's unit: absent, or its value. A
 * `setting` or `field` value is JSON; a `body` or `file` value is its text.
 * Absent differs from a present `null` or empty string.
 */
export type SyncVersion =
	| { readonly present: false }
	| { readonly present: true; readonly value: unknown };

type Versions = {
	/** Opaque; the key a choice is submitted under. */
	readonly id: string;
	readonly path: string;
	/** The merge base's version, for inspection. */
	readonly base: SyncVersion;
	readonly local: SyncVersion;
	readonly incoming: SyncVersion;
};

/**
 * One unit both histories changed differently:
 *
 * - `setting`: one root key of `kv.json`.
 * - `field`: one frontmatter field of a row.
 * - `body`: a row's Markdown body; both sides are present.
 * - `file`: a whole text file, when a side deleted it, a version does not
 *   read as a row (or `kv.json` as one JSON object), or, outside a table,
 *   both sides changed the same lines. Its text is written exactly as
 *   chosen; a row that still does not read is repaired as text.
 */
export type SyncConflict = Versions &
	(
		| { readonly kind: 'setting'; readonly key: string }
		| { readonly kind: 'field'; readonly field: string }
		| { readonly kind: 'body' }
		| { readonly kind: 'file' }
	);

/**
 * A run that merged everything it could and needs a choice for each
 * conflict. Nothing conflicted was written: the branch is still `local`,
 * and nothing was sent. The checkpoint and the fetch already happened.
 */
export type SyncAttempt = {
	/** Names this attempt to the owner that captured it. */
	readonly id: string;
	/** The local head after the checkpoint: the merge's first parent. */
	readonly local: string;
	/** The fetched commit: the merge's second parent. Never fetched again. */
	readonly incoming: string;
	readonly conflicts: readonly SyncConflict[];
};

/**
 * One choice for one conflict:
 *
 * - `take` keeps that side's captured version; an absent side removes it.
 * - `replace` supplies a new value: JSON for a `setting` or `field`, a
 *   string for a `body` or `file`.
 * - `remove` leaves the unit out. A `body` cannot be removed; replace it
 *   with `''`.
 */
export type SyncChoice =
	| { readonly kind: 'take'; readonly side: SyncSide }
	| { readonly kind: 'replace'; readonly value: unknown }
	| { readonly kind: 'remove' };

/**
 * One choice per conflict, keyed by conflict ID. An own entry holding
 * `undefined`, or none, leaves its conflict unanswered.
 */
export type SyncChoices = Readonly<Partial<Record<string, SyncChoice>>>;

/**
 * Where a run or a resolution ended without needing choices.
 *
 * `synced`: the remote branch is confirmed at `head`, and no save this
 * folder knows of landed after the files were captured.
 *
 * `saved`: `head` holds the result here, but the remote is not confirmed to
 * hold everything saved. `push` is the transfer's own outcome, or undefined
 * when none ran; `changedSince` says a save landed after the capture. Sync
 * again to send it. Nothing is replayed.
 */
export type SyncOutcome =
	| { readonly kind: 'synced'; readonly head: string }
	| {
			readonly kind: 'saved';
			readonly head: string | undefined;
			readonly push: PushOutcome | undefined;
			readonly changedSince: boolean;
	  };

/** The commits a merge used; no `base` for a first sync over unrelated history. */
export type SyncCommits = {
	readonly base: string | undefined;
	readonly head: string;
	readonly fetched: string;
};

/** An attempt and what only its owner keeps: how choices settle it. */
export type HeldAttempt = {
	readonly attempt: SyncAttempt;
	readonly commits: SyncCommits;
	/**
	 * The text each held path takes under `choices`, `null` to remove the
	 * file, or every problem at once. Reads `choices` once, synchronously.
	 */
	settle(
		choices: unknown,
	): Result<ReadonlyMap<string, string | null>, SyncError>;
};

/** One held path: its conflicts, and its text under a pick for each. */
type Held = {
	readonly conflicts: readonly SyncConflict[];
	/** The path's text, or problems keyed by conflict ID. */
	settle(
		picks: ReadonlyMap<string, SyncChoice>,
	): Result<string | null, readonly SyncChoiceProblem[]>;
};

const absent: SyncVersion = Object.freeze({ present: false });
const version = (value: unknown): SyncVersion =>
	value === undefined ? absent : Object.freeze({ present: true, value });

const idOf = (kind: SyncConflict['kind'], path: string, name?: string) =>
	JSON.stringify(name === undefined ? [kind, path] : [kind, path, name]);

/** The table whose row lives at `path`, if any. */
function tableAt(
	definition: FolderDefinition | undefined,
	path: string,
): PreparedFolderTable | undefined {
	if (definition === undefined || !path.endsWith(ROW_EXTENSION))
		return undefined;
	const slash = path.indexOf('/');
	if (slash < 0 || path.indexOf('/', slash + 1) >= 0) return undefined;
	const name = path.slice(0, slash);
	return Object.hasOwn(definition.tables, name)
		? (definition.tables[name] as PreparedFolderTable)
		: undefined;
}

/** A whole file as one unit: its text as chosen, or no file. */
function heldFile(path: string, texts: TextVersions): Held {
	const id = idOf('file', path);
	const of = (text: string | null) => version(text ?? undefined);
	return {
		conflicts: [
			Object.freeze({
				id,
				kind: 'file',
				path,
				base: of(texts.base),
				local: of(texts.ours),
				incoming: of(texts.theirs),
			}),
		],
		settle(picks) {
			const pick = picks.get(id)!;
			if (pick.kind === 'remove') return Ok(null);
			if (pick.kind === 'take')
				return Ok(pick.side === 'local' ? texts.ours : texts.theirs);
			if (typeof pick.value !== 'string' || !pick.value.isWellFormed())
				return Err([
					{
						conflictId: id,
						reason: 'invalid',
						message: 'A file is replaced with well-formed text',
					},
				]);
			return Ok(pick.value);
		},
	};
}

/** `kv.json` keys that compete, settled through `kv.set`'s own rules. */
function heldSettings(
	definition: FolderDefinition | undefined,
	texts: TextVersions,
	keys: readonly {
		key: string;
		base: string | null;
		ours: string | null;
		theirs: string | null;
	}[],
): Held {
	const json = (raw: string | null) =>
		version(raw === null ? undefined : JSON.parse(raw));
	const conflicts = keys.map(({ key, base, ours, theirs }) =>
		Object.freeze({
			id: idOf('setting', KV_PATH, key),
			kind: 'setting' as const,
			path: KV_PATH,
			key,
			base: json(base),
			local: json(ours),
			incoming: json(theirs),
		}),
	);
	return {
		conflicts,
		settle(picks) {
			const resolutions = new Map<string, string | null>();
			const problems: SyncChoiceProblem[] = [];
			keys.forEach(({ key, ours, theirs }, index) => {
				const id = conflicts[index]!.id;
				const pick = picks.get(id)!;
				if (pick.kind === 'remove') resolutions.set(key, null);
				else if (pick.kind === 'take')
					resolutions.set(key, pick.side === 'local' ? ours : theirs);
				else {
					const { data, error } = settingText(
						definition?.kv ?? {},
						key,
						pick.value,
					);
					if (error === null && data !== null) resolutions.set(key, data);
					else
						problems.push({
							conflictId: id,
							reason: 'invalid',
							message:
								error?.issues.map((issue) => issue.message).join(' ') ??
								`${key} is replaced with a value`,
						});
				}
			});
			if (problems.length > 0) return Err(problems);
			const merged = reconcileKv(texts, resolutions);
			if (merged.kind !== 'merged')
				throw new Error('Settled kv.json keys did not merge');
			return Ok(merged.text);
		},
	};
}

/** A row's competing fields and body, settled into one valid row. */
function heldRow(
	table: PreparedFolderTable,
	path: string,
	merged: AnyRow,
	fields: readonly FieldConflict[],
	body: { base: string | undefined; ours: string; theirs: string } | undefined,
): Held {
	const fieldConflicts = fields.map(({ field, base, ours, theirs }) =>
		Object.freeze({
			id: idOf('field', path, field),
			kind: 'field' as const,
			path,
			field,
			base: version(base),
			local: version(ours),
			incoming: version(theirs),
		}),
	);
	const bodyConflict =
		body === undefined
			? undefined
			: Object.freeze({
					id: idOf('body', path),
					kind: 'body' as const,
					path,
					base: version(body.base),
					local: version(body.ours),
					incoming: version(body.theirs),
				});
	const conflicts: SyncConflict[] = [...fieldConflicts];
	if (bodyConflict !== undefined) conflicts.push(bodyConflict);
	return {
		conflicts,
		settle(picks) {
			const values: Record<string, unknown> = { ...merged.fields };
			const problems: SyncChoiceProblem[] = [];
			fields.forEach(({ field, ours, theirs }, index) => {
				const pick = picks.get(fieldConflicts[index]!.id)!;
				const value =
					pick.kind === 'remove'
						? undefined
						: pick.kind === 'take'
							? pick.side === 'local'
								? ours
								: theirs
							: pick.value;
				if (value === undefined) delete values[field];
				else
					Object.defineProperty(values, field, {
						value,
						enumerable: true,
						writable: true,
						configurable: true,
					});
			});
			let text = merged.body;
			if (bodyConflict !== undefined && body !== undefined) {
				const pick = picks.get(bodyConflict.id)!;
				if (pick.kind === 'take')
					text = pick.side === 'local' ? body.ours : body.theirs;
				else if (pick.kind === 'replace' && typeof pick.value === 'string')
					text = pick.value;
				else
					problems.push({
						conflictId: bodyConflict.id,
						reason: 'invalid',
						message: 'A body is replaced with text',
					});
			}
			if (problems.length > 0) return Err(problems);
			const { data: written, error: issues } = writeRow(table, {
				fields: values,
				body: text,
			} as Parameters<typeof writeRow>[1]);
			if (issues === null) return Ok(written.text);
			// Each issue belongs to the conflict that chose its field; a
			// field nobody chose was valid on both sides, so it never fails.
			const fallback = conflicts[0]!.id;
			return Err(
				issues.map(({ message, field }) => ({
					conflictId:
						fieldConflicts.find((conflict) => conflict.field === field)?.id ??
						bodyConflict?.id ??
						fallback,
					reason: 'invalid' as const,
					message,
				})),
			);
		},
	};
}

/**
 * One text file's three versions under sync's rules: root `kv.json` by key,
 * a row of a declared table by field and body, any other text file by line.
 * What cannot be settled is held: a unit both changed differently, or the
 * whole file when a side has none, a version does not read, or lines compete.
 */
async function holdFile(
	definition: FolderDefinition | undefined,
	path: string,
	texts: TextVersions,
): Promise<
	| { readonly kind: 'merged'; readonly text: string | null }
	| { readonly kind: 'held'; readonly held: Held }
> {
	if (path === KV_PATH) {
		const merged = reconcileKv(texts, new Map());
		if (merged.kind === 'merged') return merged;
		return {
			kind: 'held',
			held:
				merged.kind === 'conflict'
					? heldSettings(definition, texts, merged.conflicts)
					: heldFile(path, texts),
		};
	}
	const table = tableAt(definition, path);
	if (table === undefined) {
		// Any other text file merges by line; what does not is one unit.
		if (texts.ours !== null && texts.theirs !== null) {
			const text = await mergeLines({
				base: texts.base ?? '',
				ours: texts.ours,
				theirs: texts.theirs,
			});
			if (text !== undefined) return { kind: 'merged', text };
		}
		return { kind: 'held', held: heldFile(path, texts) };
	}
	const merged = await mergeRow(table, texts);
	if (merged.kind === 'merged') {
		const { data: written, error } = writeRow(
			table,
			merged.row as Parameters<typeof writeRow>[1],
		);
		if (error === null) return { kind: 'merged', text: written.text };
	}
	return {
		kind: 'held',
		held:
			merged.kind === 'conflict'
				? heldRow(table, path, merged.row, merged.fields, merged.body)
				: heldFile(path, texts),
	};
}

/**
 * One file's three versions merged as sync merges it, for a caller with no
 * Git history, such as an edit session whose save met a change made
 * elsewhere. `merged` is the file's text, `null` for no file. `held` names
 * the units a person chooses; `settle(choices)` answers the file's text
 * under one choice for each, `null` to leave no file, or every problem at
 * once, reading `choices` once. Writes nothing.
 */
export type FileMerge =
	| { readonly kind: 'merged'; readonly text: string | null }
	| {
			readonly kind: 'held';
			readonly conflicts: readonly SyncConflict[];
			settle(choices: unknown): Result<string | null, SyncError>;
	  };

export async function mergeFile(
	definition: FolderDefinition | undefined,
	path: string,
	texts: TextVersions,
): Promise<FileMerge> {
	const merged = await holdFile(definition, path, texts);
	if (merged.kind === 'merged') return merged;
	const { conflicts } = merged.held;
	const paths = new Map([[path, merged.held]]);
	return Object.freeze({
		kind: 'held',
		conflicts: Object.freeze([...conflicts]),
		settle(choices: unknown) {
			const { data, error } = settle(paths, conflicts, choices);
			return error === null ? Ok(data.get(path) ?? null) : Err(error);
		},
	});
}

/**
 * The merge rules sync adds to a Git merge, for one merge. `settled` gives
 * held paths their chosen text, so the same commits merge again with every
 * conflict answered. `held` collects what the merge could not settle.
 */
export function syncMerge(
	definition: FolderDefinition | undefined,
	settled: ReadonlyMap<string, string | null> = new Map(),
): {
	readonly mergePath: MergePath;
	readonly held: ReadonlyMap<string, Held>;
	attempt(commits: SyncCommits): HeldAttempt;
} {
	const held = new Map<string, Held>();
	const mergePath: MergePath = async (path, texts) => {
		if (settled.has(path))
			return { kind: 'merged', text: settled.get(path) ?? null };
		const merged = await holdFile(definition, path, texts);
		if (merged.kind === 'merged') return merged;
		held.set(path, merged.held);
		return { kind: 'held' };
	};

	return {
		mergePath,
		held,
		attempt(commits) {
			const conflicts = [...held]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.flatMap(([, entry]) => entry.conflicts);
			const attempt: SyncAttempt = Object.freeze({
				id: crypto.randomUUID(),
				local: commits.head,
				incoming: commits.fetched,
				conflicts: Object.freeze(conflicts),
			});
			const paths = new Map(held);
			return Object.freeze({
				attempt,
				commits,
				settle: (choices: unknown) => settle(paths, conflicts, choices),
			});
		},
	};
}

/** `choice` as a choice its conflict allows, or why it is not one. */
function pickOf(
	conflict: SyncConflict,
	choice: unknown,
): SyncChoice | 'malformed' | 'disallowed' {
	if (typeof choice !== 'object' || choice === null || Array.isArray(choice))
		return 'malformed';
	const { kind } = choice as { kind?: unknown };
	switch (kind) {
		case 'take': {
			const { side } = choice as { side?: unknown };
			return side === 'local' || side === 'incoming'
				? { kind, side }
				: 'malformed';
		}
		case 'replace': {
			const { value } = choice as { value?: unknown };
			return value === undefined ? 'malformed' : { kind, value };
		}
		case 'remove':
			return conflict.kind === 'body' ? 'disallowed' : { kind };
		default:
			return 'malformed';
	}
}

const PROBLEM_MESSAGES: Record<
	Exclude<SyncChoiceProblem['reason'], 'invalid'>,
	string
> = {
	malformed:
		'This is not a choice: take a side, replace with a value, or remove',
	unknown: 'No conflict of this attempt has this ID',
	missing: 'This conflict has no choice',
	disallowed: 'A body cannot be removed; replace it with empty text',
};

const problem = (
	reason: Exclude<SyncChoiceProblem['reason'], 'invalid'>,
	conflictId?: string,
): SyncChoiceProblem =>
	conflictId === undefined
		? { reason, message: PROBLEM_MESSAGES[reason] }
		: { conflictId, reason, message: PROBLEM_MESSAGES[reason] };

/**
 * Every held path's text under `choices`, or every problem at once: shape
 * problems in conflict order, then unknown keys, then values the folder
 * refuses. Each entry is read once; nothing read is kept.
 */
function settle(
	paths: ReadonlyMap<string, Held>,
	conflicts: readonly SyncConflict[],
	choices: unknown,
): Result<ReadonlyMap<string, string | null>, SyncError> {
	if (typeof choices !== 'object' || choices === null || Array.isArray(choices))
		return SyncError.InvalidChoices({ problems: [problem('malformed')] });
	const submitted = choices as Readonly<Record<string, unknown>>;
	const picks = new Map<string, SyncChoice>();
	const problems: SyncChoiceProblem[] = [];
	for (const conflict of conflicts) {
		const choice = Object.hasOwn(submitted, conflict.id)
			? submitted[conflict.id]
			: undefined;
		if (choice === undefined) {
			problems.push(problem('missing', conflict.id));
			continue;
		}
		const pick = pickOf(conflict, choice);
		if (typeof pick === 'string') problems.push(problem(pick, conflict.id));
		else picks.set(conflict.id, pick);
	}
	const known = new Set(conflicts.map(({ id }) => id));
	for (const key of Object.getOwnPropertyNames(submitted))
		if (!known.has(key)) problems.push(problem('unknown', key));
	if (problems.length > 0) return SyncError.InvalidChoices({ problems });
	const texts = new Map<string, string | null>();
	for (const [path, entry] of paths) {
		const { data, error } = entry.settle(picks);
		if (error === null) texts.set(path, data);
		else problems.push(...error);
	}
	if (problems.length > 0) return SyncError.InvalidChoices({ problems });
	return Ok(texts);
}
