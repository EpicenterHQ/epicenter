/**
 * `@epicenter/svelte/client`: a contract's plain client (`openDevice`,
 * `openRemote`) as getter-shaped Svelte state, for the apps that open their
 * own client and have not moved to a folder read through `reactive`.
 *
 * It holds no work of its own: the client is read as a folder (`folderOf`),
 * whose collections show what is written, write over what is shown, and
 * edit notes (`edit`); `reactive` tracks the folder's reads, and this module
 * names each read a getter (`items`, `invalid`, `loading`, `error`, and an
 * editor's `exists`, `error`, `saving`, `typed`), the shape these apps were
 * written against. The folder's `saving()` holds the page's leave guard
 * (`holdLeave`) while a write or keystroke is out.
 *
 * A new app does not use this: it opens its folder in `src/lib/app.ts` and
 * reads it through `reactive`, under the folder's own names.
 */
import type {
	Client,
	ClientError,
	Collection,
	Contract,
	FileEntryOf,
	InvalidNoteOf,
	NoteOf,
	NotePatch,
} from '@epicenter/definition/contract';
import {
	type Folder,
	type FolderFiles,
	type FolderNotes,
	folderOf,
	type NoteEdit as FolderNoteEdit,
	type OpenFolderError,
} from '@epicenter/folder/core';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { holdLeave } from './leave-guard.js';
import { reactive } from './reactive.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/** One note as an immediate editor, its reads as getters; see the folder's `NoteEdit`. */
export type NoteEdit<TCollection extends Collection> = {
	readonly fields: NotePatch<TCollection>;
	readonly exists: boolean;
	readonly error: ClientError | null;
	readonly saving: boolean;
	readonly typed: NotePatch<TCollection> | null;
	retry(): void;
	discard(): void;
	landed(): Promise<Result<void, ClientError>>;
};

/** A client already open never answers the open's error. */
type Opened<TMethod> = TMethod extends (
	...args: infer TArgs
) => Promise<Result<infer TData, infer TError>>
	? (...args: TArgs) => Promise<Result<TData, Exclude<TError, OpenFolderError>>>
	: never;

/** A note collection as Svelte state: the folder's collection, its reads as getters. */
export type ReactiveNotes<TCollection extends Collection> = {
	fieldNames: FolderNotes<TCollection>['fieldNames'];
	readonly items: readonly NoteOf<TCollection>[];
	readonly invalid: readonly InvalidNoteOf<TCollection>[];
	readonly loading: boolean;
	readonly error: Unavailable | null;
	get: FolderNotes<TCollection>['get'];
	create: Opened<FolderNotes<TCollection>['create']>;
	update: Opened<FolderNotes<TCollection>['update']>;
	replace: Opened<FolderNotes<TCollection>['replace']>;
	delete: Opened<FolderNotes<TCollection>['delete']>;
	edit(
		...args: Parameters<FolderNotes<TCollection>['edit']>
	): NoteEdit<TCollection>;
};

/** A file collection as Svelte state: its entries, without bytes. */
export type ReactiveFiles<TCollection extends Collection> = {
	readonly items: readonly FileEntryOf<TCollection>[];
	readonly loading: boolean;
	readonly error: Unavailable | null;
	get: FolderFiles<TCollection>['get'];
	create: Opened<FolderFiles<TCollection>['create']>;
	update: Opened<FolderFiles<TCollection>['update']>;
	delete: Opened<FolderFiles<TCollection>['delete']>;
};

export type ReactiveCollection<TCollection extends Collection> =
	TCollection['path'] extends `${string}.md`
		? ReactiveNotes<TCollection>
		: ReactiveFiles<TCollection>;

/** A contract's client as Svelte state: one reactive collection per collection. */
export type ReactiveClient<TContract extends Contract> = {
	readonly [K in keyof TContract['collections']]: ReactiveCollection<
		TContract['collections'][K]
	>;
};

/** Each client's state, so a client is bridged once however many readers ask. */
const adapters = new WeakMap<object, unknown>();

/**
 * Bridge a contract's client into Svelte's graph: the same state for the
 * same client. Make it once beside the client, and read it anywhere.
 */
export function fromClient<TContract extends Contract>(
	client: Client<TContract>,
): ReactiveClient<TContract> {
	const known = adapters.get(client);
	if (known !== undefined) return known as ReactiveClient<TContract>;
	const raw = folderOf(client as Client<Contract>);
	holdForLeave(raw);
	const folder = reactive(raw);
	const collections: Record<string, unknown> = {};
	for (const [name, collection] of Object.entries(raw))
		if (typeof collection === 'object' && collection !== null)
			collections[name] = gettersOf(
				(folder as unknown as Record<string, Raw>)[name] as Raw,
			);
	adapters.set(client, collections);
	// SAFETY: each collection keeps the kind its contract path gives it, and
	// a client already open never answers the open's error.
	return collections as unknown as ReactiveClient<TContract>;
}

/** Hold the page's leave guard while `folder` is saving. */
function holdForLeave(folder: Folder<Contract>) {
	let release: (() => void) | null = null;
	folder.subscribe(() => {
		if (folder.saving() === (release !== null)) return;
		if (release !== null) {
			release();
			release = null;
			return;
		}
		const out = Promise.withResolvers<void>();
		void holdLeave(out.promise);
		release = out.resolve;
	});
}

/** Either kind of folder collection, as this module calls it. */
type Raw = FolderNotes<Collection> | FolderFiles<Collection>;

/** `collection`'s reads as getters, beside its writes and editor. */
function gettersOf(collection: Raw) {
	const notes = 'edit' in collection ? collection : null;
	return {
		...(notes && { fieldNames: notes.fieldNames }),
		get items() {
			return collection.items();
		},
		get invalid() {
			return notes?.invalid() ?? [];
		},
		get loading() {
			return collection.loading();
		},
		get error() {
			return collection.error();
		},
		get: collection.get,
		create: collection.create,
		update: collection.update,
		...(notes && { replace: notes.replace }),
		delete: collection.delete,
		...(notes && {
			edit: (...args: Parameters<typeof notes.edit>) =>
				editorOf(notes.edit(...args)),
		}),
	};
}

/** The folder's note editor, its reads as getters. */
function editorOf(edit: FolderNoteEdit<Collection>) {
	return {
		fields: edit.fields,
		get exists() {
			return edit.exists();
		},
		get error() {
			return edit.error();
		},
		get saving() {
			return edit.saving();
		},
		get typed() {
			return edit.typed();
		},
		retry: edit.retry,
		discard: edit.discard,
		landed: edit.landed,
	};
}
