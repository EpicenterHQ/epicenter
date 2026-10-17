/**
 * `@epicenter/svelte/edits`: the one edit layer under every folder app's
 * product state (ADR-0576).
 *
 * What a person types and has not saved lives here, once per opened folder,
 * so each app keeps only its product logic:
 *
 * - **Drafts.** A row's body (`body`), a file's exact text (`text`), and a
 *   typed field (`field`) are held by path until they are in the file. Each
 *   saves a second after the last change, and at once when the view calls
 *   `save()`, as it does when the person leaves the control or the view
 *   goes away. A draft outlives the view it was typed in, and a read never
 *   replaces it.
 * - **Failure.** A save that fails keeps what is typed on screen, and the
 *   person is told, with the text to copy, "Save again", and a way to
 *   discard the edit (`writeFailed`).
 * - **Unsaved typing blocks what would move past it.** Text typed at a path
 *   whose save failed holds that path: a rename or delete of it, Save
 *   version, and typing it in another way (its exact text against its body
 *   or fields) are refused until it saves or the person discards it. Sync
 *   goes ahead, since it does not claim the edit saved; closing goes ahead
 *   once the failure was reported.
 * - **A delete beats an edit that never saw it.** A draft whose file was
 *   deleted, as a save found or a listing without its row says, is let go
 *   and its text offered once. A field set on a deleted row offers what was
 *   typed; a click offers nothing, since nothing was typed.
 * - **Order.** Every write goes through `writes` (`folderWrites`), so writes
 *   to one file run one at a time, in the order made, whoever made them.
 * - **Locks.** `exclusive(paths, work)` runs a rename or a delete once every
 *   draft and write of its paths landed, refuses edits of them meanwhile,
 *   and lets go of what is held at them once it succeeded.
 * - **Settle, then commit.** `settled()` sends every draft once and waits
 *   for every write, again until nothing is left, and answers the paths
 *   whose typing still did not save; `saveVersion` and `sync` start after
 *   it.
 * - **The close fence.** `close()` refuses new input from the moment it is
 *   called, then waits for every draft, write, lock, and app action.
 *
 * ```ts
 * const { edits } = getFolder<typeof todosDefinition>();
 * const title = edits.field('todos', stem, 'title');
 * const notes = edits.body('todos', stem);
 * edits.set('todos', stem, { done: true });
 * ```
 *
 * ```svelte
 * <Input bind:value={() => title.shown(row.fields.title), (typed) => title.change(typed)} onblur={() => title.save()} />
 * <Textarea bind:value={() => notes.text ?? '', (typed) => notes.change(typed)} onblur={() => notes.save()} />
 * ```
 *
 * `<FolderApp>` builds one with the folder's context (`getFolder().edits`);
 * an app that opens its folder itself builds one with `createEdits`.
 */
import {
	type CommitOutcome,
	type Definition,
	FileError,
	type Folder,
	type Row,
	rowPath,
	type SyncError,
	type SyncOptions,
	type SyncOutcome,
	type TableListing,
} from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import {
	type FolderOptionsOf,
	type FolderWritesOf,
	folderWrites,
	type TableWrites,
} from '@epicenter/folder/query';
import {
	createBodyEditor,
	createTextEditor,
	type TextEditor,
} from '@epicenter/folder/svelte';
import type { QueryClient } from '@tanstack/query-core';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import { type Err, Ok, type Result } from 'wellcrafted/result';
import {
	ActionError,
	type DescribedError,
	type WriteFailure,
} from './write-failure.js';

/** How long after the last change a draft saves. */
export const SAVE_AFTER_MS = 1000;

/** Why no edit or action starts while the folder closes. */
export const CLOSING = 'The folder is closing, so nothing was changed.';

/** Why an edit of a file waits while it is renamed or deleted. */
export const BUSY =
	'This file is being renamed or deleted. Try again when it finishes.';

/** Why a rename, a delete, or a switch of how a file is edited waits on typing that did not save. */
export const UNSAVED =
	'An edit of this file did not save. Save it again, or copy your text and discard the edit, then try again.';

/** Why Save version recorded nothing while typing at `paths` did not save. */
const notVersioned = (paths: readonly string[]) =>
	`Your edits of ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ' and others' : ''} did not save, so no version was recorded. Save them again, or copy your text and discard the edits, then try again.`;

/** Why typing held at a path could not be sent at all. */
const STRANDED =
	'The file no longer reads as it did when this was typed, so the edit could not be sent. Copy your text and discard the edit, or repair the file elsewhere.';

/** Why text still held at a path was let go once the app renamed or deleted the file. */
const MOVED =
	'The file was renamed or deleted before this edit saved, so it is in no file.';

/** A row's fields, by table name. */
type FieldsOf<TTables, K extends keyof TTables> = TTables[K] extends {
	write(stem: string, from: Row<infer TFields> | null, to: never): unknown;
}
	? TFields
	: never;

/** A row's body, or a file's exact text, typed and not yet in the file. */
export type Draft = {
	/** What the control shows: the text typed, or the file's; `undefined` with no file to edit. */
	readonly text: string | undefined;
	/** The text typed and not yet in the file; `undefined` when nothing is. */
	readonly typed: string | undefined;
	/** Whether a save of it runs, or typing waits to be sent. */
	readonly saving: boolean;
	/** Whether it holds text whose save failed, with no save running or waiting. */
	readonly failed: boolean;
	/** Why its last save failed, while it holds the text. */
	readonly error: DescribedError | undefined;
	/**
	 * Type `text`; it saves a second after the last change. Answers whether
	 * it was taken: no change is taken while the folder closes, while the
	 * file is renamed or deleted, or with no file to edit.
	 */
	change(text: string): boolean;
	/** Save what is typed now; resolves once no save of it runs. */
	save(): Promise<void>;
};

/** One field of one row, typed and not yet in the file. */
export type FieldDraft<TValue> = {
	/** What the control shows: the value typed, or `stored`. */
	shown(stored: TValue): TValue;
	/** The value typed and not yet in the file; `undefined` when nothing is. */
	readonly typed: TValue | undefined;
	/** Whether a save of it runs, or typing waits to be sent. */
	readonly saving: boolean;
	/** Why its last save failed, while it holds the value. */
	readonly error: DescribedError | undefined;
	/** Type `value`; answers whether it was taken, as a draft's `change` does. */
	change(value: TValue): boolean;
	/** Save what is typed now; resolves once that save settled. */
	save(): Promise<void>;
};

/** What `createEdits` builds over: the opened folder and its cache. */
export type EditsSource<TTables> = {
	readonly folder: Pick<
		Folder<Definition>,
		'location' | 'write' | 'move' | 'git' | 'sync'
	> & { readonly tables: TTables };
	readonly queries: FolderOptionsOf<TTables>;
	readonly queryClient: QueryClient;
	/** Tell the person a save failed, offering what it held. */
	readonly writeFailed: (failure: WriteFailure) => void;
};

export type Edits<TTables> = ReturnType<typeof createEdits<TTables>>;

/** A save that runs after a pause, `SAVE_AFTER_MS` after the last `schedule`. */
function later(save: () => unknown) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let waiting = $state(false);
	return {
		/** Whether a save is scheduled and has not run. */
		get waiting() {
			return waiting;
		},
		schedule() {
			clearTimeout(timer);
			waiting = true;
			timer = setTimeout(() => {
				waiting = false;
				timer = undefined;
				void save();
			}, SAVE_AFTER_MS);
		},
		cancel() {
			clearTimeout(timer);
			timer = undefined;
			waiting = false;
		},
	};
}

/** A body or a file's text held by its path. */
class Held {
	/** Why the last save failed. */
	error = $state.raw<DescribedError | undefined>();
	/** A save found the file deleted. */
	foundGone = false;
	/** Counts each change, so a settle tries each typed text once. */
	revision = 0;
	editor!: TextEditor;
	readonly later: ReturnType<typeof later>;
	readonly #unlisted: () => boolean;
	readonly #absent: () => boolean;
	constructor(
		save: () => unknown,
		unlisted: () => boolean,
		absent: () => boolean,
	) {
		this.later = later(save);
		this.#unlisted = unlisted;
		this.#absent = absent;
	}
	/** Whether its file is gone: a save found it deleted, or the listing lacks its row. */
	gone() {
		return this.foundGone || this.#unlisted();
	}
	/**
	 * Whether what is typed cannot even be sent: its file is still there,
	 * but the cache holds no document to send it against, as when a row
	 * stopped reading as one, or a file's text is no longer read.
	 */
	stranded() {
		return (
			this.editor.typed !== undefined &&
			!this.editor.saving &&
			!this.gone() &&
			this.#absent()
		);
	}
}

/** A field held by its row and name. */
class HeldField {
	typed = $state.raw<unknown>();
	/**
	 * Counts each change. A save names the revision it sent, so one that
	 * lands clears only the typing it sent, never a value typed after it,
	 * even one equal to it (A, then B, then A again).
	 */
	revision = 0;
	/** How many of its saves run or wait. */
	saving = $state(0);
	error = $state.raw<DescribedError | undefined>();
	/** The save of the last revision sent, while it runs. */
	sending:
		| { readonly revision: number; readonly done: Promise<void> }
		| undefined;
	readonly table: string;
	readonly stem: string;
	readonly name: string;
	readonly path: string;
	readonly later: ReturnType<typeof later>;
	constructor(table: string, stem: string, name: string, save: () => unknown) {
		this.table = table;
		this.stem = stem;
		this.name = name;
		this.path = rowPath(table, stem);
		this.later = later(save);
	}
}

/** Whether a save of `held` runs, or one waits to send what is typed. */
const pendingSave = (held: Held) =>
	held.editor.saving || (held.later.waiting && held.editor.typed !== undefined);

/** Whether a save of `held` runs, or one waits to send what is typed. */
const pendingField = (held: HeldField) =>
	held.saving > 0 || (held.later.waiting && held.typed !== undefined);

/** Text a person typed into a field, offered when its save fails. */
const typedText = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Run `work` a microtask from now. A view sends what is typed as it goes
 * away, and while Svelte tears a view down, a read answers what state held
 * before the change that tore it down; the typing that came with that
 * change would be missed.
 */
const afterTeardown = <T>(work: () => T | Promise<T>): Promise<T> =>
	Promise.resolve().then(work);

/**
 * Resolves once nothing is mutating in `client`, watching the mutation
 * cache, so a mutation that starts meanwhile is waited for too.
 */
function whenIdle(client: QueryClient): Promise<void> {
	return new Promise((resolve) => {
		const idle = () => client.isMutating() === 0;
		const unsubscribe = client.getMutationCache().subscribe(check);
		function check() {
			if (!idle()) return;
			setTimeout(() => {
				if (!idle()) return;
				unsubscribe();
				resolve();
			});
		}
		check();
	});
}

export function createEdits<TTables>({
	folder,
	queries,
	queryClient,
	writeFailed,
}: EditsSource<TTables>) {
	type Name = keyof TTables & string;
	type Fields = Record<string, unknown>;
	const writes: FolderWritesOf<TTables> = folderWrites(folder, queryClient);
	const tableWrites = (table: string) =>
		(writes.tables as unknown as Record<string, TableWrites<Fields>>)[
			table
		] as TableWrites<Fields>;
	const listKey = (table: string) =>
		(
			queries.tables as unknown as Record<
				string,
				{ list: { queryKey(): readonly unknown[] } }
			>
		)[table]?.list.queryKey() ?? [];

	const trackWrites = createSubscriber((update) => writes.subscribe(update));
	const trackQueries = createSubscriber((update) =>
		queryClient.getQueryCache().subscribe(update),
	);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);

	let fenced = $state(false);
	/** Row bodies typed, by path. */
	const bodies = new SvelteMap<string, Held>();
	/** Files' exact text typed, by path. */
	const texts = new SvelteMap<string, Held>();
	/** Fields typed, by path and name. */
	const fields = new SvelteMap<string, HeldField>();
	/** How many renames and deletes of each path run or wait. */
	const locks = new SvelteMap<string, number>();
	/** The renames and deletes running now. */
	const exclusives = new Set<Promise<unknown>>();

	const locked = (path: string) => fenced || (locks.get(path) ?? 0) > 0;
	const refusal = (path?: string) => {
		if (fenced) return CLOSING;
		if (path !== undefined && (locks.get(path) ?? 0) > 0) return BUSY;
		return undefined;
	};

	/** Whether the row at `path` holds typing: its body or a field. */
	const rowTypedAt = (path: string) =>
		bodies.get(path)?.editor.typed !== undefined ||
		[...fields.values()].some(
			(held) => held.path === path && held.typed !== undefined,
		);
	/** Whether the file at `path` holds typing as its exact text. */
	const textTypedAt = (path: string) =>
		texts.get(path)?.editor.typed !== undefined;

	/** The listing of `table`, read reactively. */
	function listing(table: string) {
		trackQueries();
		return queryClient.getQueryData<TableListing<Fields>>(listKey(table));
	}

	/** The text of `path` as the cache holds it, when it opens as text, read reactively. */
	function shownText(path: string) {
		trackQueries();
		const opened = queryClient.getQueryData<OpenedFile>(
			queries.files.text.queryKey(path),
		);
		return opened?.kind === 'text' ? opened.text : undefined;
	}

	/** Let go of the draft `map` holds at `path`, if it is `held`; answers what it held typed. */
	function letGo(map: SvelteMap<string, Held>, path: string, held: Held) {
		if (map.get(path) !== held) return undefined;
		const unsaved = held.editor.typed;
		held.later.cancel();
		held.editor.discard();
		map.delete(path);
		return unsaved;
	}

	/** Let go of the field held at `key`, if it is `held`; answers the text it held typed. */
	function letGoField(key: string, held: HeldField) {
		if (fields.get(key) !== held) return undefined;
		const unsaved =
			held.typed === undefined ? undefined : typedText(held.typed);
		held.later.cancel();
		held.typed = undefined;
		fields.delete(key);
		return unsaved;
	}

	/**
	 * After a save of `held` ended, or a listing landed: a draft with nothing
	 * typed is let go, and one whose file is gone is let go with its text
	 * offered once. One whose save runs is left to it.
	 */
	function review(map: SvelteMap<string, Held>, path: string, held: Held) {
		if (map.get(path) !== held || held.editor.saving) return;
		if (held.editor.typed !== undefined && !held.gone()) return;
		const unsaved = letGo(map, path, held);
		if (unsaved !== undefined)
			writeFailed({ path, error: FileError.NotFound({ path }).error, unsaved });
	}

	async function saveHeld(map: SvelteMap<string, Held>, path: string) {
		const held = map.get(path);
		if (held === undefined) return;
		held.later.cancel();
		await held.editor.save();
		review(map, path, held);
	}

	/**
	 * Hold a draft at `path` in `map` over the editor `open` makes, whose
	 * `write` sends one save: it answers whether the file is gone, or the
	 * write's error.
	 */
	function hold(
		map: SvelteMap<string, Held>,
		path: string,
		unlisted: () => boolean,
		absent: () => boolean,
		open: (
			write: <T>(
				sent: string,
				send: () => Promise<Result<T, DescribedError>>,
				isGone: (data: T) => boolean,
			) => Promise<T>,
		) => TextEditor,
	): Held {
		const held = new Held(() => saveHeld(map, path), unlisted, absent);
		held.editor = open(async (sent, send, isGone) => {
			const result = await send().catch(
				(cause: unknown): { data: null; error: DescribedError } => ({
					data: null,
					error: FileError.Io({ path, operation: 'save', cause }).error,
				}),
			);
			if (result.error !== null) {
				// Discarded while it ran: nothing is left to tell.
				if (map.get(path) !== held) throw result.error;
				held.error = result.error;
				writeFailed({
					path,
					error: result.error,
					unsaved: held.editor.typed ?? sent,
					// Only while the draft is still held and the folder is not
					// closing; otherwise the toast keeps the text to copy.
					retry: () => {
						if (fenced || map.get(path) !== held) return false;
						if (held.editor.typed === undefined) return false;
						void saveHeld(map, path);
						return true;
					},
					discard: () => letGo(map, path, held),
				});
				throw result.error;
			}
			held.error = undefined;
			if (isGone(result.data)) held.foundGone = true;
			return result.data;
		});
		map.set(path, held);
		return held;
	}

	/**
	 * The draft a view types through: the one `map` holds at `path`, made at
	 * its first change. `otherTyped` says whether the path holds typing in
	 * its other way of being edited, which refuses this one: a path has one
	 * editing authority at a time.
	 */
	function draftAt(
		map: SvelteMap<string, Held>,
		path: string,
		shown: () => string | undefined,
		otherTyped: () => boolean,
		open: () => Held,
	): Draft {
		return {
			get text() {
				const held = map.get(path);
				return held === undefined ? shown() : held.editor.text;
			},
			get typed() {
				return map.get(path)?.editor.typed;
			},
			get saving() {
				const held = map.get(path);
				return held !== undefined && pendingSave(held);
			},
			get failed() {
				const held = map.get(path);
				return (
					held !== undefined &&
					held.editor.typed !== undefined &&
					!pendingSave(held)
				);
			},
			get error() {
				const held = map.get(path);
				return held?.editor.typed === undefined ? undefined : held.error;
			},
			change(text) {
				if (locked(path) || otherTyped()) return false;
				let held = map.get(path);
				if (held === undefined) {
					if (shown() === undefined) return false;
					held = open();
				}
				held.editor.change(text);
				held.revision += 1;
				if (held.editor.typed === undefined) {
					review(map, path, held);
					return false;
				}
				held.later.schedule();
				return true;
			},
			save: () => afterTeardown(() => saveHeld(map, path)),
		};
	}

	/** One row's body, held by its path until it is in the file. */
	function body<K extends Name>(table: K, stem: string): Draft {
		const path = rowPath(table, stem);
		const stored = () => {
			const result = listing(table)?.find(
				(entry) => entry.stem === stem,
			)?.result;
			return result?.error === null ? result.data : undefined;
		};
		// Gone as a listing without the row says. A row listed that does not
		// read is still there: its body waits for it to read again.
		const unlisted = () => {
			const listed = listing(table);
			return (
				listed !== undefined && !listed.some((entry) => entry.stem === stem)
			);
		};
		return draftAt(
			bodies,
			path,
			() => stored()?.row.body,
			() => textTypedAt(path),
			() =>
				hold(
					bodies,
					path,
					unlisted,
					() => stored() === undefined,
					(write) =>
						createBodyEditor<Fields>({
							row: stored,
							write: (change) =>
								write(
									change.to.body,
									() => tableWrites(table).write(stem, change.from, change.to),
									(written) => written === null,
								),
						}),
				),
		);
	}

	/** One file's exact text, held by its path until it is in the file. */
	function text(path: string): Draft {
		// Gone as its own read says: the file was read again and is not there.
		const unlisted = () => {
			const state = queryClient.getQueryState(
				queries.files.text.queryKey(path),
			);
			return (
				state?.status === 'error' &&
				(state.error as { name?: string } | null)?.name === 'NotFound'
			);
		};
		return draftAt(
			texts,
			path,
			() => shownText(path),
			() => rowTypedAt(path),
			() =>
				hold(
					texts,
					path,
					unlisted,
					() => shownText(path) === undefined,
					(write) =>
						createTextEditor({
							current: () => shownText(path),
							write: async (change) => {
								const written = await write(
									change.to,
									() => writes.write(path, change.from, change.to),
									({ file }) => file === null,
								);
								return written.file === null ? 'gone' : 'landed';
							},
						}),
				),
		);
	}

	/**
	 * Save the field held at `key`: what is typed now, set on the row as it
	 * is. While a save of the same revision runs, it answers that save.
	 */
	function saveField(key: string): Promise<void> {
		const held = fields.get(key);
		if (held === undefined) return Promise.resolve();
		held.later.cancel();
		if (held.typed === undefined) return Promise.resolve();
		if (held.sending !== undefined && held.sending.revision === held.revision)
			return held.sending.done;
		const revision = held.revision;
		const done = sendField(key, held, held.typed, revision);
		held.sending = { revision, done };
		void done.then(() => {
			if (held.sending?.done === done) held.sending = undefined;
		});
		return done;
	}

	/** Set `sent`, typed as `revision`, as the field held at `key`, as the row is now. */
	async function sendField(
		key: string,
		held: HeldField,
		sent: unknown,
		revision: number,
	) {
		const { table, stem, name, path } = held;
		held.saving += 1;
		let written: Awaited<ReturnType<TableWrites<Fields>['set']>>;
		try {
			written = await tableWrites(table).set(stem, { [name]: sent });
		} catch (cause) {
			// The folder host went away: a failed save like any other.
			written = {
				data: null,
				error: FileError.Io({ path, operation: 'save', cause }).error,
			} as typeof written;
		} finally {
			held.saving -= 1;
		}
		const { data, error } = written;
		// Discarded while it ran: nothing is left to tell.
		if (fields.get(key) !== held) return;
		if (error !== null) {
			// Typing went on: the next save sends that.
			if (held.revision !== revision) return;
			held.error = error;
			writeFailed({
				path,
				error,
				unsaved: typedText(sent),
				retry: () => {
					if (fenced || fields.get(key) !== held || held.typed === undefined)
						return false;
					void saveField(key);
					return true;
				},
				discard: () => letGoField(key, held),
			});
			return;
		}
		if (held.revision === revision) {
			held.typed = undefined;
			held.error = undefined;
			// A delete beats an edit it never saw: what was typed is offered.
			if (data === null && typedText(sent) !== '')
				writeFailed({
					path,
					error: FileError.NotFound({ path }).error,
					unsaved: typedText(sent),
				});
		}
		if (held.typed === undefined && held.saving === 0) fields.delete(key);
	}

	/** Hold a field of the row at `stem` of `table`. */
	function holdField(table: string, stem: string, name: string): HeldField {
		const key = `${rowPath(table, stem)}\u0000${name}`;
		const held = new HeldField(table, stem, name, () => saveField(key));
		fields.set(key, held);
		return held;
	}

	/** One field of one row, held by its path and name until it is in the file. */
	function field<K extends Name, F extends keyof FieldsOf<TTables, K> & string>(
		table: K,
		stem: string,
		name: F,
	): FieldDraft<FieldsOf<TTables, K>[F]> {
		type Value = FieldsOf<TTables, K>[F];
		const path = rowPath(table, stem);
		const key = `${path}\u0000${name}`;
		return {
			shown(stored) {
				const typed = fields.get(key)?.typed;
				return typed === undefined ? stored : (typed as Value);
			},
			get typed() {
				return fields.get(key)?.typed as Value | undefined;
			},
			get saving() {
				const held = fields.get(key);
				return held !== undefined && pendingField(held);
			},
			get error() {
				const held = fields.get(key);
				return held?.typed === undefined ? undefined : held.error;
			},
			change(value) {
				if (locked(path) || textTypedAt(path)) return false;
				const held = fields.get(key) ?? holdField(table, stem, name);
				held.typed = value;
				held.revision += 1;
				held.later.schedule();
				return true;
			},
			save: () => afterTeardown(() => saveField(key)),
		};
	}

	/** Every draft and field held at `path`, or everywhere. */
	function heldAt(path?: string) {
		const at = <T>(
			map: SvelteMap<string, T>,
			pathOf: (key: string, held: T) => string,
		) =>
			[...map].filter(
				([key, held]) => path === undefined || pathOf(key, held) === path,
			);
		return {
			bodies: at(bodies, (key) => key),
			texts: at(texts, (key) => key),
			fields: at(fields, (_, held) => held.path),
		};
	}

	/** Whether a draft or field held at `path`, or anywhere, is saving or waits to. */
	function draftsSaving(path?: string) {
		const held = heldAt(path);
		return (
			[...held.bodies, ...held.texts].some(([, held]) => pendingSave(held)) ||
			held.fields.some(([, held]) => pendingField(held))
		);
	}

	/** The paths holding text typed and not in its file, at `path` or everywhere. */
	function typedPaths(path?: string): string[] {
		const held = heldAt(path);
		return [
			...new Set([
				...[...held.bodies, ...held.texts]
					.filter(([, held]) => held.editor.typed !== undefined)
					.map(([key]) => key),
				...held.fields
					.filter(([, held]) => held.typed !== undefined)
					.map(([, held]) => held.path),
			]),
		];
	}

	/**
	 * Send what is held at `path`, or everywhere, that this settle has not
	 * tried at its revision yet, and wait for any save of the rest that
	 * runs. `tried` records each draft's revision once it was sent, so a
	 * save that fails is tried once per settle, not again on every pass.
	 */
	function sendHeld(path: string | undefined, tried: Map<object, number>) {
		const held = heldAt(path);
		const once = (draft: Held | HeldField, send: () => Promise<void>) => {
			if (tried.get(draft) === draft.revision) {
				if (draft instanceof HeldField) return draft.sending?.done;
				return draft.editor.saving ? draft.editor.save() : undefined;
			}
			tried.set(draft, draft.revision);
			return send();
		};
		/**
		 * Send the draft `map` holds at `key`. Typing its editor could not
		 * even send is told once per settle, with the text and Discard, so
		 * what it blocks always has a way out.
		 */
		const sendDraft = async (map: SvelteMap<string, Held>, key: string) => {
			const draft = map.get(key);
			await saveHeld(map, key);
			if (draft === undefined || map.get(key) !== draft || !draft.stranded())
				return;
			writeFailed({
				path: key,
				error: ActionError.NotStarted({ reason: STRANDED }).error,
				unsaved: draft.editor.typed ?? '',
				discard: () => letGo(map, key, draft),
			});
		};
		return Promise.all([
			...held.bodies.map(([key, draft]) =>
				once(draft, () => sendDraft(bodies, key)),
			),
			...held.texts.map(([key, draft]) =>
				once(draft, () => sendDraft(texts, key)),
			),
			...held.fields.map(([key, draft]) => once(draft, () => saveField(key))),
		]);
	}

	/**
	 * Resolves once what is typed at `path`, or everywhere, is sent, and
	 * every write to it running now and every one that leads to landed or
	 * failed, again until nothing is left. Each draft is tried once per
	 * settle, and again only when typing changed it meanwhile. Answers the
	 * paths whose typing still is not in its file: their saves failed, and
	 * the person was told, with Save again.
	 */
	async function settled(path?: string): Promise<readonly string[]> {
		await afterTeardown(() => {});
		const tried = new Map<object, number>();
		for (;;) {
			await sendHeld(path, tried);
			await writes.idle(path);
			if (!draftsSaving(path) && writes.pending(path) === 0) break;
		}
		return typedPaths(path);
	}

	/**
	 * Let go of every draft and field still held at `path` once the app
	 * renamed or deleted its file, so no draft and no Save again stays aimed
	 * at an address that now names nothing, or another file. Text still
	 * typed there is offered once; the refusal in `exclusive` leaves none.
	 */
	function release(path: string) {
		const offer = (unsaved: unknown) => {
			if (unsaved === undefined || typedText(unsaved) === '') return;
			writeFailed({
				path,
				error: ActionError.NotStarted({ reason: MOVED }).error,
				unsaved: typedText(unsaved),
			});
		};
		for (const map of [bodies, texts]) {
			const held = map.get(path);
			if (held !== undefined) offer(letGo(map, path, held));
		}
		for (const [key, held] of [...fields])
			if (held.path === path) offer(letGoField(key, held));
	}

	/**
	 * Run `work`, a rename or a delete of `paths` (a rename names its source
	 * and its destination), once every draft and write of each landed.
	 * Edits of them are refused from the call until it settles, and closing
	 * waits for it. Typing at them whose save failed refuses the work, with
	 * `UNSAVED`, rather than move or delete past it. Once `work` succeeded,
	 * every draft and field still held at them is let go.
	 */
	function exclusive<R extends Result<unknown, unknown>>(
		paths: string | readonly string[],
		work: () => Promise<R>,
	): Promise<R | Err<ActionError>> {
		const all = typeof paths === 'string' ? [paths] : [...new Set(paths)];
		for (const path of all) locks.set(path, (locks.get(path) ?? 0) + 1);
		const running = (async (): Promise<R | Err<ActionError>> => {
			try {
				const unsaved = (
					await Promise.all(all.map((path) => settled(path)))
				).flat();
				if (unsaved.length > 0)
					return ActionError.NotStarted({ reason: UNSAVED });
				const result = await work();
				if (result.error === null) for (const path of all) release(path);
				return result;
			} finally {
				for (const path of all) {
					const left = (locks.get(path) ?? 1) - 1;
					if (left === 0) locks.delete(path);
					else locks.set(path, left);
				}
			}
		})();
		exclusives.add(running);
		const done = () => exclusives.delete(running);
		void running.then(done, done);
		return running;
	}

	// Text typed into a file deleted elsewhere is let go, and offered, as
	// soon as a read without it lands, whether or not a save is due: a
	// listing without a row lets its body go, and a read of a file's text
	// that finds no file lets that text go.
	const stopWatching = queryClient.getQueryCache().subscribe((event) => {
		if (event.type !== 'updated') return;
		if (event.action.type !== 'success' && event.action.type !== 'error')
			return;
		for (const [path, held] of [...bodies]) review(bodies, path, held);
		for (const [path, held] of [...texts]) review(texts, path, held);
	});

	/** Whether nothing is held saving, no write waits, no lock runs, and no action runs. */
	const quiet = () =>
		!draftsSaving() &&
		writes.pending() === 0 &&
		exclusives.size === 0 &&
		queryClient.isMutating() === 0;

	let closing: Promise<void> | undefined;

	return {
		/** The folder's writes, each in its file's turn, keeping the cache in step (`folderWrites`). */
		writes,
		body,
		text,
		field,
		/**
		 * Set fields of the row at `stem` as its file is now, at once, as a
		 * click does. A failure is reported with `unsaved`, the text the
		 * person typed among the fields, if any. Answers why it was refused,
		 * changing nothing, if it was.
		 */
		set<K extends Name>(
			table: K,
			stem: string,
			set: Partial<FieldsOf<TTables, K>>,
			{ unsaved = '' }: { readonly unsaved?: string } = {},
		): string | undefined {
			const path = rowPath(table, stem);
			const why = refusal(path);
			if (why !== undefined) return why;
			void tableWrites(table)
				.set(stem, set as Fields)
				.then(
					({ error }) => {
						if (error !== null) writeFailed({ path, error, unsaved });
					},
					(cause: unknown) =>
						writeFailed({
							path,
							error: FileError.Io({ path, operation: 'save', cause }).error,
							unsaved,
						}),
				);
			return undefined;
		},
		/** Whether a write of `path`, or of any file, runs or waits, or typing there waits to be sent; read reactively. */
		writing(path?: string): boolean {
			trackWrites();
			return writes.pending(path) > 0 || draftsSaving(path);
		},
		/** Whether text typed at `path`, or anywhere, did not save, with no save running or waiting; read reactively. */
		unsaved(path?: string): boolean {
			const held = heldAt(path);
			return (
				[...held.bodies, ...held.texts].some(
					([, held]) => held.editor.typed !== undefined && !pendingSave(held),
				) ||
				held.fields.some(
					([, held]) => held.typed !== undefined && !pendingField(held),
				)
			);
		},
		/**
		 * Whether leaving now could lose anything: text typed and not in its
		 * file, a write, a rename or delete, or an app action running; read
		 * reactively.
		 */
		get busy(): boolean {
			trackWrites();
			trackMutations();
			return (
				writes.pending() > 0 ||
				locks.size > 0 ||
				queryClient.isMutating() > 0 ||
				typedPaths().length > 0
			);
		},
		/** Whether edits of `path` are refused now: closing, or a rename or delete of it runs; read reactively. */
		locked,
		/** Why an edit or action at `path`, or anywhere, does not start now, if it does not. */
		refusal,
		/** Whether the folder is closing: no input or action starts. */
		get fenced() {
			return fenced;
		},
		settled,
		exclusive,
		/**
		 * Record a version: commit the saved files (ADR-0529), once every
		 * draft and write landed. Typing whose save failed refuses it, so a
		 * version never stands for what is on screen while the file holds
		 * less. Every other outcome is the commit's answer; the app decides
		 * what a person is told.
		 */
		async saveVersion(): Promise<Result<CommitOutcome, ActionError>> {
			if (fenced) return ActionError.NotStarted({ reason: CLOSING });
			const unsaved = await settled();
			if (unsaved.length > 0)
				return ActionError.NotStarted({ reason: notVersioned(unsaved) });
			const outcome = await folder.git.commit();
			void queryClient.invalidateQueries(queries.pathFilter(['.git']));
			return Ok(outcome);
		},
		/**
		 * Sync, once every draft and write landed; given `url`, connect to it
		 * first (`folder.sync.connect`). Typing whose save failed does not
		 * stop it: Sync carries what the files hold and claims nothing about
		 * the edit still on screen, which stays held with Save again. The
		 * files Sync wrote arrive on the folder's change channel; every query
		 * is read again besides.
		 */
		async sync({
			url,
			...options
		}: SyncOptions & { readonly url?: string } = {}): Promise<
			Result<SyncOutcome, SyncError | ActionError>
		> {
			if (fenced) return ActionError.NotStarted({ reason: CLOSING });
			await settled();
			const result =
				url === undefined
					? await folder.sync.run(options)
					: await folder.sync.connect(url, options);
			void queryClient.invalidateQueries({ queryKey: queries.key });
			return result;
		},
		/** Refuse new input and actions from now on. */
		fence() {
			fenced = true;
		},
		/**
		 * Fence, then wait until every draft is sent and every write, rename,
		 * delete, and app action has settled, again until nothing is left.
		 * Typing whose save failed does not hold it open: its failure was
		 * reported, with the text to copy. It releases nothing: whoever
		 * opened the folder closes it after. Every call answers the same
		 * completion.
		 */
		close(): Promise<void> {
			fenced = true;
			closing ??= (async () => {
				for (;;) {
					await settled();
					await Promise.all(
						[...exclusives].map((running) => running.catch(() => {})),
					);
					await whenIdle(queryClient);
					if (quiet()) break;
				}
				stopWatching();
			})();
			return closing;
		},
	};
}
