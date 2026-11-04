/**
 * `@epicenter/svelte/client`: an app's folder, or a contract's typed client,
 * as Svelte state, the way `fromAuth` adapts an auth client.
 *
 * `fromClient(folder)` is made once, where the folder is
 * (`export const folder = fromClient(openFolder(todos))` in `src/lib/app.ts`),
 * and components read it directly: each collection gives tracked reads
 * (`items`, `invalid` for notes, `loading`, `error`, and `get(args)`) and
 * its writes, which pass the version shown, so a component never handles
 * one. The folder's own `state` tracks too, beside `retry()` and `reveal`,
 * so `<Opening {folder}>` takes the same value. A plain client
 * (`openDevice`, `openRemote`) adapts the same way, ready at once, without
 * the lifecycle.
 *
 * The reads are the folder's own (`@epicenter/folder`): a collection lists
 * only while something reads it in a tracking context (a template,
 * `$derived`, an effect), through `createTracker` (`./tracked.ts`, the
 * helper under every capability's adapter), and stops when the last reader
 * goes; a read outside tracking is a snapshot. The adapter works at module
 * scope: nothing but `edit()` belongs to a component. One source has one
 * adapter, so views never disagree.
 *
 * - A write puts what landed into what shows before it resolves.
 * - While the folder opens, a collection is empty and `loading`; a write
 *   waits for the open, and answers the open's error when it fails.
 * - A note `update` follows `updateNote`: carried over another writer's
 *   change to other fields; a `Conflict` when they changed the same one, and
 *   then the adapter shows theirs, so saving again applies over it.
 *
 * `notes.edit(args)` is one note as an immediate editor (`NoteEdit`), for
 * the component that shows it: its fields to read and bind (`fields`, one
 * accessor per declared field and `body`, from the collection's
 * `fieldNames`), and whether the note is there (`exists`). Call it during
 * that component's setup: it stops with the component. `get` stays for
 * lists and for the saved note beside the typing, and `update` for code
 * that is not typing.
 *
 * Every write is held for the page's leave guard (`@epicenter/svelte/leave-guard`)
 * from the call until it answers.
 *
 * @example
 * ```ts
 * // src/lib/app.ts
 * export const folder = fromClient(openFolder(todos, { site }));
 * ```
 *
 * ```svelte
 * <script lang="ts">
 * 	import { folder } from '$lib/app.js';
 * 	const todo = folder.todos.edit({ id });
 * </script>
 *
 * {#if todo.exists}
 * 	<Input bind:value={todo.fields.title} />
 * 	<Textarea bind:value={todo.fields.body} />
 * 	<Checkbox bind:checked={todo.fields.done} />
 * 	<UnsavedEdit edit={todo} />
 * {:else}
 * 	<p>This todo is no longer here.</p>
 * {/if}
 * ```
 */
import {
	type Client,
	type ClientError,
	type Collection,
	type Contract,
	type FieldsOf,
	type FileClient,
	type FileEntryOf,
	type InvalidNoteOf,
	type NoteClient,
	type NoteOf,
	type NotePatch,
	type PlaceholdersOf,
	updateNote,
	type Version,
} from '@epicenter/definition/contract';
import { sameValue } from '@epicenter/definition/note';
import {
	type Folder,
	type FolderFiles,
	type FolderLifecycle,
	type FolderNotes,
	type FolderState,
	folderOf,
	type OpenFolderError,
} from '@epicenter/folder/core';
import { onDestroy } from 'svelte';
import type { InferError } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { holdLeave } from './leave-guard.js';
import { createTracker } from './tracked.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * `method`, answering `TOpen` too: the open's error for a folder's
 * collection, never for a client already open.
 */
type Widen<TMethod, TOpen> = TMethod extends (
	...args: infer TArgs
) => Promise<Result<infer TData, infer TError>>
	? (...args: TArgs) => Promise<Result<TData, TError | TOpen>>
	: never;

/** A note the adapter shows, or the version and fields an edit was made over. */
type Base<TCollection extends Collection> = {
	version: Version;
} & NotePatch<TCollection>;

/**
 * One note as an immediate editor. `fields` holds each declared field and
 * `body`: each shows what was typed until its save answers, then the note,
 * and setting one saves it. The rest says whether the note is there and how
 * its saves stand.
 */
export type NoteEdit<TCollection extends Collection, TOpen = never> = {
	/** The note's fields and body to read and bind; one accessor each, live for the editor's life. */
	readonly fields: NotePatch<TCollection>;
	/** Whether a note that reads is listed at the editor's path; false while missing, deleted or not reading. */
	readonly exists: boolean;
	/** Why the newest save failed; null while none has. What was typed stays. */
	readonly error: ClientError | TOpen | null;
	/** Whether a save is out: from the keystroke until it answers. */
	readonly saving: boolean;
	/** What was typed and is not yet shown as saved, by field; null while the editor shows the note. */
	readonly typed: NotePatch<TCollection> | null;
	/** Send what was typed again, over the note as shown now. */
	retry(): void;
	/** Show the note again, dropping what was typed; a save already out still lands. */
	discard(): void;
	/** Answers once the newest typed value's save does: at once when nothing typed is waiting. */
	landed(): Promise<Result<void, ClientError | TOpen>>;
};

/**
 * A note collection as Svelte state. `TOpen` is what its actions answer when
 * its folder did not open: `OpenFolderError` for a folder's, nothing for a
 * client already open.
 */
export type ReactiveNotes<TCollection extends Collection, TOpen = never> = {
	/** The fields the contract declares, in its order: an editor's `fields` are these and `body`. */
	fieldNames: NoteClient<TCollection>['fieldNames'];
	/** The notes as last listed (and written here since); empty until the first listing. */
	readonly items: readonly NoteOf<TCollection>[];
	/** The notes that do not read, with their text. */
	readonly invalid: readonly InvalidNoteOf<TCollection>[];
	/** True until the first listing answers, which waits for the folder to open. */
	readonly loading: boolean;
	/** Why the last listing failed (the open's error when the folder did not open); null once one answers. What was shown stays. */
	readonly error: Unavailable | TOpen | null;
	/** The note `args` names, as shown. */
	get(args: PlaceholdersOf<TCollection>): NoteOf<TCollection> | undefined;
	create: Widen<NoteClient<TCollection>['create'], TOpen>;
	/**
	 * Write `patch` over `base`, by default the note as shown: what a person
	 * acting on what they see saw. An editor that shows typed text instead
	 * passes what was shown when the typing began (`edit` does).
	 */
	update(
		args: PlaceholdersOf<TCollection>,
		patch: NotePatch<TCollection>,
		options?: { base?: Base<TCollection> },
	): ReturnType<Widen<NoteClient<TCollection>['update'], TOpen>>;
	/**
	 * Replace the whole note with `text`, over `over`, by default the version
	 * shown (valid or not). An editor that shows a draft passes the version
	 * its draft began from, so another writer's change since is a `Conflict`
	 * (the adapter then shows theirs), not overwritten.
	 */
	replace(
		args: PlaceholdersOf<TCollection>,
		text: string,
		options?: { over?: Version },
	): ReturnType<Widen<NoteClient<TCollection>['replace'], TOpen>>;
	delete(
		args: PlaceholdersOf<TCollection>,
	): ReturnType<Widen<NoteClient<TCollection>['delete'], TOpen>>;
	/**
	 * The note `args` names as an immediate editor (`NoteEdit`), for the
	 * component that shows it. Call it during component setup: once the
	 * component is gone, typing and answers are ignored.
	 *
	 * Saves go one at a time, and only the newest waiting is sent, carrying
	 * every field typed since the last save that landed; only the newest
	 * save's answer is shown. Each is made over the note as shown when this
	 * run of typing began (each field as shown when its own typing began),
	 * then over the editor's own last save that landed, so the editor never
	 * clashes with itself, another writer's change to fields not typed is
	 * carried over, and their change to a typed field surfaces as a
	 * `Conflict` (the adapter then shows theirs) with the typed text kept.
	 * Saving again after that (`retry`, or typing on) applies over theirs.
	 * Each keystroke is held for the page's leave guard (`holdLeave`) from
	 * the moment it is typed until its save answers.
	 *
	 * With `create`, the note need not exist yet: a save while none is shown
	 * creates it, with `create()`'s fields and what was typed (a draft that
	 * starts with its first keystroke). When another writer created it first
	 * (`Occupied`), what was typed is written over theirs as an ordinary save.
	 */
	edit(
		args: PlaceholdersOf<TCollection>,
		options?: {
			create?: () => FieldsOf<TCollection> & { body?: string };
		},
	): NoteEdit<TCollection, TOpen>;
};

/** A file collection as Svelte state: its entries, without bytes (read those with the client's `get`). */
export type ReactiveFiles<TCollection extends Collection, TOpen = never> = {
	readonly items: readonly FileEntryOf<TCollection>[];
	readonly loading: boolean;
	readonly error: Unavailable | TOpen | null;
	get(args: PlaceholdersOf<TCollection>): FileEntryOf<TCollection> | undefined;
	create: Widen<FileClient<TCollection>['create'], TOpen>;
	update(
		args: PlaceholdersOf<TCollection>,
		patch: { bytes: Uint8Array },
	): ReturnType<Widen<FileClient<TCollection>['update'], TOpen>>;
	delete(
		args: PlaceholdersOf<TCollection>,
	): ReturnType<Widen<FileClient<TCollection>['delete'], TOpen>>;
};

export type ReactiveCollection<
	TCollection extends Collection,
	TOpen = never,
> = TCollection['path'] extends `${string}.md`
	? ReactiveNotes<TCollection, TOpen>
	: ReactiveFiles<TCollection, TOpen>;

/** A contract's client as Svelte state: one reactive collection per collection. */
export type ReactiveClient<TContract extends Contract, TOpen = never> = {
	readonly [K in keyof TContract['collections']]: ReactiveCollection<
		TContract['collections'][K],
		TOpen
	>;
};

/**
 * An app's folder as Svelte state: its collections, and its lifecycle,
 * which only `<Opening>` reads (ADR-0767).
 */
export type ReactiveFolder<TContract extends Contract> = ReactiveClient<
	TContract,
	OpenFolderError
> & {
	/** The folder's open attempt: opening, ready, or failed with why. */
	readonly state: FolderState;
	/** Open again after a failure; does nothing otherwise. */
	retry(): void;
	/** Show the folder's place in the file manager, where it has one. */
	readonly reveal: FolderLifecycle['reveal'];
	/** Where the folder is, to show a person, once it opened; null where it has no path. */
	readonly displayPath: string | null;
};

/** Each source's adapter, so a folder or client is bridged once however many readers ask. */
const adapters = new WeakMap<object, unknown>();

/** Whether `source` is a folder (`openFolder`), not a plain client. */
const isFolder = (source: object): source is Folder<Contract> =>
	'state' in source &&
	typeof source.state === 'function' &&
	'retry' in source &&
	typeof source.retry === 'function';

/**
 * Bridge a folder, or a contract's client, into Svelte's graph: the same
 * state for the same source. Make it once, at module scope beside the
 * folder, and read it anywhere.
 */
export function fromClient<TContract extends Contract>(
	folder: Folder<TContract>,
): ReactiveFolder<TContract>;
export function fromClient<TContract extends Contract>(
	client: Client<TContract>,
): ReactiveClient<TContract>;
export function fromClient<TContract extends Contract>(
	source: Folder<TContract> | Client<TContract>,
): ReactiveFolder<TContract> | ReactiveClient<TContract> {
	const known = adapters.get(source);
	if (known !== undefined) return known as ReactiveClient<TContract>;
	const folder = isFolder(source)
		? (source as unknown as Folder<Contract>)
		: folderOf(source as Client<Contract>);
	const collections: Record<string, unknown> = {};
	// The folder's own members are functions, or a null `reveal`.
	for (const [name, collection] of Object.entries(folder))
		if (typeof collection === 'object' && collection !== null)
			collections[name] = fromCollection(collection as Raw);
	const adapted = isFolder(source)
		? lifecycleOf(folder, collections)
		: collections;
	adapters.set(source, adapted);
	// SAFETY: each collection is adapted by the kind it is (a note
	// collection has `replace`), which is the kind its contract path gives it.
	return adapted as unknown as ReactiveFolder<TContract>;
}

/** `collections` with the folder's lifecycle beside them: `state` and `displayPath` track. */
function lifecycleOf(folder: Folder<Contract>, collections: object) {
	const track = createTracker(folder.subscribe);
	return Object.defineProperties(collections, {
		state: {
			get() {
				track();
				return folder.state();
			},
		},
		displayPath: {
			get() {
				track();
				return folder.displayPath();
			},
		},
		retry: { value: () => folder.retry() },
		reveal: { value: folder.reveal },
	});
}

/** Either kind of folder collection, as this module calls it. */
type Raw = FolderNotes<Collection> | FolderFiles<Collection>;
type Entry = { [key: string]: unknown; version: Version };
type Args = Record<string, unknown>;
type Answer = Result<unknown, ClientError | OpenFolderError>;

/** Whether `entry` is the one `args` (placeholders, or a created value) names. */
const names = (entry: Entry, args: Args) =>
	Object.entries(args).every(
		([key, value]) => key === 'bytes' || sameValue(entry[key], value),
	);

function fromCollection(collection: Raw) {
	const notes = 'replace' in collection ? collection : null;
	const track = createTracker(collection.subscribe);
	const items = () => collection.items() as readonly Entry[];
	const invalid = () =>
		(notes?.invalid() ??
			[]) as readonly InvalidNoteOf<Collection>[] as unknown as readonly Entry[];

	const shown = (args: Args) => items().find((item) => names(item, args));

	/** What a write is made over: the entry shown, or else as read now. */
	async function baseOf(
		args: Args,
	): Promise<Result<Entry, ClientError | OpenFolderError>> {
		const entry = shown(args) ?? invalid().find((item) => names(item, args));
		if (entry !== undefined) return Ok(entry);
		const listed = await collection.list();
		const found = [
			...(listed.data?.items ?? []),
			...((listed.data && 'invalid' in listed.data
				? listed.data.invalid
				: []) as Entry[]),
		].find((item) => names(item as Entry, args));
		if (found !== undefined) return Ok(found as Entry);
		// Not listed: `get` answers why (`NotFound`, or the listing's own refusal).
		const read = await collection.get(args as never);
		if (read.error !== null) return read;
		return Ok(read.data as Entry);
	}

	const writes = {
		create: (value: Args) =>
			collection.create(value as never) as Promise<Answer>,
		async update(
			args: Args,
			patch: Args,
			options: { base?: Entry } = {},
		): Promise<Answer> {
			const base = options.base ? Ok(options.base) : await baseOf(args);
			if (base.error !== null) return base;
			if (notes === null)
				return collection.update(args as never, patch as never, {
					over: base.data.version,
				});
			// SAFETY: `updateNote` answers any error but a `Conflict` as the
			// collection did, so the open's error passes through unchanged.
			return updateNote(
				notes as unknown as Pick<NoteClient<Collection>, 'get' | 'update'>,
				args as never,
				patch as never,
				{ base: base.data as never },
			);
		},
		async replace(
			args: Args,
			text: string,
			options: { over?: Version } = {},
		): Promise<Answer> {
			if (notes === null)
				throw new Error('replace is a note collection’s alone');
			let over = options.over;
			if (over === undefined) {
				const base = await baseOf(args);
				if (base.error !== null) return base;
				over = base.data.version;
			}
			return notes.replace(args as never, text, { over });
		},
		async delete(args: Args): Promise<Answer> {
			const base = await baseOf(args);
			if (base.error !== null) return base;
			return collection.delete(args as never, { over: base.data.version });
		},
	};

	/** The note `args` names as an immediate editor; see `ReactiveNotes['edit']`. */
	function edit(args: Args, options: { create?: () => Args } = {}) {
		type Saved = Result<unknown, ClientError | OpenFolderError>;
		/** What was typed and not yet shown as saved, by field; none shows the note. */
		let typed = $state.raw<Args | null>(null);
		let error = $state<ClientError | OpenFolderError | null>(null);
		/** Keystrokes whose save has not answered. */
		let sending = $state(0);
		/** The fields typed since the last save that landed: what the next save sends. */
		let pending: Args = {};
		/**
		 * What this run of typing is made over: the version shown when it
		 * began, and each typed field as shown when its typing began. None
		 * between runs.
		 */
		let base: Entry | undefined;
		/** The newest keystroke's number: only its save is sent, and only its answer shown. */
		let newest = 0;
		/** The newest keystroke's save, answered once what it shows is shown. */
		let latest: Promise<Saved> = Promise.resolve(Ok(undefined));
		/** The saves, one at a time. */
		let running: Promise<unknown> = Promise.resolve();
		let active = true;
		onDestroy(() => {
			active = false;
		});

		/** Write `patch`: a new note when none is there to write over and `create` says how. */
		async function write(patch: Args): Promise<Saved> {
			if (options.create && base === undefined && !shown(args)) {
				const created = await writes.create({
					...options.create(),
					...args,
					...patch,
				});
				if (created.error?.name !== 'Occupied') return created;
			}
			return writes.update(args, patch, base ? { base } : {});
		}

		/**
		 * After an older save of `patch` landed as `saved`, what the next save is
		 * made over: `saved`, unless a field still waiting changed under it since
		 * its typing began, which the next save must then surface as a clash.
		 */
		function after(saved: Entry, patch: Args): Entry {
			if (base === undefined) return saved;
			const was = base;
			const moved = Object.keys(pending).some(
				(field) => !(field in patch) && !sameValue(saved[field], was[field]),
			);
			if (!moved) return saved;
			return {
				...was,
				...Object.fromEntries(
					Object.keys(patch).map((field) => [field, saved[field]]),
				),
			};
		}

		function send() {
			const ticket = ++newest;
			base ??= shown(args);
			const saved = running.then(async (): Promise<Saved> => {
				// A newer keystroke is waiting: its save carries this one's typing.
				if (ticket !== newest) return Ok(undefined);
				const patch = { ...pending };
				if (Object.keys(patch).length === 0) return Ok(undefined);
				const written = await write(patch);
				if (written.error === null) {
					for (const [field, value] of Object.entries(patch))
						if (sameValue(pending[field], value)) delete pending[field];
					base =
						ticket === newest ? undefined : after(written.data as Entry, patch);
				} else if (written.error.name === 'Conflict') base = undefined;
				return written;
			});
			running = saved.catch(() => {});
			sending++;
			latest = holdLeave(saved)
				.finally(() => {
					sending--;
				})
				.then((result) => {
					// Shown unless a newer keystroke, a discard, or teardown has moved on.
					if (active && ticket === newest && typed !== null) {
						if (result.error === null) typed = null;
						else error = result.error;
					}
					return result;
				});
		}

		function set(field: string, value: unknown) {
			if (!active) return;
			if (!(field in pending)) {
				const note = shown(args);
				if (note !== undefined)
					base = { ...(base ?? note), [field]: note[field] };
			}
			pending[field] = value;
			typed = { ...typed, [field]: value };
			error = null;
			send();
		}

		/** Each field and the body: what was typed until its save answers, else the note as shown. */
		const fields = {};
		for (const field of [...(notes?.fieldNames ?? []), 'body'])
			Object.defineProperty(fields, field, {
				enumerable: true,
				get() {
					if (typed !== null && field in typed) return typed[field];
					track();
					return shown(args)?.[field];
				},
				set: (value: unknown) => set(field, value),
			});

		return {
			fields,
			get exists() {
				track();
				return shown(args) !== undefined;
			},
			get error() {
				return error;
			},
			get saving() {
				return sending > 0;
			},
			get typed() {
				return typed;
			},
			retry() {
				if (!active || typed === null) return;
				error = null;
				send();
			},
			discard() {
				if (!active) return;
				typed = null;
				error = null;
				base = undefined;
				pending = {};
			},
			async landed(): Promise<Result<void, ClientError | OpenFolderError>> {
				while (active && typed !== null) {
					const ticket = newest;
					const result = await latest;
					if (ticket !== newest) continue;
					return result.error === null ? Ok(undefined) : Err(result.error);
				}
				return Ok(undefined);
			},
		};
	}

	const adapted = {
		...(notes && { fieldNames: notes.fieldNames }),
		get items() {
			track();
			return items();
		},
		get invalid() {
			track();
			return invalid();
		},
		get loading() {
			track();
			return collection.loading();
		},
		get error() {
			track();
			return collection.error();
		},
		get(args: Args) {
			track();
			return shown(args);
		},
		create: (value: Args) => holdLeave(writes.create(value)),
		update: (args: Args, patch: Args, options?: { base?: Entry }) =>
			holdLeave(writes.update(args, patch, options)),
		replace: (args: Args, text: string, options?: { over?: Version }) =>
			holdLeave(writes.replace(args, text, options)),
		delete: (args: Args) => holdLeave(writes.delete(args)),
		edit,
	};
	return adapted;
}
