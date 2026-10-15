/**
 * The Folders window's row edits (ADR-0548): one draft per row, saved one
 * at a time, and what a person is told about each save.
 *
 * A row's draft (`createDraft`) captures the row and its version at the
 * first change: the first keystroke in a box, or the click of a checkbox,
 * menu, or toggle. A refetch updates the cache, never the draft, so a save
 * sends the version the edit started from and `table.save` merges with
 * whatever another writer changed since. "Changed elsewhere" is derived:
 * the cache's version differs from the draft's base.
 *
 * Every commit saves at once; the grid holds no edit past it. When a save
 * replaced another writer's values, because both changed the same field or
 * the same body lines, a notice names each one until it is dismissed.
 * "Restore theirs" is one more save of `restoreTheirs(saved)`, over the
 * version that save wrote, putting their values back (ADR-0551).
 *
 * The page supplies the cache's row and the table's save mutation, so this
 * module holds no query client and runs under `bun test` with a folder
 * opened by `@epicenter/folder/bun`.
 */

import {
	type AnyRow,
	restoreTheirs,
	type SavedRow,
	type StoredRow,
	type TableSaveError,
} from '@epicenter/folder';
import {
	createDraft,
	type Draft,
	type SaveRowVariables,
} from '@epicenter/folder/query';

type Fields = Record<string, unknown>;

/** A row as one read captured it. */
export type StoredAnyRow = StoredRow<Fields>;
export type SavedAnyRow = SavedRow<Fields>;

/** A save that replaced another writer's values, shown until dismissed. */
export type ReplacedNotice = {
	readonly id: number;
	readonly table: string;
	readonly stem: string;
	/** What the save wrote, and what of theirs it replaced. */
	readonly saved: SavedAnyRow;
};

export type RowEdits = ReturnType<typeof createRowEdits>;

/**
 * The edits of one opened folder. `save` runs the table's save mutation: it
 * resolves with what was written, or rejects with why not. Each call that
 * takes `current` is given the row as the cache holds it now.
 */
export function createRowEdits(
	save: (
		table: string,
		variables: SaveRowVariables<Fields>,
	) => Promise<SavedAnyRow>,
) {
	const drafts = new Map<string, Draft<Fields>>();
	/** Bumped whenever a draft changes, so what reads one reruns. */
	let drafted = $state(0);
	let notices = $state.raw<readonly ReplacedNotice[]>([]);
	let noticeSeq = 0;
	/** The latest save that failed; stays until dismissed or replaced. */
	let problem = $state<string | undefined>(undefined);
	/** Bumped when a save fails, so every editor shows the stored values again. */
	let resets = $state(0);

	/** Saves run one at a time, in the order they were made. */
	let queue: Promise<void> = Promise.resolve();
	/** How many queued saves each row has. */
	const pending = new Map<string, number>();
	/** Rows whose edit was put back while a save of theirs ran. */
	const dropWhenIdle = new Set<string>();

	const keyOf = (table: string, stem: string) => JSON.stringify([table, stem]);

	function draftOf(key: string) {
		let draft = drafts.get(key);
		if (draft === undefined) {
			draft = createDraft<Fields>();
			drafts.set(key, draft);
		}
		return draft;
	}

	function drop(key: string) {
		drafts.get(key)?.discard();
		drafts.delete(key);
		dropWhenIdle.delete(key);
		drafted++;
	}

	function enqueue(table: string, stem: string, task: () => Promise<void>) {
		const key = keyOf(table, stem);
		pending.set(key, (pending.get(key) ?? 0) + 1);
		queue = queue
			.then(task)
			.catch((error: unknown) => {
				// One save that fails must not stop every later one.
				problem = failureText(error);
				resets++;
				drop(key);
			})
			.finally(() => {
				const left = (pending.get(key) ?? 1) - 1;
				if (left > 0) pending.set(key, left);
				else {
					pending.delete(key);
					if (dropWhenIdle.has(key)) drop(key);
				}
				drafted++;
			});
	}

	function report(table: string, stem: string, saved: SavedAnyRow) {
		if (saved.replaced.length === 0) return;
		notices = [...notices, { id: ++noticeSeq, table, stem, saved }];
	}

	/** Save the row's draft as it is when its turn comes, if it has one. */
	async function saveDraft(table: string, stem: string) {
		const key = keyOf(table, stem);
		const draft = drafts.get(key);
		const sent = draft?.toSave();
		if (draft === undefined || sent === undefined) return;
		const saved = await save(table, { base: sent.base, row: sent.row });
		draft.saved(sent, saved);
		if (draft.base === undefined) drafts.delete(key);
		report(table, stem, saved);
	}

	return {
		/**
		 * Editing began: the first keystroke in a box. The row's draft
		 * captures the row as the cache holds it now, unless it holds an edit
		 * already; either way it counts as a change, so a save of the row
		 * running now leaves the draft open for this edit.
		 */
		begin(table: string, stem: string, current: StoredAnyRow) {
			const key = keyOf(table, stem);
			draftOf(key).change(current, () => {});
			dropWhenIdle.delete(key);
			drafted++;
		},
		/** Apply `edit` to the row's draft and save it. */
		commit(
			table: string,
			stem: string,
			current: StoredAnyRow,
			edit: (row: AnyRow) => void,
		) {
			const key = keyOf(table, stem);
			draftOf(key).change(current, edit);
			dropWhenIdle.delete(key);
			drafted++;
			enqueue(table, stem, () => saveDraft(table, stem));
		},
		/** The person put back what a box showed: drop the row's draft once nothing of it is saving. */
		revert(table: string, stem: string) {
			const key = keyOf(table, stem);
			if (pending.has(key)) dropWhenIdle.add(key);
			else drop(key);
		},
		/** Whether the row changed elsewhere since its draft's edit started. */
		changedElsewhere(
			table: string,
			stem: string,
			current: StoredAnyRow | undefined,
		): boolean {
			// Read so a caller in a reactive context reruns when a draft changes.
			void drafted;
			const draft = drafts.get(keyOf(table, stem));
			return draft?.changedElsewhere(current) ?? false;
		},
		get notices() {
			return notices;
		},
		/** Save their values back over the version `notice`'s save wrote. */
		restore(notice: ReplacedNotice) {
			notices = notices.filter((shown) => shown !== notice);
			const { table, stem, saved } = notice;
			enqueue(table, stem, async () => {
				const restored = await save(table, restoreTheirs(saved));
				report(table, stem, restored);
			});
		},
		dismiss(notice: ReplacedNotice) {
			notices = notices.filter((shown) => shown !== notice);
		},
		get problem() {
			return problem;
		},
		dismissProblem() {
			problem = undefined;
		},
		get resets() {
			return resets;
		},
		/** Settles once every save queued so far has. */
		settled(): Promise<void> {
			return queue;
		},
	};
}

/**
 * Why a save wrote nothing, for a person. A save mutation rejects with the
 * table's error; anything else that threw is said as its message.
 */
export function failureText(error: unknown): string {
	if (!isSaveError(error))
		return `Not saved: ${error instanceof Error ? error.message : String(error)}`;
	switch (error.name) {
		case 'InvalidValues':
			return `Not saved: ${error.issues.map((issue) => issue.message).join('; ')}`;
		case 'NotFound':
			return 'Another window deleted this row, so your edit was not saved.';
		case 'InvalidRow':
			return 'Another window saved this row in a form that does not read as a row, so your edit was not saved.';
		case 'KeptChanging':
			return 'This row kept changing in another window, so your edit was not saved.';
		default:
			return `Not saved: ${error.message}`;
	}
}

function isSaveError(error: unknown): error is TableSaveError {
	return (
		typeof error === 'object' &&
		error !== null &&
		typeof (error as { name?: unknown }).name === 'string' &&
		typeof (error as { message?: unknown }).message === 'string'
	);
}
