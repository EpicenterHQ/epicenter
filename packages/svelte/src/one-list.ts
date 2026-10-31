/**
 * `oneList`: one note collection as a person sees it in an app that keeps
 * notes on this device and, signed in, in their repository (decision 12).
 * The notes still on the device ("not uploaded yet") and the repository's,
 * by placeholders, as one `ReactiveNotes`, so views and `fieldEdit` never
 * know which side they read or write.
 *
 * - A note on both sides is mid-upload: the device's copy shows until the
 *   device lets go of it, which it does only once the server's reply shows
 *   the copy landed. Each row says where its copy is (`where`).
 * - Edits, repairs and deletes go to the copy shown. One that meets the
 *   device copy already gone (the upload let go of it meanwhile) follows
 *   the note to the repository, over the same base: `updateNote` judges
 *   the fields, not the version, so the device's version does no harm.
 * - A note the device lets go of stays shown, as it was, until the
 *   repository answers a listing: the uploader writes through the wire, so
 *   the repository side hears of it a listing later. An editor open on it
 *   never sees it leave. (One deleted from the device elsewhere while the
 *   server is unreachable shows until it is reachable again.)
 * - A new note goes to the repository when there is one; when the server
 *   cannot be reached, or signed out, it stays on the device, recorded in
 *   the device's outbox to upload. An app whose notes must never wait on
 *   the server (a capture) passes `createOn: 'device'`: every new note is
 *   written to the device and the outbox, and the uploader moves it.
 *
 * @example
 * ```ts
 * const todos = oneList(contract, 'todos', {
 * 	device: fromClient(device).todos,
 * 	repository: account ? fromClient(openRemote(contract, { account })).todos : null,
 * 	outbox: outboxOf(device),
 * });
 * ```
 */
import {
	type ClientError,
	type Collection,
	type Contract,
	compileTemplate,
	type InvalidNoteOf,
	type NoteOf,
	type PlaceholdersOf,
	type Version,
} from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { defineErrors, type InferError } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type { ReactiveNotes } from './client.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/** Where the copy a row shows lives: still on this device, or in the repository. */
export type Side = 'device' | 'repository';

/** A note as the list shows it, with where its copy is. */
export type ListedNote<TCollection extends Collection> = NoteOf<TCollection> & {
	where: Side;
};

/** A note at one of the collection's paths that does not read, with where it is. */
export type ListedInvalid<TCollection extends Collection> =
	InvalidNoteOf<TCollection> & { where: Side };

/** One note collection over both sides, as Svelte state. */
export type OneList<TCollection extends Collection> = Omit<
	ReactiveNotes<TCollection>,
	'items' | 'invalid' | 'get'
> & {
	/** Every note that reads, in `order`. */
	readonly items: readonly ListedNote<TCollection>[];
	/** The notes that do not read, with their text, by placeholders. */
	readonly invalid: readonly ListedInvalid<TCollection>[];
	/** True until both sides have listed once. */
	readonly loading: boolean;
	/** Why the device could not be listed; what it showed before stays. */
	readonly error: Unavailable | null;
	/**
	 * Why the repository could not be listed (offline, or the server
	 * refused); its last listing stays, and new notes wait on the device.
	 */
	readonly repositoryError: Unavailable | null;
	get(args: PlaceholdersOf<TCollection>): ListedNote<TCollection> | undefined;
};

/** What `oneList` needs of the device's outbox (`outboxOf(device)`): recording a capture. */
export type CaptureQueue = {
	add(capture: {
		id: string;
		files: ({ collection: string; version: Version } & Record<
			string,
			string
		>)[];
	}): Promise<Result<unknown, { name: string; message: string }>>;
};

/** The names of a contract's note collections. */
type NoteCollectionName<TContract extends Contract> = {
	[K in keyof TContract['collections'] &
		string]: TContract['collections'][K]['path'] extends `${string}.md`
		? K
		: never;
}[keyof TContract['collections'] & string];

const log = createLogger('svelte/one-list');

const OneListDiagnostic = defineErrors({
	NotQueued: ({ cause }: { cause: unknown }) => ({
		message:
			'A new note is kept on this device but not queued to upload; the next upload start picks it up',
		cause,
	}),
});

type Entry = Record<string, unknown> & { version: Version };
type Row = Entry & { where: Side };
type Written = Result<unknown, { name: string; current?: unknown }>;

/** The device copy is gone: the note moved to the repository (or was deleted) meanwhile. */
const goneFromDevice = (written: Written) =>
	written.error?.name === 'NotFound' ||
	(written.error?.name === 'Conflict' && written.error.current === null);

/**
 * The collection `name` of `contract` over `device` (this browser's files,
 * or a desktop folder) and `repository` (null signed out, and wherever
 * Epicenter syncs the folder instead). `outbox` is the device's when its new
 * notes upload, else null. `order` sorts the notes that read; by default
 * they sort by placeholders. `createOn` is where a new note is written
 * first: the repository when there is one (the default), or always the
 * device, recorded in `outbox`, so creating never waits on the server.
 */
export function oneList<
	TContract extends Contract,
	TName extends NoteCollectionName<TContract>,
>(
	contract: TContract,
	name: TName,
	{
		device,
		repository,
		outbox = null,
		order,
		createOn = 'repository',
	}: {
		device: ReactiveNotes<TContract['collections'][TName]>;
		repository: ReactiveNotes<TContract['collections'][TName]> | null;
		outbox?: CaptureQueue | null;
		order?: (
			a: ListedNote<TContract['collections'][TName]>,
			b: ListedNote<TContract['collections'][TName]>,
		) => number;
		createOn?: Side;
	},
): OneList<TContract['collections'][TName]> {
	type Notes = ReactiveNotes<Collection>;
	const template = compileTemplate(
		(contract.collections[name] as Collection).path,
	);
	if (template.error !== null) throw new Error(template.error.message);
	const { params } = template.data;
	/** A note's placeholders, as one string: a value never holds `/`. */
	const keyOf = (entry: Record<string, unknown>) =>
		params.map((param) => String(entry[param])).join('/');
	const byKey = (a: Entry, b: Entry) => {
		const [x, y] = [keyOf(a), keyOf(b)];
		return x < y ? -1 : x > y ? 1 : 0;
	};
	const sort = (order as ((a: Row, b: Row) => number) | undefined) ?? byKey;
	const sides = { device, repository } as {
		device: Notes;
		repository: Notes | null;
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

	function merged() {
		const onDevice = [
			...sides.device.items.map((row) => ({ row, invalid: false })),
			...sides.device.invalid.map((row) => ({ row, invalid: true })),
		] as { row: Entry; invalid: boolean }[];
		const deviceKeys = new Set(onDevice.map(({ row }) => keyOf(row)));
		const repositoryItems = (sides.repository?.items ?? []) as readonly Entry[];
		const repositoryInvalid = (sides.repository?.invalid ??
			[]) as readonly Entry[];
		const repositoryKeys = new Set(
			[...repositoryItems, ...repositoryInvalid].map(keyOf),
		);
		if (sides.repository !== null) {
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
		}
		lastOnDevice = new Map(onDevice.map((shown) => [keyOf(shown.row), shown]));
		for (const key of deleted) if (!deviceKeys.has(key)) deleted.delete(key);

		const there = (side: Side) => (row: Entry) => ({ ...row, where: side });
		const repositoryOnly = (rows: readonly Entry[]) =>
			rows.filter((row) => !deviceKeys.has(keyOf(row)));
		const stillHeld = (invalid: boolean) =>
			[...held.values()]
				.filter((shown) => shown.invalid === invalid)
				.map(({ row }) => row);
		return {
			items: [
				...(sides.device.items as readonly Entry[]).map(there('device')),
				...repositoryOnly(repositoryItems).map(there('repository')),
				...stillHeld(false).map(there('repository')),
			].sort(sort),
			invalid: [
				...(sides.device.invalid as readonly Entry[]).map(there('device')),
				...repositoryOnly(repositoryInvalid).map(there('repository')),
				...stillHeld(true).map(there('repository')),
			].sort(byKey),
		};
	}

	/** The side whose copy shows: the device while it holds one, read or not. */
	const sideOf = (args: Record<string, unknown>): Notes => {
		if (sides.repository === null) return sides.device;
		const key = keyOf(args);
		const onDevice = [...sides.device.items, ...sides.device.invalid].some(
			(row) => keyOf(row) === key,
		);
		return onDevice ? sides.device : sides.repository;
	};

	/** Write to the copy shown, following the note to the repository when the device let go of it meanwhile. */
	async function write<T extends Written>(
		args: Record<string, unknown>,
		to: (notes: Notes) => Promise<T>,
	): Promise<T> {
		const side = sideOf(args);
		const written = await to(side);
		if (side === sides.repository || sides.repository === null) return written;
		if (!goneFromDevice(written)) return written;
		return to(sides.repository);
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
			return sides.device.loading || (sides.repository?.loading ?? false);
		},
		get error() {
			return sides.device.error;
		},
		get repositoryError() {
			return sides.repository?.error ?? null;
		},
		get,
		async create(value: Record<string, unknown>) {
			if (sides.repository !== null && createOn === 'repository') {
				const created = await sides.repository.create(value as never);
				if (created.error?.name !== 'Unavailable') return created;
			}
			const kept = await sides.device.create(value as never);
			if (kept.error !== null || outbox === null) return kept;
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
			});
			if (queued.error !== null)
				log.warn(OneListDiagnostic.NotQueued({ cause: queued.error }));
			return kept;
		},
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
	return list as unknown as OneList<TContract['collections'][TName]>;
}
