/**
 * `@epicenter/svelte/client`: a contract's typed client (`Client<T>`) as
 * Svelte state, the way `fromAuth` adapts an auth client.
 *
 * `fromClient(client)` gives each collection tracked reads (`items`,
 * `invalid` for notes, `loading`, `error`, and `get(args)`) and its writes,
 * which pass the version the adapter shows, so a component never handles
 * one. A collection lists and subscribes (`subscribe` on the client) only
 * while an effect reads it, through `createSubscriber`, and stops when the
 * last reader goes; a read outside tracking is a snapshot. One client has
 * one adapter: every `fromClient(device)` on a page is the same state, so
 * any component may compose from it and views never disagree.
 *
 * - A write through the adapter puts what landed into what it shows before
 *   it resolves, so an edit's answer and the next listing never disagree.
 * - A listing that a change interrupted is thrown away and read again, so a
 *   stale listing never replaces a newer one.
 * - A listing that fails keeps what was shown, says why (`error`), and is
 *   tried again after a while (half a second, doubling to 30 seconds) for as
 *   long as someone reads, so a passing storage failure does not freeze it.
 * - A note `update` follows `updateNote`: carried over another writer's
 *   change to other fields; a `Conflict` when they changed the same one, and
 *   then the adapter shows theirs, so saving again applies over it.
 *
 * `fieldEdit(notes, args, field)` binds one field to an immediate editor.
 *
 * Every write is held for the page's leave guard (`@epicenter/svelte/leave-guard`)
 * from the call until it answers.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 * 	const files = fromClient(openDevice(todosContract));
 * 	const todo = $derived(files.todos.get({ id }));
 * 	const title = fieldEdit(files.todos, { id }, 'title');
 * </script>
 *
 * {#each files.todos.items as todo (todo.id)}…{/each}
 * <Input bind:value={title.value} />
 * <Checkbox checked={todo?.done} onCheckedChange={(done) => files.todos.update({ id }, { done })} />
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
import { createSubscriber } from 'svelte/reactivity';
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { edit } from './edit.svelte.js';
import { holdLeave } from './leave-guard.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/** A note the adapter shows, or the version and fields an edit was made over. */
type Base<TCollection extends Collection> = {
	version: Version;
} & NotePatch<TCollection>;

/** A note collection as Svelte state. */
export type ReactiveNotes<TCollection extends Collection> = {
	/** The notes as last listed (and written here since); empty until the first listing. */
	readonly items: readonly NoteOf<TCollection>[];
	/** The notes that do not read, with their text. */
	readonly invalid: readonly InvalidNoteOf<TCollection>[];
	/** True until the first listing answers. */
	readonly loading: boolean;
	/** Why the last listing failed; null once one answers. What was shown stays. */
	readonly error: Unavailable | null;
	/** The note `args` names, as shown. */
	get(args: PlaceholdersOf<TCollection>): NoteOf<TCollection> | undefined;
	create: NoteClient<TCollection>['create'];
	/**
	 * Write `patch` over `base`, by default the note as shown: what a person
	 * acting on what they see saw. An editor that shows typed text instead
	 * passes what was shown when the typing began (`fieldEdit` does).
	 */
	update(
		args: PlaceholdersOf<TCollection>,
		patch: NotePatch<TCollection>,
		options?: { base?: Base<TCollection> },
	): ReturnType<NoteClient<TCollection>['update']>;
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
	): ReturnType<NoteClient<TCollection>['replace']>;
	delete(
		args: PlaceholdersOf<TCollection>,
	): ReturnType<NoteClient<TCollection>['delete']>;
};

/** A file collection as Svelte state: its entries, without bytes (read those with the client's `get`). */
export type ReactiveFiles<TCollection extends Collection> = {
	readonly items: readonly FileEntryOf<TCollection>[];
	readonly loading: boolean;
	readonly error: Unavailable | null;
	get(args: PlaceholdersOf<TCollection>): FileEntryOf<TCollection> | undefined;
	create: FileClient<TCollection>['create'];
	update(
		args: PlaceholdersOf<TCollection>,
		patch: { bytes: Uint8Array },
	): ReturnType<FileClient<TCollection>['update']>;
	delete(
		args: PlaceholdersOf<TCollection>,
	): ReturnType<FileClient<TCollection>['delete']>;
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

/** Each client's adapter, so a client is bridged once however many components ask. */
const adapters = new WeakMap<object, unknown>();

/** Bridge a contract's client into Svelte's graph: the same state for the same client. */
export function fromClient<TContract extends Contract>(
	client: Client<TContract>,
): ReactiveClient<TContract> {
	const known = adapters.get(client);
	if (known !== undefined) return known as ReactiveClient<TContract>;
	const adapted = Object.fromEntries(
		Object.entries(client).map(([name, collection]) => [
			name,
			fromCollection(collection as Raw),
		]),
	);
	adapters.set(client, adapted);
	// SAFETY: each collection's client is adapted by the kind it is (a note
	// client has `replace`), which is the kind its contract path gives it.
	return adapted as unknown as ReactiveClient<TContract>;
}

/** Either kind of collection client, as this module calls it. */
type Raw = NoteClient<Collection> | FileClient<Collection>;
type Entry = { [key: string]: unknown; version: Version };
type Args = Record<string, unknown>;

/** How long after a failed listing it is tried again, doubling per failure up to the most. */
const RETRY_FIRST_MS = 500;
const RETRY_MOST_MS = 30_000;

/** Whether `entry` is the one `args` (placeholders, or a created value) names. */
const names = (entry: Entry, args: Args) =>
	Object.entries(args).every(
		([key, value]) => key === 'bytes' || sameValue(entry[key], value),
	);

function fromCollection(collection: Raw) {
	const notes = 'replace' in collection ? collection : null;
	let items: Entry[] = [];
	let invalid: Entry[] = [];
	let loading = true;
	let error: Unavailable | null = null;
	let changed = () => {};
	let listing = false;
	let again = false;
	/** Whether someone reads, so a failed listing is worth trying again. */
	let reading = false;
	/** Listings that failed in a row, and the try after the last one. */
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;

	/** List again, as long as changes keep arriving while a listing runs. */
	async function reload() {
		clearTimeout(retry);
		retry = undefined;
		if (listing) {
			again = true;
			return;
		}
		listing = true;
		try {
			do {
				again = false;
				const listed = await collection.list();
				if (again) continue;
				if (listed.error !== null) {
					error = listed.error;
					failures++;
				} else {
					items = listed.data.items as Entry[];
					invalid = (
						'invalid' in listed.data ? listed.data.invalid : []
					) as Entry[];
					error = null;
					failures = 0;
				}
				loading = false;
				changed();
			} while (again);
		} finally {
			listing = false;
		}
		if (failures > 0 && reading)
			retry = setTimeout(
				() => void reload(),
				Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MOST_MS),
			);
	}

	const track = createSubscriber((update) => {
		changed = update;
		reading = true;
		const stop = collection.subscribe(() => void reload());
		void reload();
		return () => {
			stop();
			reading = false;
			clearTimeout(retry);
			retry = undefined;
			failures = 0;
			changed = () => {};
		};
	});

	/** Show `entry` where `args` named one, or as a new one. */
	function put(entry: Entry, args: Args) {
		const at = items.findIndex((item) => names(item, args));
		items = at === -1 ? [...items, entry] : items.with(at, entry);
		invalid = invalid.filter((item) => !names(item, args));
		changed();
	}

	/** Show nothing where `args` named something. */
	function drop(args: Args) {
		items = items.filter((item) => !names(item, args));
		invalid = invalid.filter((item) => !names(item, args));
		changed();
	}

	const shown = (args: Args) => items.find((item) => names(item, args));

	/** What a write is made over: the entry shown, or else as read now. */
	async function baseOf(args: Args): Promise<Result<Entry, ClientError>> {
		const entry = shown(args) ?? invalid.find((item) => names(item, args));
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

	/** After a write, show what it answered: what landed, or what is there now. */
	async function settle<T extends Result<unknown, { name: string }>>(
		args: Args,
		written: T,
	): Promise<T> {
		if (written.error === null) {
			if (written.data === undefined) drop(args);
			else put(written.data as Entry, args);
			return written;
		}
		if (written.error.name !== 'Conflict' && written.error.name !== 'NotFound')
			return written;
		// A file's `get` brings its bytes: list it again instead.
		if (notes === null) {
			void reload();
			return written;
		}
		const now = await notes.get(args as never);
		if (now.error === null) put(now.data as Entry, args);
		else if (now.error.name === 'NotFound') drop(args);
		return written;
	}

	const writes = {
		async create(value: Args) {
			const created = await collection.create(value as never);
			if (created.error === null) put(created.data as Entry, value);
			return created;
		},
		async update(args: Args, patch: Args, options: { base?: Entry } = {}) {
			const base = options.base ? Ok(options.base) : await baseOf(args);
			if (base.error !== null) return base;
			return settle(
				args,
				notes
					? await updateNote(notes, args as never, patch as never, {
							base: base.data as never,
						})
					: await collection.update(args as never, patch as never, {
							over: base.data.version,
						}),
			);
		},
		async replace(args: Args, text: string, options: { over?: Version } = {}) {
			if (notes === null)
				throw new Error('replace is a note collection’s alone');
			let over = options.over;
			if (over === undefined) {
				const base = await baseOf(args);
				if (base.error !== null) return base;
				over = base.data.version;
			}
			return settle(args, await notes.replace(args as never, text, { over }));
		},
		async delete(args: Args) {
			const base = await baseOf(args);
			if (base.error !== null) return base;
			return settle(
				args,
				await collection.delete(args as never, { over: base.data.version }),
			);
		},
	};

	return {
		get items() {
			track();
			return items;
		},
		get invalid() {
			track();
			return invalid;
		},
		get loading() {
			track();
			return loading;
		},
		get error() {
			track();
			return error;
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
	};
}

/**
 * One field of a note (`'body'` included) as an immediate editor (`edit`):
 * `value` shows what was typed until its save answers, then the note.
 *
 * Saves go one at a time, and only the newest value waiting is sent. Each is
 * made over what the person saw when this run of typing began, then over
 * their own last value that landed, so the editor never clashes with itself,
 * another writer's change to other fields is carried over, and their change
 * to this field surfaces as a `Conflict` (the adapter then shows theirs).
 * Saving again after that (`retry`, or typing on) applies over theirs.
 *
 * With `create`, the note need not exist yet: a save while none is shown
 * creates it, with `create()`'s fields and the typed value (a draft that
 * starts with its first keystroke). When another writer created it first
 * (`Occupied`), the value is written over theirs as an ordinary save.
 *
 * Call it during component setup, like `edit`.
 */
export function fieldEdit<
	TCollection extends Collection,
	TField extends keyof NotePatch<TCollection> & string,
>(
	notes: ReactiveNotes<TCollection>,
	args: PlaceholdersOf<TCollection>,
	field: TField,
	options: {
		create?: () => Omit<FieldsOf<TCollection> & { body?: string }, TField>;
	} = {},
) {
	type Value = NotePatch<TCollection>[TField];
	/** What this run of typing is made over; none between runs. */
	let base: Base<TCollection> | undefined;
	let newest = 0;
	let running: Promise<unknown> = Promise.resolve();

	/** Write `value`: a new note when none is there to write over and `create` says how. */
	async function write(
		value: Value | undefined,
	): Promise<Result<unknown, ClientError>> {
		const patch = { [field]: value } as NotePatch<TCollection>;
		if (options.create && base === undefined && !notes.get(args)) {
			const created = await notes.create({
				...options.create(),
				...args,
				...patch,
			} as Parameters<ReactiveNotes<TCollection>['create']>[0]);
			if (created.error?.name !== 'Occupied') return created;
		}
		return notes.update(args, patch, base ? { base } : {});
	}

	const editor = edit(
		() =>
			notes.get(args)?.[field as keyof NoteOf<TCollection>] as
				| Value
				| undefined,
		(value: Value | undefined) => {
			const ticket = ++newest;
			base ??= notes.get(args);
			const saved = running.then(async () => {
				// A newer value is waiting: it is the one to send.
				if (ticket !== newest) return Ok(undefined);
				const written = await write(value);
				if (written.error === null)
					base =
						ticket === newest ? undefined : (written.data as Base<TCollection>);
				else if (written.error.name === 'Conflict') base = undefined;
				return written;
			});
			running = saved.catch(() => {});
			return saved;
		},
	);

	return {
		get value() {
			return editor.value;
		},
		set value(value: Value | undefined) {
			editor.value = value;
		},
		get error() {
			return editor.error;
		},
		/** Whether a save is out: from the keystroke until it answers. */
		get saving() {
			return editor.saving;
		},
		set: editor.set,
		landed: editor.landed,
		retry: editor.retry,
		discard() {
			base = undefined;
			editor.discard();
		},
	};
}
