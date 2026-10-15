/**
 * The plain data `folder.sync` exchanges with its caller, and the merge
 * rules sync adds to a Git merge (ADR-0514, ADR-0551).
 *
 * `syncMerge(definition)` merges each plain file both sides changed, as
 * `prepareMerge` asks, with `mergeFile`: the same merge a save makes, by the
 * file's kind. Root `kv.json` merges by key, each row of a declared table by
 * field and its body by line, written back in canonical form, and any other
 * text file by line. A unit both sides changed differently is held: both
 * merge children keep our file there, and the merge records a conflict. A
 * side with no file, or a version that is not text, holds the whole file as
 * one unit. Modes and file against directory are left to Git's rules.
 *
 * `held.attempt(...)` turns what a merge held into a `SyncAttempt`, the
 * frozen report a caller reviews, and `settle(choices)`, which validates
 * one choice per conflict and answers the content each held path takes,
 * through the same `settle` a save uses. The owner keeps `settle`; the
 * caller never sends source back. A second `syncMerge` given those contents
 * merges the same commits again with every held path settled.
 *
 * This module writes nothing and loads no Git implementation.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderDefinition } from '../definition.js';
import {
	type FileContent,
	type FileMerge,
	fileKindOf,
	type MergeUnit,
	mergeFile,
	type UnitPick,
} from '../merge-file.js';
import { type SyncChoiceProblem, SyncError } from './errors.js';
import type { PushOutcome } from './history.js';
import type { MergePath } from './merge.js';

/** Which history a version or a `take` comes from. */
export type SyncSide = 'local' | 'incoming';

/**
 * One version of a conflict's unit: absent, or its value. A `setting` or
 * `field` value is JSON; a `body` value is its text, and a `file` value its
 * text, or its bytes when the file is not text. Absent differs from a
 * present `null` or empty string.
 *
 * For a `body`, and a `file` both sides changed by line, `local` and
 * `incoming` are the line merge with that side winning every region both
 * changed: each keeps the other side's lines that did not compete.
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
 * - `body`: a row's Markdown body, both sides changing the same lines.
 * - `file`: a whole file. Either a text file both sides changed by line
 *   (outside a table, or a row or `kv.json` version that does not read as
 *   its kind), or the file as one unit, when a side deleted it or a version
 *   is not text. Its content is written exactly as chosen; a row that still
 *   does not read is repaired as text. `binary` says a version is not text:
 *   such a file is taken or removed, never replaced.
 */
export type SyncConflict = Versions &
	(
		| { readonly kind: 'setting'; readonly key: string }
		| { readonly kind: 'field'; readonly field: string }
		| { readonly kind: 'body' }
		| { readonly kind: 'file'; readonly binary: boolean }
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
 * - `take` keeps that side's version; an absent side removes it.
 * - `replace` supplies a new value: JSON for a `setting` or `field`, a
 *   string for a `body` or a text `file`. A binary `file` cannot be
 *   replaced.
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

/** How one sync run may merge. */
export type SyncOptions = {
	/**
	 * Merge a remote history that shares no commit with this folder's, over
	 * an empty base: both roots stay in history, and a path both hold with
	 * different bytes is a choice. Without it, such a run is `Unrelated` and
	 * writes nothing. A folder's first commit merges this way on its own.
	 */
	readonly allowUnrelatedHistories?: boolean;
};

/** The commits a merge used; no `base` for a first sync over unrelated history. */
export type SyncCommits = {
	readonly base: string | undefined;
	readonly head: string;
	readonly fetched: string;
};

/**
 * What a held attempt is, as its owner may record it to settle it from
 * another process: its ID and the commits it merged. The conflicts and how
 * choices settle them are derived again by merging those commits, so nothing
 * a caller supplied is kept.
 */
export type HeldSync = {
	readonly id: string;
	readonly commits: SyncCommits;
};

/**
 * Where a history keeps its current attempt beyond its own lifetime, so the
 * next process that opens the folder can settle it. The Bun host keeps one
 * file under `.git/epicenter` (ADR-0559); a page keeps none.
 */
export type AttemptStore = {
	load(): Promise<HeldSync | undefined>;
	save(held: HeldSync): Promise<void>;
	clear(): Promise<void>;
};

/** An attempt and what only its owner keeps: how choices settle it. */
export type HeldAttempt = {
	readonly attempt: SyncAttempt;
	readonly commits: SyncCommits;
	/**
	 * The content each held path takes under `choices`, `null` to remove the
	 * file, or every problem at once. Reads `choices` once, synchronously.
	 */
	settle(
		choices: unknown,
	): Result<ReadonlyMap<string, FileContent | null>, SyncError>;
};

/** One held path: its conflicts, and its content under a pick for each. */
type Held = {
	readonly conflicts: readonly SyncConflict[];
	/** The path's content, or problems keyed by conflict ID. */
	settle(
		picks: ReadonlyMap<string, SyncChoice>,
	): Result<FileContent | null, readonly SyncChoiceProblem[]>;
};

const absent: SyncVersion = Object.freeze({ present: false });
const version = (value: unknown): SyncVersion =>
	value === undefined ? absent : Object.freeze({ present: true, value });

const idOf = (kind: SyncConflict['kind'], path: string, name?: string) =>
	JSON.stringify(name === undefined ? [kind, path] : [kind, path, name]);

/** The conflict a merge unit is shown as. */
function conflictOf(path: string, unit: MergeUnit): SyncConflict {
	switch (unit.kind) {
		case 'setting':
			return Object.freeze({
				id: idOf('setting', path, unit.key),
				kind: 'setting',
				path,
				key: unit.key,
				base: version(unit.base),
				local: version(unit.ours),
				incoming: version(unit.theirs),
			});
		case 'field':
			return Object.freeze({
				id: idOf('field', path, unit.field),
				kind: 'field',
				path,
				field: unit.field,
				base: version(unit.base),
				local: version(unit.ours),
				incoming: version(unit.theirs),
			});
		case 'text': {
			const versions = {
				path,
				base: version(unit.base),
				local: version(unit.ours),
				incoming: version(unit.theirs),
			};
			return Object.freeze(
				unit.part === 'body'
					? { id: idOf('body', path), kind: 'body', ...versions }
					: {
							id: idOf('file', path),
							kind: 'file',
							binary: false,
							...versions,
						},
			);
		}
		case 'whole': {
			const of = (content: FileContent | null) => version(content ?? undefined);
			return Object.freeze({
				id: idOf('file', path),
				kind: 'file',
				binary: unit.binary,
				path,
				base: of(unit.base),
				local: of(unit.ours),
				incoming: of(unit.theirs),
			});
		}
	}
}

/** The unit pick a person's choice is. */
const unitPick = (choice: SyncChoice): UnitPick =>
	choice.kind === 'take'
		? { kind: 'take', side: choice.side === 'local' ? 'ours' : 'theirs' }
		: choice;

/** One path's merge held for a person: its conflicts, settled through the merge. */
function hold(path: string, merge: FileMerge): Held {
	const conflicts = merge.units.map((unit) => conflictOf(path, unit));
	const ids = new Map(
		merge.units.map((unit, index) => [unit, conflicts[index]!.id]),
	);
	return {
		conflicts,
		settle(picks) {
			const { data, error } = merge.settle((unit) =>
				unitPick(picks.get(ids.get(unit)!)!),
			);
			if (error === null) return Ok(data);
			return Err(
				error.map(({ unit, message }) => ({
					conflictId: ids.get(unit)!,
					reason: 'invalid' as const,
					message,
				})),
			);
		},
	};
}

/**
 * The merge rules sync adds to a Git merge, for one merge. `settled` gives
 * held paths their chosen content, so the same commits merge again with
 * every conflict answered. `held` collects what the merge could not settle.
 */
export function syncMerge(
	definition: FolderDefinition | undefined,
	settled: ReadonlyMap<string, FileContent | null> = new Map(),
): {
	readonly mergePath: MergePath;
	readonly held: ReadonlyMap<string, Held>;
	/** The attempt this merge held, named `id`, or a new random ID. */
	attempt(commits: SyncCommits, id?: string): HeldAttempt;
} {
	const held = new Map<string, Held>();
	const mergePath: MergePath = async (path, versions) => {
		if (settled.has(path))
			return { kind: 'merged', content: settled.get(path) ?? null };
		const merge = await mergeFile(fileKindOf(definition, path), versions);
		if (merge.units.length === 0) {
			const { data: content, error } = merge.settle(() => {
				throw new Error('A clean merge has no unit to pick');
			});
			if (error !== null) throw new Error('A clean merge did not settle');
			return { kind: 'merged', content };
		}
		held.set(path, hold(path, merge));
		return { kind: 'held' };
	};

	return {
		mergePath,
		held,
		attempt(commits, id = crypto.randomUUID()) {
			const conflicts = [...held]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.flatMap(([, entry]) => entry.conflicts);
			const attempt: SyncAttempt = Object.freeze({
				id,
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
			if (value === undefined) return 'malformed';
			return conflict.kind === 'file' && conflict.binary
				? 'disallowed'
				: { kind, value };
		}
		case 'remove':
			return conflict.kind === 'body' ? 'disallowed' : { kind };
		default:
			return 'malformed';
	}
}

const PROBLEM_MESSAGES: Record<
	Exclude<SyncChoiceProblem['reason'], 'invalid' | 'disallowed'>,
	string
> = {
	malformed:
		'This is not a choice: take a side, replace with a value, or remove',
	unknown: 'No conflict of this attempt has this ID',
	missing: 'This conflict has no choice',
};

const problem = (
	reason: Exclude<SyncChoiceProblem['reason'], 'invalid' | 'disallowed'>,
	conflictId?: string,
): SyncChoiceProblem =>
	conflictId === undefined
		? { reason, message: PROBLEM_MESSAGES[reason] }
		: { conflictId, reason, message: PROBLEM_MESSAGES[reason] };

/** Why a choice is not allowed for its conflict. */
const disallowed = (conflict: SyncConflict): SyncChoiceProblem => ({
	conflictId: conflict.id,
	reason: 'disallowed',
	message:
		conflict.kind === 'body'
			? 'A body cannot be removed; replace it with empty text'
			: 'A file that is not text cannot be replaced; take a side or remove it',
});

/**
 * Every held path's content under `choices`, or every problem at once:
 * shape problems in conflict order, then unknown keys, then values the
 * folder refuses. Each entry is read once; nothing read is kept.
 */
function settle(
	paths: ReadonlyMap<string, Held>,
	conflicts: readonly SyncConflict[],
	choices: unknown,
): Result<ReadonlyMap<string, FileContent | null>, SyncError> {
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
		if (pick === 'disallowed') problems.push(disallowed(conflict));
		else if (typeof pick === 'string')
			problems.push(problem(pick, conflict.id));
		else picks.set(conflict.id, pick);
	}
	const known = new Set(conflicts.map(({ id }) => id));
	for (const key of Object.getOwnPropertyNames(submitted))
		if (!known.has(key)) problems.push(problem('unknown', key));
	if (problems.length > 0) return SyncError.InvalidChoices({ problems });
	const contents = new Map<string, FileContent | null>();
	for (const [path, entry] of paths) {
		const { data, error } = entry.settle(picks);
		if (error === null) contents.set(path, data);
		else problems.push(...error);
	}
	if (problems.length > 0) return SyncError.InvalidChoices({ problems });
	return Ok(contents);
}
