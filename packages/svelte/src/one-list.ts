/**
 * `oneList`: one note collection as a person sees it in an app that keeps
 * notes on this device and, signed in, in their repository (decision 12).
 * The notes still on the device ("not uploaded yet") and the repository's,
 * by placeholders, as one `ReactiveNotes`, so views and `fieldEdit` never
 * know which side they read or write. Signed out there is no one list: a
 * page shows the device's own collection (`fromClient(device).x`).
 *
 * - A note on both sides is mid-upload: the device's copy shows until the
 *   device lets go of it, which it does only once the server's reply shows
 *   the copy landed. `where(args)` says which side a note's copy is on; the
 *   rows themselves are the notes as read, so a front matter key of the
 *   same name stays the note's own.
 * - Edits, repairs and deletes go to the copy shown. One that meets the
 *   device copy already gone (the upload let go of it meanwhile) follows
 *   the note to the repository, over the same base: `updateNote` judges
 *   the fields, not the version, so the device's version does no harm.
 * - A note the device lets go of stays shown, as it was, until the
 *   repository answers a listing: the uploader writes through the wire, so
 *   the repository side hears of it a listing later. An editor open on it
 *   never sees it leave. (One deleted from the device elsewhere while the
 *   server is unreachable shows until it is reachable again.)
 * - A new note goes to the repository; when the server cannot be reached
 *   it stays on the device, recorded in the device's outbox to upload. An
 *   app whose notes must never wait on the server (a capture) passes
 *   `createOn: 'device'`: every new note is written to the device and the
 *   outbox, and the uploader moves it.
 *
 * The notes come in placeholder order; a view sorts them its own way, the
 * same signed in as signed out.
 *
 * @example
 * ```ts
 * const todos = oneList(fromClient(device).todos, fromClient(getRepo<Todos>()).todos);
 * ```
 */
import type {
	Client,
	ClientError,
	Collection,
	Contract,
	InvalidNoteOf,
	NoteOf,
	PlaceholdersOf,
	Version,
} from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { compiledContractOf, outboxOf } from '@epicenter/folder/outbox';
import { defineErrors, type InferError } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type { ReactiveNotes } from './client.js';
import { holdLeave } from './leave-guard.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/** Where the copy a row shows lives: still on this device, or in the repository. */
export type Side = 'device' | 'repository';

/** One note collection over both sides, as Svelte state. */
export type OneList<TCollection extends Collection> =
	ReactiveNotes<TCollection> & {
		/** Every note that reads, by placeholders. */
		readonly items: readonly NoteOf<TCollection>[];
		/** The notes that do not read, with their text, by placeholders. */
		readonly invalid: readonly InvalidNoteOf<TCollection>[];
		/** True until both sides have listed once. */
		readonly loading: boolean;
		/** Why the device could not be listed; what it showed before stays. */
		readonly error: Unavailable | null;
		/**
		 * Why the repository could not be listed (offline, or the server
		 * refused); its last listing stays, and new notes wait on the device.
		 */
		readonly repositoryError: Unavailable | null;
		/**
		 * Where the copy shown for the note `args` names is (read or not): still
		 * on this device, or in the repository; undefined when none is shown.
		 */
		where(args: PlaceholdersOf<TCollection>): Side | undefined;
	};

/**
 * A note collection as a view takes it: the device's own signed out
 * (`fromClient(device).x`), or a one list signed in, which also says where
 * each copy is and why the repository could not be listed. Signed out every
 * note is on the device and there is no repository to fail.
 */
export type NoteList<TCollection extends Collection> =
	ReactiveNotes<TCollection> &
		Partial<Pick<OneList<TCollection>, 'where' | 'repositoryError'>>;

/** The client and collection each `fromClient` collection reads, so `oneList` reaches the device's outbox. */
const sources = new WeakMap<
	object,
	{ client: Client<Contract>; name: string }
>();

/** Remember that `collection` is `fromClient(client)[name]`. */
export function rememberSource(
	collection: object,
	source: { client: Client<Contract>; name: string },
) {
	sources.set(collection, source);
}

const log = createLogger('svelte/one-list');

const OneListDiagnostic = defineErrors({
	NotQueued: ({ cause }: { cause: unknown }) => ({
		message:
			'A new note is kept on this device but not queued to upload; the next upload start picks it up',
		cause,
	}),
});

type Entry = Record<string, unknown> & { version: Version };
type Written = Result<unknown, { name: string; current?: unknown }>;

/** The device copy is gone: the note moved to the repository (or was deleted) meanwhile. */
const goneFromDevice = (written: Written) =>
	written.error?.name === 'NotFound' ||
	(written.error?.name === 'Conflict' && written.error.current === null);

/**
 * The collection over `device`, `fromClient(device).x` of a client
 * `openDevice` returned, and `repository`, the same collection of the
 * person's repository (`fromClient(getRepo()).x`). `createOn` is where a
 * new note is written first: the repository (the default), or always the
 * device, recorded in its outbox, so creating never waits on the server.
 */
export function oneList<TCollection extends Collection>(
	device: ReactiveNotes<TCollection>,
	repository: ReactiveNotes<TCollection>,
	{ createOn = 'repository' }: { createOn?: Side } = {},
): OneList<TCollection> {
	type Notes = ReactiveNotes<Collection>;
	const source = sources.get(device);
	if (source === undefined)
		throw new Error(
			'oneList: the device side is fromClient(device).<collection>, of a client openDevice returned',
		);
	const { name } = source;
	const collection = compiledContractOf(source.client).collections.find(
		(compiled) => compiled.name === name,
	);
	if (collection === undefined)
		throw new Error(`oneList: the device's contract has no collection ${name}`);
	const outbox = outboxOf(source.client);
	const { params } = collection.template;
	/** A note's placeholders, as one string: a value never holds `/`. */
	const keyOf = (entry: Record<string, unknown>) =>
		params.map((param) => String(entry[param])).join('/');
	const byKey = (a: Entry, b: Entry) => {
		const [x, y] = [keyOf(a), keyOf(b)];
		return x < y ? -1 : x > y ? 1 : 0;
	};
	const sides = { device, repository } as {
		device: Notes;
		repository: Notes;
	};

	/** The device's notes as last shown, to see which ones it let go of. */
	let lastOnDevice = new Map<string, { row: Entry; invalid: boolean }>();
	/**
	 * Notes the device let go of, shown until the repository answers a
	 * listing after (`since`: what it showed then, and why it could not list).
	 */
	const held = new Map<
		string,
		{ row: Entry; invalid: boolean; since: readonly [unknown, unknown] }
	>();
	/** Notes deleted here from the device: gone for good, not held. */
	const deleted = new Set<string>();

	/** What `merged` last answered, and the side listings it answered for. */
	let last:
		| {
				over: readonly unknown[];
				items: Entry[];
				invalid: Entry[];
				sides: Map<string, Side>;
		  }
		| undefined;

	/**
	 * Both sides as one list, and which side each note's copy is on. Reading
	 * it tracks both sides; it is worked out again only when a side's listing
	 * changed, so a view may ask `where` per row.
	 */
	function merged() {
		const over = [
			sides.device.items,
			sides.device.invalid,
			sides.repository.items,
			sides.repository.invalid,
			sides.repository.error,
		];
		if (last?.over.every((input, at) => input === over[at])) return last;
		const onDevice = [
			...sides.device.items.map((row) => ({ row, invalid: false })),
			...sides.device.invalid.map((row) => ({ row, invalid: true })),
		] as { row: Entry; invalid: boolean }[];
		const deviceKeys = new Set(onDevice.map(({ row }) => keyOf(row)));
		const repositoryItems = sides.repository.items as readonly Entry[];
		const repositoryInvalid = sides.repository.invalid as readonly Entry[];
		const repositoryKeys = new Set(
			[...repositoryItems, ...repositoryInvalid].map(keyOf),
		);
		// A listing that answers replaces one or the other.
		const answered = [repositoryItems, sides.repository.error] as const;
		for (const [key, shown] of lastOnDevice)
			if (
				!deviceKeys.has(key) &&
				!repositoryKeys.has(key) &&
				!deleted.has(key) &&
				!held.has(key)
			)
				held.set(key, { ...shown, since: answered });
		for (const [key, { since }] of held)
			if (
				deviceKeys.has(key) ||
				repositoryKeys.has(key) ||
				since[0] !== answered[0] ||
				since[1] !== answered[1]
			)
				held.delete(key);
		lastOnDevice = new Map(onDevice.map((shown) => [keyOf(shown.row), shown]));
		for (const key of deleted) if (!deviceKeys.has(key)) deleted.delete(key);

		const where = new Map<string, Side>();
		const there = (side: Side) => (row: Entry) => {
			where.set(keyOf(row), side);
			return row;
		};
		const repositoryOnly = (rows: readonly Entry[]) =>
			rows.filter((row) => !deviceKeys.has(keyOf(row)));
		const stillHeld = (invalid: boolean) =>
			[...held.values()]
				.filter((shown) => shown.invalid === invalid)
				.map(({ row }) => row);
		last = {
			over,
			items: [
				...(sides.device.items as readonly Entry[]).map(there('device')),
				...repositoryOnly(repositoryItems).map(there('repository')),
				...stillHeld(false).map(there('repository')),
			].sort(byKey),
			invalid: [
				...(sides.device.invalid as readonly Entry[]).map(there('device')),
				...repositoryOnly(repositoryInvalid).map(there('repository')),
				...stillHeld(true).map(there('repository')),
			].sort(byKey),
			sides: where,
		};
		return last;
	}

	/** The side whose copy shows: the device while it holds one, read or not. */
	const sideOf = (args: Record<string, unknown>): Notes => {
		const key = keyOf(args);
		const onDevice = [...sides.device.items, ...sides.device.invalid].some(
			(row) => keyOf(row) === key,
		);
		return onDevice ? sides.device : sides.repository;
	};

	/**
	 * Write to the copy shown, following the note to the repository when the
	 * device let go of it meanwhile; held for the leave guard throughout.
	 */
	function write<T extends Written>(
		args: Record<string, unknown>,
		to: (notes: Notes) => Promise<T>,
	): Promise<T> {
		const side = sideOf(args);
		return holdLeave(
			to(side).then((written) => {
				if (side === sides.repository || !goneFromDevice(written))
					return written;
				return to(sides.repository);
			}),
		);
	}

	/** Create on the side `createOn` says, else keep it on the device and queue it to upload. */
	async function create(value: Record<string, unknown>) {
		if (createOn === 'repository') {
			const created = await sides.repository.create(value as never);
			if (created.error?.name !== 'Unavailable') return created;
		}
		const kept = await sides.device.create(value as never);
		if (kept.error !== null) return kept;
		const created = kept.data as Entry;
		const queued = await outbox.add({
			id: timeId(),
			files: [
				{
					collection: name,
					...Object.fromEntries(
						params.map((param) => [param, String(created[param])]),
					),
					version: created.version,
				},
			],
		} as never);
		if (queued.error !== null)
			log.warn(OneListDiagnostic.NotQueued({ cause: queued.error }));
		return kept;
	}

	const get = (args: Record<string, unknown>) => {
		const key = keyOf(args);
		return merged().items.find((row) => keyOf(row) === key);
	};

	const list = {
		get items() {
			return merged().items;
		},
		get invalid() {
			return merged().invalid;
		},
		get loading() {
			return sides.device.loading || sides.repository.loading;
		},
		get error() {
			return sides.device.error;
		},
		get repositoryError() {
			return sides.repository.error;
		},
		get,
		where: (args: Record<string, unknown>) => merged().sides.get(keyOf(args)),
		create: (value: Record<string, unknown>) => holdLeave(create(value)),
		update(
			args: Record<string, unknown>,
			patch: Record<string, unknown>,
			options: { base?: Entry } = {},
		) {
			// What the person saw, for whichever side the write lands on.
			const base = options.base ?? get(args);
			return write(args, (notes) =>
				notes.update(
					args as never,
					patch as never,
					(base ? { base } : {}) as never,
				),
			);
		},
		replace(
			args: Record<string, unknown>,
			text: string,
			options: { over?: Version } = {},
		) {
			return write(args, (notes) =>
				notes.replace(args as never, text, options),
			);
		},
		async delete(args: Record<string, unknown>) {
			const key = keyOf(args);
			deleted.add(key);
			const removed = await write(args, (notes) => notes.delete(args as never));
			if (removed.error !== null) deleted.delete(key);
			return removed;
		},
	};
	return list as unknown as OneList<TCollection>;
}
