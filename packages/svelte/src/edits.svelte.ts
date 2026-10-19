/**
 * `@epicenter/svelte/edits`: what a person typed into the rows of a
 * local folder (`openFolder({ tables })`) and has not saved.
 *
 * - **Drafts.** One draft per row holds the fields and body typed since the
 *   row last saved, and the row it started from. A reread never replaces
 *   it: a view shows `shown(row)`, the row with the draft over it. It saves
 *   `SAVE_AFTER_MS` after the last change, and at once on `save()`.
 * - **A landed save.** The engine merges the draft with whatever was saved
 *   meanwhile (`table.set(id, from, change)`). The draft is held until the
 *   save committed and the cache was read again, then let go, unless typing
 *   changed it meanwhile: that typing stays, starting from the row this save
 *   sent. The saves of one row run one at a time.
 * - **A failed save** keeps the draft and its error. `save()` tries again;
 *   so does further typing, after its pause.
 * - **Delete** waits for the row's running save, then deletes the row as it
 *   is stored now. A row changed in that moment is kept (`deleted: false`).
 * - **Close** refuses new input from the moment it is called, sends every
 *   draft once, waits for every save and delete, and answers the drafts that
 *   still did not save. It closes nothing; the context closes the folder.
 *
 * `createFolderContext` builds one per opened folder.
 */
import type {
	Folder,
	Row as FolderRow,
	FolderTable,
	ReadError,
	SaveError,
} from '@epicenter/folder';
import type { QueryClient } from '@tanstack/query-core';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { Static, TSchema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { ActionError } from './write-failure.js';

/** How long after the last change a draft saves. */
export const SAVE_AFTER_MS = 1000;

/** Why nothing starts while the folder closes. */
export const CLOSING = 'The folder is closing, so nothing was changed.';

/** Why a row's edits and a second delete wait while it is deleted. */
export const DELETING = 'This row is being deleted.';

/** A delete cannot throw away typing that storage refused to save. */
export const UNSAVED = 'This row has unsaved changes. Save them before deleting it.';

/** A change typed into one row: fields to set, and the whole body. */
export type RowChange<TRowSchema extends TSchema = TSchema> = {
	readonly fields?: Partial<Static<TRowSchema>>;
	readonly body?: string;
};

/** One row's typing that has not saved. */
type Draft = {
	readonly table: string;
	readonly id: string;
	/** The row the typing started from, or the row its last save sent. */
	readonly base: FolderRow;
	readonly fields: Record<string, unknown>;
	readonly body: string | undefined;
	/** Changes with each keystroke, so a landed save knows whether typing followed it. */
	readonly revision: number;
	readonly saving: boolean;
	/** Why the last save failed, until one lands. */
	readonly error: SaveError | undefined;
};

/** A draft that did not save, as `settled` and `close` report it. */
export type Unsaved = {
	readonly table: string;
	readonly id: string;
	readonly fields: Record<string, unknown>;
	readonly body: string | undefined;
	readonly error: SaveError | undefined;
};

const keyOf = (table: string, id: string) => `${table}/${id}.md`;

function unsavedOf({ table, id, fields, body, error }: Draft): Unsaved {
	return { table, id, fields, body, error };
}

export function createEdits<TTables extends Record<string, TSchema>>({
	folder,
	queryClient,
	rowsKey,
	saveAfterMs = SAVE_AFTER_MS,
}: {
	folder: Folder<TTables>;
	/** The page's cache, which a landed save reads again before its draft goes. */
	queryClient: QueryClient;
	/** The query key of table `table`'s rows. */
	rowsKey: (table: string) => readonly unknown[];
	saveAfterMs?: number;
}) {
	// A draft keeps the row it started from without its table's schema type.
	const tableOf = (name: string): FolderTable =>
		folder.tables[name as keyof TTables];
	const drafts = new SvelteMap<string, Draft>();
	/** Rows being deleted. */
	const deleting = new SvelteSet<string>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The save loop of each row with one running. */
	const running = new Map<string, Promise<void>>();
	/** Rows asked to save again while a save of them ran. */
	const again = new Set<string>();
	const actions = new Set<Promise<unknown>>();
	let revisions = 0;
	let fenced = $state(false);
	let closing: Promise<Unsaved[]> | undefined;

	function clearTimer(key: string) {
		clearTimeout(timers.get(key));
		timers.delete(key);
	}

	function schedule(key: string) {
		clearTimer(key);
		timers.set(
			key,
			setTimeout(() => {
				timers.delete(key);
				void flush(key);
			}, saveAfterMs),
		);
	}

	/** Send the row's draft now; resolves once no save of it runs. */
	function flush(key: string, duringDelete = false): Promise<void> {
		clearTimer(key);
		const run = running.get(key);
		// A save started now could restore the row the delete removes; typing
		// a delete keeps saves once it ends.
		if (deleting.has(key) && !duringDelete) return run ?? Promise.resolve();
		if (run !== undefined) {
			again.add(key);
			return run;
		}
		const started = drain(key).finally(() => running.delete(key));
		running.set(key, started);
		return started;
	}

	function track<T>(work: Promise<T>): Promise<T> {
		actions.add(work);
		const done = () => actions.delete(work);
		work.then(done, done);
		return work;
	}

	async function drain(key: string) {
		do {
			again.delete(key);
			const draft = drafts.get(key);
			if (draft === undefined) return;
			const { table, id, base, fields, body, revision } = draft;
			drafts.set(key, { ...draft, saving: true });
			let saved: Result<{ sent: FolderRow }, SaveError>;
			try {
				saved = await tableOf(table).set(id, base, { fields, body });
			} catch (cause) {
				const current = drafts.get(key);
				if (current !== undefined)
					drafts.set(key, { ...current, saving: false });
				throw cause;
			}
			const settled = drafts.get(key);
			if (settled === undefined) return;
			if (saved.error !== null) {
				drafts.set(key, { ...settled, saving: false, error: saved.error });
				continue;
			}
			const { sent } = saved.data;
			await queryClient.invalidateQueries({ queryKey: rowsKey(table) });
			const after = drafts.get(key);
			if (after === undefined) return;
			if (after.revision === revision) drafts.delete(key);
			else
				drafts.set(key, {
					...after,
					base: sent,
					saving: false,
					error: undefined,
				});
		} while (again.has(key));
	}

	/** Every draft at `keys`, sent once; answers the ones that still did not save. */
	async function settle(keys: readonly string[]): Promise<Unsaved[]> {
		await Promise.allSettled(keys.map((key) => flush(key)));
		return keys.flatMap((key) => {
			const draft = drafts.get(key);
			return draft === undefined ? [] : [unsavedOf(draft)];
		});
	}

	return {
		/**
		 * The typing of row `id` of `table`. A view asks for it while it shows
		 * the row; asking again answers the same typing.
		 */
		row<TName extends keyof TTables & string>(table: TName, id: string) {
			type Row = FolderRow<TTables[TName]>;
			const key = keyOf(table, id);
			return {
				/** `row` with what is typed over it; a reread never replaces the typing. */
				shown<TRow extends Row>(row: TRow): TRow {
					const draft = drafts.get(key);
					if (draft === undefined) return row;
					return {
						...row,
						fields: { ...row.fields, ...draft.fields },
						body: draft.body ?? row.body,
					};
				},
				/**
				 * Type `change` into the row shown as `row`; it saves after a pause.
				 * The first change of a draft starts from `row`. Answers whether
				 * it was taken: nothing is while the folder closes or the row is
				 * deleted.
				 */
				change(row: Row, change: RowChange<TTables[TName]>): boolean {
					if (fenced || deleting.has(key)) return false;
					const draft = drafts.get(key);
					drafts.set(key, {
						table,
						id,
						base: draft?.base ?? row,
						fields: { ...draft?.fields, ...change.fields },
						body: change.body ?? draft?.body,
						revision: ++revisions,
						saving: draft?.saving ?? false,
						error: draft?.error,
					});
					schedule(key);
					return true;
				},
				/** Save what is typed now; resolves once no save of it runs. */
				save: () => flush(key),
				/** Whether typing is held that has not saved. */
				get held() {
					return drafts.has(key);
				},
				/** Whether a save of it runs. */
				get saving() {
					return drafts.get(key)?.saving ?? false;
				},
				/** Why its last save failed, while the typing is held. */
				get error() {
					return drafts.get(key)?.error;
				},
				/** The typed fields and body remain available even if a later read fails. */
				get pending() {
					const draft = drafts.get(key);
					return draft === undefined ? undefined : unsavedOf(draft);
				},
				/** Deliberately let go of unsaved typing; the caller can copy the returned change first. */
				discard(): Unsaved | undefined {
					if (fenced || deleting.has(key) || running.has(key)) return undefined;
					const draft = drafts.get(key);
					if (draft === undefined) return undefined;
					clearTimer(key);
					drafts.delete(key);
					return unsavedOf(draft);
				},
				/** Whether input is refused: the row is being deleted, or the folder closes. */
				get locked() {
					return fenced || deleting.has(key);
				},
			};
		},

		/**
		 * Delete row `id` as it is stored once its running save landed. Typing
		 * held for it is let go once the row is deleted. A row changed in that
		 * moment, here or elsewhere, is kept, and the result says so.
		 */
		delete(
			table: keyof TTables & string,
			id: string,
		): Promise<
			Result<{ deleted: boolean }, SaveError | ReadError | ActionError>
		> {
			const key = keyOf(table, id);
			if (fenced)
				return Promise.resolve(ActionError.NotStarted({ reason: CLOSING }));
			if (deleting.has(key))
				return Promise.resolve(ActionError.NotStarted({ reason: DELETING }));
			deleting.add(key);
			clearTimer(key);
			return track(
				(async () => {
					try {
						await running.get(key);
						if (drafts.has(key)) {
							await flush(key, true);
							if (drafts.has(key))
								return ActionError.NotStarted({ reason: UNSAVED });
						}
						const stored = await tableOf(table).get(id);
						if (stored.error !== null) return stored;
						// Already gone, here or elsewhere: nothing is left to type into.
						const removed =
							stored.data === undefined
								? Ok({ deleted: false })
								: await tableOf(table).delete(id, stored.data);
						if (
							stored.data === undefined ||
							(removed.error === null && removed.data.deleted)
						)
							drafts.delete(key);
						await queryClient.invalidateQueries({ queryKey: rowsKey(table) });
						return removed;
					} finally {
						deleting.delete(key);
						// Typing kept by a delete that did not happen saves as usual.
						if (drafts.has(key) && !fenced) schedule(key);
					}
				})(),
			);
		},

		/**
		 * Send every draft, or the drafts of `table`, once, and wait for their
		 * saves. Answers the drafts that still did not save.
		 */
		settled(table?: keyof TTables & string): Promise<Unsaved[]> {
			return settle(
				[...drafts.values()]
					.filter((draft) => table === undefined || draft.table === table)
					.map((draft) => keyOf(draft.table, draft.id)),
			);
		},

		/** Whether anything is unsaved or running: typing held, or a delete. */
		get busy() {
			return drafts.size > 0 || deleting.size > 0;
		},

		/** The drafts whose last save failed and that no save is retrying. */
		get failures(): Unsaved[] {
			return [...drafts.values()]
				.filter((draft) => draft.error !== undefined && !draft.saving)
				.map(unsavedOf);
		},

		/** Whether close was called: no input is taken from then on. */
		get fenced() {
			return fenced;
		},

		/**
		 * Refuse new input, then send every draft once and wait for every save
		 * and delete. Answers the drafts that did not save. Every call answers
		 * the same completion.
		 */
		close(): Promise<Unsaved[]> {
			closing ??= (async () => {
				fenced = true;
				await Promise.allSettled([...actions]);
				return settle([...drafts.keys()]);
			})();
			return closing;
		},
	};
}

export type Edits<TTables extends Record<string, TSchema>> = ReturnType<
	typeof createEdits<TTables>
>;
