/**
 * A Svelte 5 reactivity adapter over one opened data handle's declared shape.
 *
 * `fromData(data)` mirrors the declaration exactly: `tables.<name>` and `kv`,
 * with the names and row types the definition declares, plus `persistence`.
 * Same verbs, same types, same names. Every read is reactive and every write
 * passes through unchanged.
 *
 * **A table is held. Everything else is read through.** A row is CRDT structs
 * until somebody builds a plain object out of it, and building one costs about
 * two microseconds, so reading ten thousand of them to learn that one moved
 * costs twenty milliseconds. A table is therefore a live projection keyed by
 * row id: seeded when this is called, patched with the ids each commit names,
 * read from thereafter. `kv` is ten keys and `persistence` is one enum, so
 * both stay read-through. The rule is "hold what is expensive to rebuild", and
 * it says no twice as often as it says yes.
 *
 * **A `SvelteMap` IS the signal for a table.** Reading one key tracks that
 * key; iterating tracks all of them. So a list wakes on any change and a
 * component reading one row wakes only for that row, with no signal in the
 * store beyond the ids it already had. `kv` and `persistence` use
 * `createSubscriber` instead, because there is nothing keyed to track.
 *
 * **A row's `content` node is not made reactive here, deliberately.** It
 * carries its own field-scoped `subscribe` (ADR-0296): an editor binds the
 * type directly and hears every keystroke without a table signal in the path.
 * `fromSubscription` is how an application reads a value off one.
 *
 * **Eager, because it cannot be lazy.** An application reads `rows` inside
 * `$derived`, and writing Svelte state from there is `state_unsafe_mutation`,
 * so a projection filled on first read is not available. `fromData` walks each
 * declared table once when it is called.
 *
 * **Never torn down.** Ref-counting a projection to its readers leaves the
 * object alive and the updates stopped, which serves the next reader rows from
 * before it looked away. Stale is worse than absent, so the subscription is
 * held for the life of the wrapper and dies with the document it mirrors.
 * There is nothing to dispose: the raw runtime still owns opening, sync
 * attachment, and disposal, and network operations stay on the raw plane on
 * purpose, because a reactive wrapper must not pretend a reconnect is local
 * state.
 *
 * One instance per opened store, made by the shell that mounts over it, so an
 * application never calls this itself and never calls it twice. The shell is
 * the right owner because it mounts exactly once per opened store: a different
 * principal is a different session, a different shell, and a different call
 * (ADR-0350).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   const honeycrisp = fromData(data);
 *   const notes = honeycrisp.tables.notes;
 *   const active = $derived(notes.rows.filter((n) => n.deletedAt === null));
 * </script>
 * <button onclick={() => notes.create({ title: '' })}>New</button>
 * {#each active as note (note.id)}...{/each}
 * ```
 */

import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';

/**
 * The slice of `@epicenter/data`'s `TableHandle` this adapter touches: the
 * read verbs it makes reactive, and the invalidation feed it rides.
 *
 * Structural rather than imported, and that is a variance requirement, not a
 * dropped dependency edge. A typed handle narrows `create` and `update` to
 * the table's own input type, so it is not assignable to the untyped
 * `TableHandle`; constraining on the shared read surface accepts every typed
 * handle while `ReactiveTable<TTable>` preserves the caller's exact type.
 *
 * **Every reactive read verb is here.** `create`, `update`, `delete`, `watch` and
 * `subscribe` pass through the spread untouched; they are writes or their own
 * feeds. The row's live `content` node is intentionally a direct row property,
 * not a second table read surface.
 */
type AdaptableTable = {
	readonly rows: unknown[];
	/**
	 * Typed down to the id, because the projection holds these too.
	 *
	 * The one member this adapter reads off a row it cannot read, and the one
	 * every `NonconformingRow` has whatever failed on it: the structural id is
	 * not a declared field and cannot fail.
	 */
	readonly nonconforming: readonly { readonly id: string }[];
	ids(): string[];
	get(rowId: string): unknown;
	subscribe(listener: (rowIds: readonly string[]) => void): () => void;
	watch(type: never, listener: () => void): () => void;
};

/** The slice of `KvHandle` the adapter touches: its reads, and one feed. */
type AdaptableKv = {
	get(key: never): unknown;
	readonly nonconforming: unknown[];
	subscribe(listener: () => void): () => void;
};

/**
 * The persistence status feed: a read and the signal that invalidates it.
 *
 * Structural like the rest, and a SLICE: `flush()` is not named here because
 * this adapter does not touch it, and `ReactiveData` hands back the caller's
 * own type, so it survives.
 */
type AdaptablePersistence = {
	get(): unknown;
	subscribe(listener: () => void): () => void;
};

/**
 * What `fromData` needs from opened data: the declared view, plus the one
 * store capability that is shaped like one.
 *
 * `persistence` is the single thing here that is not the declaration. It earns
 * the exception the same way tables and kv do: a `get()` and a `subscribe()`
 * that already dedupes by value, reporting local state about this document.
 * Every application that renders it would otherwise hand-roll the identical
 * `$state.raw` plus `$effect`, which is the definition of a missing adapter
 * property rather than a pattern to teach.
 *
 * The boundary that stays is the one about MEANING, not about ownership: sync
 * is a fact about a socket somewhere else, and its status is a pull-only
 * getter that a consumer has to poll, so this adapter cannot hold it honestly
 * and does not pretend to.
 */
export type AdaptableData = {
	tables: Record<string, AdaptableTable>;
	kv: AdaptableKv;
	transact<TResult>(run: () => TResult): TResult;
	persistence: AdaptablePersistence;
};

/**
 * One opened store, awake.
 *
 * The SAME type, plus a brand. It used to be four members picked out of the
 * store (`tables`, `kv`, `transact`, `persistence`), and the narrowing was the
 * reason a route had to hand the store around twice: everything else a person
 * is shown lives on the other members, and the address the folder verbs need
 * lives there too. Preserving the type is what lets one object be handed once.
 *
 * The brand is what the four members used to carry implicitly: whether reads
 * track. Without it `fromData(fromData(x))` compiles, and so does a `$derived`
 * over a RAW store's `rows`, which computes once at mount and never again.
 * `ReactiveAuthClient` next door is branded for exactly this reason.
 */
export type ReactiveData<TData extends AdaptableData> = TData &
	Brand<'ReactiveData'>;

/**
 * Adapt one opened store's reads into Svelte reactivity, and hand back the
 * store.
 *
 * Every member passes through by descriptor and three are overridden. The
 * pass-through is not tidiness: `sync` is looked up in a `WeakMap` keyed by the
 * capability OBJECT, so re-wrapping it would make `sync.status()` answer
 * `undefined` forever, and the address the folder verbs read would go with it.
 *
 * One `defineProperties` on a fresh object rather than a copy then an
 * overwrite, because descriptors copied from a frozen store arrive
 * `configurable: false` and could not be overridden afterwards.
 */
export function fromData<TData extends AdaptableData>(
	data: TData,
): ReactiveData<TData> {
	return Object.freeze(
		Object.defineProperties({} as TData, {
			...Object.getOwnPropertyDescriptors(data),
			tables: {
				enumerable: true,
				value: Object.freeze(
					Object.fromEntries(
						Object.entries(data.tables).map(([name, table]) => [
							name,
							reactiveTable(table),
						]),
					),
				),
			},
			kv: { enumerable: true, value: reactiveKv(data.kv) },
			persistence: {
				enumerable: true,
				value: reactivePersistence(data.persistence),
			},
		}),
	) as ReactiveData<TData>;
}

/**
 * One persistence capability, `get()` reactive.
 *
 * The store notifies only on a CHANGE (`persistence.ts` compares against the
 * last status before telling anyone), so a thousand failed flushes in a row
 * wake a reader once. That is what makes rendering the status directly
 * cheaper than reacting to it: there is no event stream to debounce, only a
 * value to display.
 */
function reactivePersistence<TPersistence extends AdaptablePersistence>(
	persistence: TPersistence,
): TPersistence {
	const subscribe = createSubscriber((update) => persistence.subscribe(update));
	// Descriptors for the same reason a table needs them, and it is not
	// hypothetical here either: a capability may carry getters, and a spread
	// would invoke them at wrap time.
	return Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(persistence),
				get: {
					enumerable: true,
					value: () => {
						subscribe();
						return persistence.get();
					},
				},
			},
		),
	) as TPersistence;
}

/**
 * One table, held as a live projection of its rows.
 *
 * A row is CRDT structs until somebody builds a plain object out of it, and
 * building one costs about two microseconds. Reading `rows` builds every one
 * of them, so a list over ten thousand notes pays twenty milliseconds to
 * discover that one note moved. This holds what it built and rebuilds only
 * what the commit named.
 *
 * **Seeded here, never during a read.** An application reads `rows` inside
 * `$derived`, and writing Svelte state from there is `state_unsafe_mutation`.
 * Filling the map lazily on first read is therefore not available, which is
 * why this is eager and why `fromData` is no longer free to call.
 *
 * **Never torn down.** The subscription is held for the life of the wrapper
 * rather than ref-counted to readers, because a projection that stops being
 * maintained is stale rather than free: the object survives, the updates stop,
 * and the next reader is served rows from before it looked away. It dies with
 * the document it mirrors, which is the only lifetime that fits a cache.
 *
 * A `SvelteMap` rather than a plain one, and that is the reactivity: reading a
 * key tracks that key, iterating tracks all of them, so a list wakes on any
 * change while a component reading one row wakes only for that row. Nothing
 * here calls `createSubscriber`; the map IS the signal.
 *
 * **`nonconforming` is held beside `rows`, not passed through.** It used to
 * be forwarded as the handle's own getter, which reads CRDT state and touches
 * no signal, so a `$derived` over it was computed once at mount and never
 * again. That was survivable while the only reader was an empty-state count.
 * It is not survivable now: a push from the folder validates nothing
 * (ADR-0338), so an ordinary edit moves a row between the two sets and both
 * are on screen. One commit, one handler, both maps.
 *
 * The second map is filled only from the commits that empty a row out of
 * `rows`, and it conforms the table once per such commit rather than once per
 * id. A row leaving the readable projection is the rare case: a delete, or an
 * edit that broke it.
 */
function reactiveTable<TTable extends AdaptableTable>(table: TTable): TTable {
	const rows = new SvelteMap<string, unknown>();
	const unreadable = new SvelteMap<string, { readonly id: string }>();
	for (const rowId of table.ids()) {
		const row = table.get(rowId);
		if (row !== undefined) rows.set(rowId, row);
	}
	for (const row of table.nonconforming) unreadable.set(row.id, row);

	table.subscribe((rowIds) => {
		// Conformed at most once for the whole commit, and only if something
		// left `rows`: `get` collapses "no row here" and "a row this release
		// cannot read" (ADR-0125), so telling them apart costs one pass and is
		// worth paying only in the branch where one of the two happened.
		let cannotRead: Map<string, { readonly id: string }> | undefined;
		for (const rowId of rowIds) {
			const row = table.get(rowId);
			if (row !== undefined) {
				rows.set(rowId, row);
				unreadable.delete(rowId);
				continue;
			}
			rows.delete(rowId);
			cannotRead ??= new Map(table.nonconforming.map((one) => [one.id, one]));
			const raw = cannotRead.get(rowId);
			if (raw === undefined) unreadable.delete(rowId);
			else unreadable.set(rowId, raw);
		}
	});

	// Descriptors, not a spread. `rows` and `nonconforming` are GETTERS on the
	// handle, and `{ ...table }` would invoke them: wrapping a table would walk
	// every row once, before anything had read anything.
	return Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(table),
				rows: {
					enumerable: true,
					get() {
						return [...rows.values()];
					},
				},
				get: {
					enumerable: true,
					value: (rowId: string) => rows.get(rowId),
				},
				nonconforming: {
					enumerable: true,
					get() {
						return [...unreadable.values()];
					},
				},
			},
		),
	) as TTable;
}

function reactiveKv<TKv extends AdaptableKv>(kv: TKv): TKv {
	// Read through, unlike a table, and the rule is the same one: hold what is
	// expensive to rebuild. Ten keys and ten validations is not, so there is
	// nothing here to hold, nothing to keep current, and no `keys()` verb the
	// handle would have to grow so this could seed itself.
	const subscribe = createSubscriber((update) => kv.subscribe(update));
	// Descriptors for the same reason a table needs them: `nonconforming` is a
	// getter, and a spread would invoke it.
	return Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(kv),
				get: {
					enumerable: true,
					value: (key: never) => {
						subscribe();
						return kv.get(key);
					},
				},
				nonconforming: {
					enumerable: true,
					get() {
						subscribe();
						return kv.nonconforming;
					},
				},
			},
		),
	) as TKv;
}
