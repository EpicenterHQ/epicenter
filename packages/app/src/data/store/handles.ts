/**
 * What an application holds: a row, a table, a KV, and the view over both.
 *
 * All declaration and no engine, which is why it is its own file. `store.ts`
 * builds these; nothing here knows how.
 *
 * The shapes here are the LENS. `RowOf` and friends come from the declaration
 * (`@epicenter/app/definition`); what this file adds is the verbs, and the
 * rule that decides which verbs exist: a read is what this release's
 * declaration can see, and a write is what it may say.
 */

import type {
	ConformanceIssue,
	CreateRowOf,
	DataDefinition,
	JsonObject,
	KvOf,
	ParsedDataDefinition,
	RowOf,
	TableDeclaration,
} from '@epicenter/app/definition';
import type { AccountIdentity, PrincipalId } from '@epicenter/principal';
import type { SocketTransport } from '@epicenter/sync/transport';
import type * as Y from '@y/y';
import type { Result } from 'wellcrafted/result';

import type { SyncConnectionStatus } from '../sync/connection.js';
import type { NonconformingRow, RowAbsentError } from './errors.js';
import type { PersistenceCapability } from './persistence.js';

/** One row's identity and value snapshot. */
export type Row = { id: string } & JsonObject;

/** Faithful stored values and the live body, used only by file operations. */
export type RowFile = {
	id: string;
	fields: JsonObject;
	body: Y.Node | undefined;
};

/**
 * What a table's subscriber is handed: the rows this commit touched.
 *
 * A list may ignore it. A projection keyed by row id cannot, which is the
 * reason it exists.
 */
export type TableListener = (rowIds: readonly string[]) => void;

export type TableHandle<
	TRow = Row,
	TInput = JsonObject,
	TPatch = JsonObject,
> = {
	/**
	 * Bring one row into being, at a minted id.
	 *
	 * There is no door for a chosen id, and that is a correctness decision. A row
	 * is a nested container addressed by the struct that created it, so two
	 * devices creating one address produce two containers and map LWW discards
	 * one along with every field in it. A 24-character minted id makes that
	 * unreachable rather than merely unlikely. Anything an application wants to
	 * name goes in `kv`, which lives at a name-addressed root.
	 *
	 * An optional fresh body is integrated in the creation transaction. Omit it
	 * to mint an empty body. An already integrated node is refused because sharing
	 * it between rows would couple their edits and deletion.
	 *
	 * Returns the stored value snapshot. The declaration remains a read lens:
	 * `get` reports whether those values conform. Reserved field names and live
	 * nodes passed as values are refused before the row is created.
	 */
	create(fields: TInput, body?: Y.Node): TRow;
	/**
	 * One row, whole, or nothing.
	 *
	 * `undefined` covers both "no row at this address" and "a row this
	 * declaration cannot read", and collapsing them is deliberate: a caller
	 * asking about one row does the same thing with either answer, and no
	 * consumer in this repo ever branched on the difference. A row that does
	 * not conform is not hidden by that, it is on `nonconforming` with its raw
	 * values, which is where a repair is composed (ADR-0125) and where all
	 * three applications that care already look.
	 *
	 * No `Result`, and that is what the collapse bought. The error arm carried
	 * one variant nobody read, so every call site paid an unwrap for it;
	 * Honeycrisp had written `table.rows.find(...)` by hand rather than use
	 * this verb.
	 *
	 * The result is a serializable value snapshot. Use `body(rowId)` separately
	 * for live collaborative editing state.
	 */
	get(rowId: string): TRow | undefined;
	/** The existing live body, even when the row's values do not conform. Reading never creates it. */
	body(rowId: string): Y.Node | undefined;
	/**
	 * Merge fields into an existing row. Refuses an absent address.
	 *
	 * `update` rather than `set`, because only the fields handed in are touched
	 * and every other field is left alone. `Ok` reports the write and nothing
	 * more: what the row now reads as is `get`'s answer, because a patch may
	 * legally land on a row whose OTHER fields this declaration cannot read (that is
	 * how a nonconforming row is repaired, ADR-0125), and a write verb that
	 * reported that read as its own failure punished a write that committed.
	 */
	update(rowId: string, fields: TPatch): Result<void, RowAbsentError>;
	/**
	 * Take one row off the table, its body node and all (ADR-0295).
	 *
	 * One removal in one document. Deleting the row's nested type reclaims
	 * every value attribute and the body node's subtree with it, so there
	 * is no second address to retire and no crash point between two halves.
	 *
	 * Returns nothing: deleting an address that holds no row is a no-op fact
	 * rather than an outcome a caller acts on, and every consumer said so by
	 * discarding the boolean this used to report.
	 */
	delete(rowId: string): void;
	/**
	 * Every row id, sorted, without conforming any of them.
	 *
	 * The cheap way to name what is here. `rows.length` answers the same
	 * question by walking every row through the declaration, which is the right
	 * answer for a surface that wants the rows and the wrong one for anything
	 * that only wants to know which ids exist.
	 *
	 * Two callers today: `evidence/`, which measures the store without paying
	 * for conformance, and `@epicenter/svelte`'s adapter, which seeds its
	 * projection from ids and point reads so that a later commit can rebuild
	 * one row rather than all of them.
	 */
	ids(): string[];
	/**
	 * Value snapshots for every row this declaration can read.
	 *
	 * A member rather than a nested list result, because every consumer destructured
	 * that tuple and three applications then re-exposed each half as its own
	 * getter. This is the shape they were all rebuilding.
	 */
	readonly rows: TRow[];
	/**
	 * Every row stored here that this declaration cannot read, with its raw
	 * values (ADR-0125).
	 *
	 * Reported rather than dropped or repaired, and reachable for WRITES:
	 * Honeycrisp walks this to re-parent notes out of a folder it is deleting,
	 * so a row it cannot read is not a row it can orphan.
	 */
	readonly nonconforming: NonconformingRow[];
	/**
	 * Hear when this table's SHAPE changes: a row added, a row removed, or a
	 * row's values edited.
	 *
	 * NOT an edit inside a row's body node. The body node is nested on its row
	 * (ADR-0295), so counting it here would wake every list in the application
	 * on every keystroke; `watch` below is the signal for that, scoped to
	 * the one type. The store decides by depth against the table root, so the
	 * invalidation stays a superset of what changed (ADR-0187) without being
	 * the whole document.
	 *
	 * It names the rows the commit touched, and a caller may ignore them: a
	 * re-read with `rows` walks a document already in memory and is always
	 * correct. What the ids buy is the caller that holds a projection of the
	 * rows and wants to rebuild only what moved, which is the difference
	 * between work proportional to the change and work proportional to the
	 * table.
	 *
	 * The ids come from the table root's own `'delta'`, whose `attrs` is keyed
	 * by the attribute that changed, and a row IS an attribute on the root
	 * (`evidence/delta-names-the-row.test.ts`). The listener is attached with
	 * the first subscriber and dropped with the last, so a table nobody watches
	 * names nothing.
	 *
	 * Fires after the commit is accepted, on the same flush as KV's and after
	 * `onCommitted`, so a composed follower is dirty before any subscriber
	 */
	subscribe(listener: TableListener): () => void;
	/**
	 * Hear edits to ONE live type of this table, local or remote.
	 *
	 * Takes the type rather than an address, because the caller is already
	 * holding it: `body(id)` returns the live node, and rendering it
	 * needs the type anyway. Naming an address instead looked the same object
	 * up a second time and could disagree with the first, handing back a dead
	 * subscription for a row deleted in between.
	 *
	 * It is on the table because that is where the caller got the type. Every
	 * call site reads `table.body(id)` and watches what it read, so the
	 * verb anywhere else costs a second noun at every one of them. Delivery is
	 * keyed by the type's own identity and does not consult the table, so
	 * another table's type is accepted here and does exactly what it says. That
	 * is the price of the one-noun call site, paid deliberately.
	 *
	 * The scope is the whole reason it exists: the store writes no derived
	 * fields (ADR-0297), so an application hangs its own write on an edit, and
	 * a row-scoped signal would fire on the write it caused. It is also the
	 * only way to hear a body's structure, because `subscribe` above reports this table's
	 * shape and deliberately not an edit inside a field.
	 *
	 * Fires once per commit, on the same flush every other subscriber's
	 * notification goes out on and AFTER all of them, so a listener that writes
	 * is writing against a settled commit. That ordering is the whole service:
	 * the type's own `on('delta')` fires mid-acceptance, and a write from there
	 * would re-enter the transaction being accepted.
	 */
	watch(type: Y.Node, listener: () => void): () => void;
};

/** One table, with its own declaration's row and create-input types. */
export type TypedTableHandle<TFields extends TableDeclaration> = TableHandle<
	RowOf<TFields>,
	CreateRowOf<TFields>,
	Partial<Pick<RowOf<TFields>, Exclude<keyof RowOf<TFields>, 'id'>>>
>;

/**
 * What this release's data definition can see of one store.
 *
 * Named for the declaration rather than for the word `view`, because
 * `DataView` is a global: the ArrayBuffer one, which this package's own
 * `frames.ts` constructs. A file that used the type and forgot the import
 * typechecked against the wrong `DataView` and said nothing.
 *
 * `tables` is a container rather than a spread, and that is the whole reason
 * the application has no reserved table names. A definition declares `tables`
 * and `kv`, so the view mirrors the declaration instead of flattening it, and
 * every verb the store grows is free to be a sibling forever. Flattening cost
 * this API three collisions in its first month: a draft that named the bound
 * value `notes` beside a table called `notes`, `query` reserved as a table name
 * (ADR-0213), and a `$store` sigil invented to hold nine more (ADR-0229).
 */
export type DeclaredData<TDatabase extends DataDefinition> = {
	readonly tables: {
		readonly [K in keyof TDatabase['tables']]: TypedTableHandle<
			TDatabase['tables'][K]
		>;
	};
	readonly kv: KvHandle<KvOf<TDatabase>>;
	/**
	 * Group direct data operations into one accepted and durable transaction.
	 *
	 * One commit, so one durable append and one notification per table it
	 * touched. Deleting a folder that re-parents fifty notes is one commit
	 * rather than fifty-one.
	 *
	 * It is HERE rather than on the store because grouping writes is what an
	 * APPLICATION does, and `tables` and `kv` are the writes it groups. On the
	 * store it was reachable only by a caller that also held the transport's
	 * verbs, so the reference application, which narrows to this view, could
	 * not reach it at all and paid a commit per row instead.
	 */
	transact<TResult>(run: () => TResult): TResult;
};

/**
 * One application's stored state, by root, with no declaration applied.
 *
 * Every table root the document actually holds, whether or not this release
 * declares it, and every kv key the same way. Values are `JsonObject` because
 * nothing has interpreted them: this is what is there, not what reads.
 */
export type StoredData = {
	readonly tables: ReadonlyMap<string, ReadonlyMap<string, JsonObject>>;
	readonly kv: JsonObject;
};

/**
 * One application's opened data: everything it holds, on one object.
 *
 * A view of its definition, intersected with what its document can do. There
 * used to be a `store` key here, and the split it drew was by audience:
 * `tables` and `kv` for an application, `store` for a transport and an
 * exporter. The audience distinction is real; the OBJECT was the wrong place
 * to carry it.
 *
 * What carries it instead is the narrowing type an application already writes:
 *
 * ```ts
 * type HoneycrispData = DeclaredData<typeof honeycrispDefinition>;
 * ```
 *
 * That is per-app, costs nothing at runtime, and is where this repository
 * actually enforces "a feature does not touch the document". Every consumer
 * does it.
 *
 * There is no `DataOf<TDefinition, TDocument>` either. It took a second type
 * argument that only ever held one of three values, and its default failed
 * UPWARD: a caller who omitted it got the replica kind, so code that only
 * works against an authority typechecked against a local document. The three
 * values have names now, and a call site says which one it means.
 *
 * An opener composes one by spreading the two halves together. Object spread
 * copies own enumerable SYMBOL keys, which is what carries `asyncDispose`
 * across without anyone forwarding it by hand.
 */
export type Data<TDatabase extends DataDefinition> = DeclaredData<TDatabase> &
	DataDocument &
	AsyncDisposable;

/**
 * A store an application holds, which it cannot close.
 *
 * The one thing this does NOT have that `Data` does is `Symbol.asyncDispose`,
 * and the asymmetry is the point. Opening a replica acquires three things: the
 * document and its Web Lock, a sync connection, and a page-hide listener. The
 * document's own disposal frees one of them, so a caller who called it left a
 * connection running against a store whose every verb throws. What ends a
 * replica is the closer its opener returns, which holds all three (ADR-0340).
 *
 * `Data` keeps the symbol because the memory and SQLite constructors acquire
 * one thing and a test disposes exactly that.
 */
export type ReplicaData<TDatabase extends DataDefinition> =
	DeclaredData<TDatabase> & ReplicaDocument;

/**
 * One application's KV: the values it keeps exactly one of.
 *
 * No id and no create, because there is exactly one and it always exists. A
 * A missing key is a conformance error. Applications decide whether and how
 * to recover it after `get()` returns.
 *
 * It lives at a reserved ROOT rather than in a table, and that is a correctness
 * decision rather than a convenience. A root is addressed by its name, so two
 * devices writing settings on their own boot paths converge; a chosen row id is
 * a nested container, and two devices creating one produce two containers of
 * which map LWW keeps one, discarding the other's values entirely.
 */
export type KvHandle<TValues = JsonObject> = {
	/**
	 * One key's value, or nothing.
	 *
	 * The same read law a table's `get` follows, and now the same shape:
	 * `undefined` covers "never written", "written as something this
	 * declaration cannot read", and "not a key this declaration names". A
	 * caller falls back the same way for all three, which is why they are not
	 * told apart.
	 *
	 * One key's work, not the object's. It reads that attribute and checks it
	 * against that field, so conformance is per KEY in the work as well as in
	 * the answer: one unreadable setting costs that setting and not the object
	 * around it. `nonconforming` is the verb that conforms everything, because
	 * reporting every key it cannot read is what it is for.
	 *
	 * It used to return the whole object as a `Result`, with the diagnostic
	 * carrying whatever conformed, and both consumers wrote the same recovery
	 * by hand: `{ ...APPLICATION_DEFAULTS, ...error.conforming }`, once in
	 * Vocab and once in Whispering, which then exposed a per-key getter over
	 * the top of it. That composition is now the line you would write anyway:
	 *
	 * ```ts
	 * kv.get('theme') ?? APPLICATION_DEFAULTS.theme
	 * ```
	 *
	 * The default stays in the application. A default declared in the
	 * definition would be a value nothing stored, so `stored()` and the export
	 * would not carry it and two releases could disagree about what is there
	 * with no write between them (ADR-0255).
	 */
	get<TKey extends keyof TValues & string>(
		key: TKey,
	): TValues[TKey] | undefined;
	/**
	 * Every declared key this release cannot read, with what is stored there.
	 *
	 * The mirror of a table's `nonconforming`, for the same reason: a value
	 * this declaration refuses is a fact about the KV, reported rather than
	 * dropped or repaired (ADR-0125). A surface that wants to say "3 settings
	 * could not be read" reads this; a surface that wants a value calls `get`
	 * and falls back.
	 */
	readonly nonconforming: ConformanceIssue[];
	/**
	 * Merge some keys. Every other key is left alone.
	 *
	 * `update` rather than `set` for the same reason a table's is: only the keys
	 * handed in are touched, and `set` promises replacement. `Ok` reports the
	 * write; what KV now reads as is `get`'s answer, on the same reasoning as a
	 * table's `update`.
	 */
	update(values: Partial<TValues>): void;
	/**
	 * Hear when any declared key changes, whoever changed it.
	 *
	 * A ping, and "something here moved, re-read" is the complete message. It
	 * carries nothing, unlike a table's, and the difference is the size rather
	 * than the kind: naming which of ten keys moved saves a caller ten property
	 * accesses on a document already in memory, so it would be machinery in
	 * exchange for nothing.
	 *
	 * Fires after the commit is durable, on the same flush as a table's, so a
	 * listener observes one settled commit, and a composed follower that marks
	 * itself dirty in `onCommitted` is already dirty here; see `subscribe` on
	 * a table.
	 */
	subscribe(listener: () => void): () => void;
};

/**
 * The same view with the definition's shape erased, which is what the engine
 * builds.
 *
 * Internal. It exists because the engine constructs one object and the
 * factories cast it to the caller's `DeclaredData<TDatabase>`; comparing the
 * two structurally re-enters the per-field descriptor instantiation and exceeds
 * TypeScript's depth limit.
 */
export type UntypedDeclaredData = {
	readonly tables: Readonly<Record<string, TableHandle>>;
	readonly kv: KvHandle;
	transact<TResult>(run: () => TResult): TResult;
};

/**
 * What one document costs, in the unit that actually drives the cost.
 *
 * Items rather than bytes, because memory tracks struct count: 10 MB of
 * recordings costs 263 MB resident, since every field is an item and an item
 * costs whatever the engine charges for a small object regardless of how few
 * bytes it encodes to (ADR-0215). Items are a property of the data and
 * reproduce anywhere; bytes-per-item is a property of the engine.
 */
export type DocumentPressure = {
	/** Structs the engine is holding, live and dead together. */
	items: number;
	/** Rows the declaration can actually see, summed across declared tables. */
	liveRows: number;
	/**
	 * `items / liveRows`, or the raw item count when nothing is live.
	 *
	 * The ratio rather than either number alone, because a big document and a
	 * rotten one look identical from the item count.
	 */
	itemsPerLiveRow: number;
};

/**
 * One opened document's runtime: the live Yjs state and its durable record.
 *
 * Measure the document, encode it, hear commits, and inspect persistence.
 * The parsed definition is captured once. Local and account data share these
 * operations; sync status is undefined when no connection is attached.
 */
export type DataDocument = {
	/**
	 * How much of this document is dead weight.
	 *
	 * The one number to watch, and the reason it exists rather than a design.
	 * Deleting a row leaves a tombstone that every device pays for in memory on
	 * every load, forever. An explicit Rebuild action reclaims one (ADR-0276,
	 * `evidence/bench/tombstones.ts`). Whether that ever matters is a question
	 * about how much a real person deletes, and nobody has that number.
	 *
	 * The arithmetic it feeds: memory tracks struct count at roughly 1 KB of rss
	 * per item, and a dead row costs about 2. So 50,000 deletions is around
	 * 100 MB, which is 14 deletions a day sustained for a decade. A vault of a
	 * thousand notes does not get there; something with real churn might.
	 *
	 * Watch `itemsPerLiveRow`. A healthy application sits near the item cost of
	 * one row, about 7 for a note with a body. Ten times that means the document
	 * is mostly corpse, and the decision about what to do becomes worth having
	 * against a measurement rather than against a guess.
	 */
	pressure(): DocumentPressure;
	/** The document's clocks: which authored state it holds, from whom. */
	stateVector(): Uint8Array;
	/** Everything the document has that the state vector does not. */
	encodeStateSince(stateVector?: Uint8Array): Uint8Array;
	/**
	 * Everything stored, before this declaration reads it (ADR-0267).
	 *
	 * A CRDT read like `stateVector` and `encodeStateSince` are: it answers
	 * about the document rather than about the application's view of it. What
	 * an artifact needs and a feature never touches.
	 */
	stored(): StoredData;
	/**
	 * One row exactly as the exporter needs it: every stored value, and the
	 * the live body node beside them.
	 *
	 * The narrow form of `stored()`, and the artifact layer's only per-row read.
	 * It is on the STORE rather than on a table handle because it is not a
	 * lens: it returns keys this release no longer declares and rows this
	 * release cannot conform, which is the one thing an export may not narrow
	 * (ADR-0267). A handle answers what an application can see; this answers
	 * what is there.
	 */
	rowFile(table: string, rowId: string): RowFile | undefined;
	/**
	 * Hear when anything committed into this document, whoever authored it.
	 *
	 * Fires at acceptance, whether or not the durable copy has caught up:
	 * acceptance and durability are two steps (ADR-0238), and durability has
	 * its own surface below. Delivered BEFORE table and KV notifications in
	 * the same flush, and that order is a contract: a composed follower marks
	 * itself dirty here, so it is already dirty by the time any table
	 * subscriber reads through it. The transport instead listens for durable
	 * outbound work through `onSendable`; this also fires for remote changes
	 * and fires before their persistence completes.
	 */
	onCommitted(listener: () => void): () => void;
	/**
	 * This store's local-persistence debt: whether everything accepted has
	 * reached durable storage (ADR-0238).
	 *
	 * `saved` | `pending` | `blocked`, with `subscribe` for changes and
	 * `flush()` to request an attempt now. A `blocked` store keeps serving and
	 * accepting; what is at risk is only what a RESTART would recover.
	 */
	readonly persistence: PersistenceCapability;
	/**
	 * The app-facing facts of this store's entanglement with its authority.
	 *
	 * Always present; local documents report no attached connection. The
	 * delivery machinery underneath (applying peer bytes, the outbox, cursors,
	 * the acknowledgement bookkeeping) is deliberately not public. Only the
	 * transport drives it, and it reaches it through `syncEngineOf` inside this
	 * package.
	 */
	readonly sync: SyncCapability;
	/**
	 * The declaration this store was opened from, compiled.
	 *
	 * An opener compiles the definition to build the view and used to throw the
	 * compiled copy away, so everything downstream that needed it was handed the
	 * declaration again and compiled it again: the folder verbs did it three
	 * times, on every call. It is the same fact as `dataId`, which is literally
	 * `definition.id`, one layer down (ADR-0340).
	 *
	 * A store carrying it also means a definition reaching those verbs cannot be
	 * malformed: this one compiled, or there would be no store.
	 */
	readonly definition: ParsedDataDefinition;
};

/**
 * A store that knows the server it belongs to.
 *
 * Exact-generation low-level openers retain this address for artifacts and
 * diagnostics. The common app handle does not require replica metadata.
 */
export type ReplicaDocument = DataDocument & {
	/**
	 * The application that opened this store, which is not the data id
	 * (ADR-0324, ADR-0304).
	 */
	readonly appId: string;
	/** What this store holds, as its definition declares it. */
	readonly dataId: string;
	/**
	 * The exact generation this store is (ADR-0292).
	 *
	 * Stamped by the opener, which is the one party that knows it. It used to
	 * be kept beside the store by whoever opened it, and handed back to every
	 * verb that needed an address: a socket, a manifest, a bug report. A caller
	 * that assembles an address can assemble a wrong one, and nothing type-checks
	 * the pair because both halves are the same primitive (ADR-0340).
	 */
	readonly generation: number;
	/** The canonical server identity this replica belongs to. */
	readonly baseURL: string;
	/** The principal asserted by that server for this replica. */
	readonly principalId: PrincipalId;
};

/**
 * The attached connection's status, keyed by this capability's object identity.
 * Local stores have no registered replication engine and report no connection.
 */
export type SyncCapability = {
	/**
	 * What the attached connection reports, or `undefined` when none is
	 * attached.
	 *
	 * Pull-only, and polled rather than subscribed. Connection health changes on
	 * a socket's schedule, so a reactive adapter holding it would be polling
	 * underneath and calling the result state; `from-data.svelte.ts` refuses
	 * that boundary by name. The store holds the connection so a status has one
	 * owner, not so a reader can dial: there is no `connect`, no `disconnect`,
	 * and no `retry` here, because the driver owns its backoff and dials for as
	 * long as the store is open, refusal or not.
	 */
	status(): SyncConnectionStatus | undefined;
};

/**
 * The account half of an address, and how this device reaches its authority.
 *
 * Capture this value for the data session. Its principal and server stay fixed,
 * and its HTTP and socket transport must never adopt another account's
 * credentials. `Account` from `@epicenter/auth` satisfies this contract directly.
 *
 * `fetch` opens generations this device does not hold; `openWebSocket` carries
 * later updates for the store's lifetime. Keeping this structural contract here
 * lets data openers consume accounts without depending on the auth package.
 */
export type DatabaseAccount = AccountIdentity & {
	readonly baseURL: string;
	/** A credentialed fetch, waiting on machine work but never on a human. */
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
	/** A credentialed dial, which the sync driver repeats for the store's life. */
	openWebSocket: SocketTransport['openWebSocket'];
};
