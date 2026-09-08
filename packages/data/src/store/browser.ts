/**
 * Open one application's store in a browser page.
 *
 * The store runs HERE, on the main thread. The live Yjs document is the
 * source of truth, and the durable update log lives directly in IndexedDB.
 * Each record carries its authority position, so the outbox and cursor are
 * read from that same store and one flush is one atomic transaction (ADR-0238).
 * Every read a person makes
 * (`get`, `rows`, `ids`, `document`) comes from the `Y.Doc` already in
 * memory; SQL, when an application wants it, is a follower it composes over
 * this surface, so opening a store here loads no SQLite at all.
 *
 * ## Why IndexedDB owns the facts directly
 *
 * The previous shape snapshotted the whole in-memory SQLite (log, outbox,
 * cursor) into one IndexedDB checkpoint record after every commit. That
 * indirection stored one runtime's file format inside another's storage and
 * paid a whole-file write per commit. The update records now hold the only
 * durable facts, and the persistence controller's queue ordering keeps a
 * cursor from advancing before its bytes land (ADR-0238).
 *
 * y-indexeddb was considered and rejected: it exposes no public way to
 * participate in the transaction that records authority positions, and its
 * own debounce and compaction make its update store unreadable as the stable
 * log this transport needs.
 *
 * ## Why there is no worker
 *
 * There was one, holding an OPFS SQLite fed every statement, justified by a
 * derived index "coming back for free"; that was false, because such an index
 * rebuilds from the document at open regardless. What actually has to survive
 * is small: the log folds at `SNAPSHOT_FOLD_THRESHOLD` (64), the outbox is
 * coalesced before it is sent, and the cursor is one row. IndexedDB holds
 * that from the page.
 */

import { isAppId } from '@epicenter/constants/app-id';
import {
	compileData,
	type DataDefinition,
	type DataDefinitionParseError,
	type ParsedDataDefinition,
} from '@epicenter/data/definition';
import type { PrincipalId } from '@epicenter/principal';
import {
	GENERATIONS_ROUTE,
	LOG_POSITION_HEADER,
} from '@epicenter/sync/generations-route';
import * as Y from '@y/y';
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from 'idb';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { claimDocument } from './claims.js';
import { createDatabaseDocument } from './document.js';
import type { DatabaseAccount } from './handles.js';
import {
	copyBytes,
	NO_AUTHORITY,
	replay,
	SNAPSHOT_FOLD_THRESHOLD,
} from './log.js';
import { requestPersistentStorage } from './persist.js';
import type {
	DurableOp,
	DurablePort,
	DurableSnapshot,
	OutboxEntry,
} from './persistence.js';
import {
	createStoreOverPort,
	type DeclaredData,
	type ReplicaData,
	type StoreBacking,
	type StoreBlobBacking,
	StoreError,
} from './store.js';

/**
 * What every opener here fails with, as a type.
 *
 * The CONSTRUCTORS stay internal: a store is what throws these, and nothing
 * outside builds one. The type is exported because a caller that holds an
 * opener's `Result` has to be able to name it, and `@epicenter/app`'s handle
 * does exactly that rather than wrapping it in an error of its own (ADR-0339).
 */
export type { StoreError } from './errors.js';
/**
 * One generation of one account's database, held on this device.
 *
 * It carries no `discard`. A superseded replica used to discard and rejoin at
 * zero, because one address held whatever the authority currently was; a
 * generation is created once and never mutated in place, so moving to a newer
 * one is opening a different address and this one is simply an older copy
 * (ADR-0292). Deleting it is a storage decision, not a correctness one.
 */
// Re-exported so a browser caller's one import site names the document beside
// the opener that produces it.
export type { DatabaseAccount } from './handles.js';
export type { DataDocument, ReplicaDocument } from './store.js';

/**
 * The durable fact, one object store (ADR-0238, ADR-0295).
 *
 * `updates` is this generation's Yjs update log, keyed by the append id the
 * store assigned. The outbox and the cursor are read off it rather than kept
 * beside it. The name is persisted; changing it requires an IndexedDB
 * migration.
 *
 * Three stores are gone with the designs they served. `tombstones` went with
 * the document split (ADR-0295): there is no second address a row deletion
 * could retire. `identity` went with the membership stamp (ADR-0292): the
 * generation is in the address, so a record here can only belong to the history
 * its name says it does. `binding` went the same way: it recorded the server
 * and the principal a generation was created for, because ADR-0324's address
 * named neither, and the principal is a segment of the address again, so a
 * record here can only belong to the account its name says it does.
 */
type StoredUpdateRecord = {
	bytes: Uint8Array;
	/** `null` is owed: the authority has no position for these bytes. */
	authoritySeq: number | null;
};

type BrowserDurableSchema = DBSchema & {
	updates: { key: number; value: StoredUpdateRecord };
};

type BrowserDurableDatabase = IDBPDatabase<BrowserDurableSchema>;

const UPDATES_STORE = 'updates';

function openIndexedDb(address: string): Promise<BrowserDurableDatabase> {
	// Version 1, and it is a constant rather than a starting point: the address
	// carries the storage generation, so a shape change strands the old record
	// at a name nothing opens rather than upgrading it in place. This database
	// is only ever created, never migrated.
	//
	// That is why there is no `blocked` handler here. `blocked` fires when a
	// versionchange transaction is needed while another connection is open,
	// which requires opening at a HIGHER version than a live connection holds.
	// With a constant 1 that can never be requested, so the handler this file
	// used to carry, and the flag and late-close branch around it, defended an
	// event the address scheme had already made unreachable. `deleteIndexedDb`
	// keeps its own: a delete always needs exclusive access, so that one fires.
	return openDB<BrowserDurableSchema>(address, 1, {
		upgrade(durable) {
			if (!durable.objectStoreNames.contains(UPDATES_STORE)) {
				durable.createObjectStore(UPDATES_STORE);
			}
		},
	});
}

/** Delete one store's IndexedDB definition whole. Our own connection is closed first. */
function deleteIndexedDb(address: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		void deleteDB(address, {
			blocked() {
				// `deleteDB` waits for the other tab. This caller must instead know
				// that its requested wipe did not happen before it reloads.
				blocked = true;
				reject(
					new Error('Another tab is holding this store open. Close it first.'),
				);
			},
		}).then(
			() => {
				if (!blocked) resolve();
			},
			(cause) => reject(cause),
		);
	});
}

/** One address's durable engine, loaded and ready to commit batches. */
export type BrowserBacking = {
	port: DurablePort;
	loaded: DurableSnapshot;
	/**
	 * Bring this address into being: one whole state and its position, in ONE
	 * transaction.
	 *
	 * A separate verb rather than a `DurableOp`, because it is not one. The
	 * port is the seam two engines implement (`port-conformance.test.ts`), and
	 * what both promise is that a generation is created whole.
	 *
	 * It does NOT check that the address is empty, and that is deliberate: both
	 * callers already branch on `loaded.updates.length` because they answer
	 * differently, and each holds the document claim across that branch, so a
	 * third check here would be a second guard saying a third thing.
	 */
	create(record: { bytes: Uint8Array; position: number }): Promise<void>;
	close(): void;
};

/**
 * This address's durable record, as a `DurablePort` over IndexedDB.
 *
 * Exported for the same reason `createSqliteDurablePort` is: the port is the
 * seam, and there are two implementations of it. One conformance suite drives
 * both through identical batches and holds them to identical results
 * (`port-conformance.test.ts`). Two suites that each check one implementation
 * against its own expectations is how the two came to disagree about the fold,
 * the identity stamp, and what a duplicate key does.
 *
 * Not an opener. It hands back a port and what was loaded; composing a store
 * over those is `openDatabase`'s job.
 */
export async function openIdbBacking(
	address: string,
): Promise<Result<BrowserBacking, StoreError>> {
	return tryAsync({
		try: async () => {
			const durable = await openIndexedDb(address);

			const read = durable.transaction(UPDATES_STORE, 'readonly');
			const updateStore = read.objectStore(UPDATES_STORE);
			const rows = await updateStore.getAll();
			const ids = (await updateStore.getAllKeys()) as number[];
			await read.done;

			// One pass over the chain answers everything the snapshot holds, which
			// is the shape of the collapse: the outbox and the cursor are read off
			// the appends rather than kept beside them.
			const stored: { id: number; bytes: Uint8Array }[] = [];
			const outbox: OutboxEntry[] = [];
			let cursor = 0;
			let lastId = 0;
			// Not copied, and the SQL port's `copyBytes` is not an inconsistency
			// here. `bun:sqlite` can hand back a view over memory it still owns,
			// so that port has to copy; `getAll` structured-clones, so these
			// arrays are already this caller's alone. Copying them again bought
			// nothing and cost a second whole document on every boot, because the
			// baseline row IS the whole document.
			//
			// One array per row, shared by `stored` and `outbox`: an owed row
			// appears in both and neither ever writes through it.
			for (const [index, row] of rows.entries()) {
				const id = ids[index] as number;
				if (id > lastId) lastId = id;
				const bytes = row.bytes;
				stored.push({ id, bytes });
				if (row.authoritySeq === null) {
					// NULL means owed, on every store kind (ADR-0301). A store with
					// no authority records `NO_AUTHORITY` on its own appends, so it
					// reaches this branch for nothing and needs no flag to say so.
					outbox.push({ id, bytes });
				} else if (row.authoritySeq > cursor) {
					cursor = row.authoritySeq;
				}
			}
			// Not sorted, because they are already in order and saying so is the
			// point. `getAll` returns an object store's rows in ascending key
			// order, and both arrays are pushed in that one iteration. Sorting
			// them was a no-op on every real input, and worse than a no-op as
			// documentation: this loop ALREADY depends on that ordering, pairing
			// `rows[index]` with `ids[index]`, so a defensive sort implied a
			// doubt the line above it does not share. The fold and `held` depend
			// on it too. One dependency, stated once.
			let held = stored.length;

			const loaded: DurableSnapshot = {
				updates: stored.map((row) => row.bytes),
				outbox,
				cursor,
				lastId,
			};

			const port: DurablePort = {
				async commit(ops: readonly DurableOp[]): Promise<void> {
					const transaction = durable.transaction(UPDATES_STORE, 'readwrite');
					const updates = transaction.objectStore(UPDATES_STORE);
					let chain = held;
					let grew = false;
					for (const op of ops) {
						switch (op.kind) {
							case 'append': {
								void updates.put(
									{
										bytes: copyBytes(op.bytes),
										authoritySeq: op.authoritySeq ?? null,
									},
									op.id,
								);
								chain += 1;
								grew = true;
								break;
							}
							case 'mergeOwed': {
								for (const replaced of op.replaces) {
									void updates.delete(replaced);
								}
								void updates.put(
									{ bytes: copyBytes(op.bytes), authoritySeq: null },
									op.id,
								);
								chain = chain - op.replaces.length + 1;
								break;
							}
							case 'ack': {
								// One statement's worth of work, and the shape it takes here
								// is what a keyed object store makes cheap. A cursor walk
								// costs one round trip PER ROW to advance, which is what
								// made a wide ack -- a device reconnecting with a day of
								// offline work owed -- the slowest thing this port does.
								// Reading the range in two requests and issuing the stamps
								// without awaiting them costs two round trips for the whole
								// batch instead of one per row.
								//
								// The reads are the price: the range includes the baseline,
								// so a wide ack holds one document in memory while it runs.
								// That is bounded by the document rather than by the
								// backlog, and it is paid once per ack rather than per row.
								// `evidence/browser/port-cost` measures both shapes.
								const range = IDBKeyRange.upperBound(op.throughId);
								const [keys, rows] = await Promise.all([
									updates.getAllKeys(range),
									updates.getAll(range),
								]);
								for (const [index, key] of keys.entries()) {
									const row = rows[index];
									if (row === undefined || row.authoritySeq !== null) continue;
									void updates.put(
										{ ...row, authoritySeq: op.authoritySeq },
										key,
									);
									grew = true;
								}
								break;
							}
						}
					}

					// The same fold the SQL engine applies, and the same question:
					// an acknowledged row may be replaced by a whole-document
					// re-encode, an owed row may not (ADR-0301). A store with no
					// authority holds no owed rows, so it collapses everything here
					// without being told which kind it is.
					if (grew && chain >= SNAPSHOT_FOLD_THRESHOLD) {
						const foldable: { id: number; bytes: Uint8Array }[] = [];
						let position: number | null = null;
						let at = await updates.openCursor();
						while (at !== null) {
							const row = at.value;
							if (row.authoritySeq !== null) {
								foldable.push({ id: at.key as number, bytes: row.bytes });
								if (
									row.authoritySeq !== null &&
									row.authoritySeq > (position ?? -1)
								) {
									position = row.authoritySeq;
								}
							}
							at = await at.continue();
						}
						const through = foldable.at(-1)?.id;
						if (
							foldable.length >= SNAPSHOT_FOLD_THRESHOLD &&
							through !== undefined
						) {
							const folded = replay(
								foldable.map((row) => ({ seq: row.id, bytes: row.bytes })),
							);
							let baseline: Uint8Array;
							try {
								baseline = new Uint8Array(Y.encodeStateAsUpdateV2(folded));
							} finally {
								folded.destroy();
							}
							for (const row of foldable) void updates.delete(row.id);
							// The baseline inherits the highest position it replaced, so
							// on a syncing store it is not owed and is never offered back.
							void updates.put(
								{ bytes: baseline, authoritySeq: position ?? NO_AUTHORITY },
								through,
							);
							chain = chain - foldable.length + 1;
						}
					}

					await transaction.done;
					// Advanced only after the batch landed, so a retried batch
					// recomputes from the same starting point.
					held = chain;
				},
			};

			async function create(record: {
				bytes: Uint8Array;
				position: number;
			}): Promise<void> {
				const transaction = durable.transaction(UPDATES_STORE, 'readwrite');
				const updates = transaction.objectStore(UPDATES_STORE);
				void updates.put(
					{
						bytes: copyBytes(record.bytes),
						authoritySeq: record.position,
					},
					1,
				);
				await transaction.done;
				held = 1;
			}

			return { port, loaded, create, close: () => durable.close() };
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
}

/**
 * The storage generation, carried in the address rather than in the record.
 *
 * A record written under an older shape sits at a name nothing opens. It is
 * not detected and wiped: it is not addressed. That deletes the format
 * certificate, the comparison at every open, and the wipe transaction that
 * followed it, and it makes a bad migration impossible to write rather than
 * merely discouraged.
 *
 * Bumping this strands every existing record, which is the same thing the
 * format wipe always did, said out loud in the address instead of buried in
 * a table.
 *
 * `v2` is the collapse (ADR-0295). A `v1` record keyed its updates by the
 * document they belonged to and kept a `tombstones` store beside them; a
 * database is one document now, so those rows are a shape this reader cannot
 * honestly interpret. Stranding them is the answer, not a migration.
 *
 * `v3` is the owed-row collapse (ADR-0301). A `v2` local store wrote its own
 * appends with a NULL position, which now means "owed to an authority" on
 * every store kind; read under this shape those rows would be offered to a
 * sender that does not exist and would take the weaker of the two folds
 * forever. The value changed rather than the schema, which is exactly the
 * migration this address scheme exists to refuse.
 *
 * `v4` is the ownership collapse (ADR-0324). A `v3` record named the server
 * and the principal it belonged to and named no application; this shape names
 * the application and says nothing about the owner. Read under this shape a
 * `v3` record could be offered to an authority its address never scoped it to,
 * which is the one thing the address used to prevent, so those names are left
 * where they are.
 *
 * `v5` puts the principal back. A `v4` record named the application and the
 * data and said nothing about whose copy it was; this shape names the account,
 * so two people on one browser profile hold two records instead of meeting a
 * refusal over one. Read under this shape a `v4` record would be adopted by
 * whoever signed in next, which is exactly what its written-once binding
 * existed to prevent, so `v4` names are left where they are and nothing here
 * reads, adopts, or deletes them.
 */


/**
 * Whether a value can be one segment of an address.
 *
 * Applied where a caller's string becomes part of a durable name. A segment
 * holding a `/` would be read as two, and `.` or `..` are path words rather
 * than names.
 *
 * A principal id is what this exists for. `PrincipalId` is a branded string
 * with no grammar of its own, because it is whatever the authority minted; it
 * reaches this file from a remote assertion, and a durable name is not the
 * place to be lenient about what one may contain.
 */
function isSegment(value: string): boolean {
	return (
		value !== '' && !value.includes('/') && value !== '.' && value !== '..'
	);
}

/**
 * Where one account's generations of one database live in this browser, up to
 * the number (ADR-0324, ADR-0292).
 *
 * ```txt
 * epicenter/<app-id>/accounts/<authority-id>/<principal-id>/data/<data-id>/
 * ```
 *
 * The PREFIX rather than an address, because both callers want it: one appends
 * a number to open exactly that generation, the other matches it to enumerate
 * what this device holds for this account. The trailing `/` is load-bearing: it
 * is what stops `foo.bar` from prefix-matching `foo.barbaz`.
 *
 * The app id is the OPENING application's, which is not the data id: two
 * applications may name one data id and each keeps its own replica, converging
 * through the authority (ADR-0304). It is self-claimed, and nothing here or
 * anywhere else verifies it, because a deployed app is a trusted app
 * (ADR-0334): the segment partitions storage by naming and never by
 * enforcement. It is checked against `isAppId` only so that a claim can never
 * contain a `/` and be read as somebody else's address.
 *
 * **The principal is a segment, so two accounts on one device are two records
 * rather than one contested one.** It sits BELOW the app id because the desktop
 * spelling has to be the same address: an application owns its directory
 * (ADR-0314), so `apps/<app-id>/data/<version>/<principal-id>/...` is the only
 * ordering both substrates can share. It is not canonicalized, only refused:
 * an identifier is compared byte for byte by whoever issued it, and normalizing
 * one here would invent an equivalence the authority never stated.
 *
 * The server is deliberately NOT a segment. A build names one authority
 * (ADR-0326) and a browser build is served from one origin, so it is the
 * device-wide constant ADR-0324 refused. If an authority ever becomes
 * selectable inside one origin, this is the line that has to gain a segment.
 *
 * The generation is the last segment and is a NUMBER: enumeration parses it
 * rather than sorting it, because `9` sorts above `10`.
 *
 * The generation being IN the address is what retires the document identity
 * stamp. A record at this name can only belong to this generation, so there is
 * nothing to compare on a dial and nothing a stale replica could merge into.
 */
function generationPrefix(
	appId: string,
	principalId: PrincipalId,
	dataId: string,
	authorityId: string,
): Result<string, StoreError> {
	if (!isAppId(appId)) {
		return StoreError.Unaddressable({
			reason: `'${appId}' is not an application id`,
		});
	}
	if (!isSegment(principalId)) {
		// The value, the way the `appId` arm above names its own. `isSegment`
		// refuses four things and only one of them is "no principal", so a
		// message asserting the account named nothing would send whoever reads it
		// to the auth client instead of to the id. Naming it is safe because this
		// is a library error and nothing person-facing renders it (ADR-0244).
		return StoreError.Unaddressable({
			reason: `'${principalId}' is not an address segment`,
		});
	}
	if (!isSegment(authorityId)) {
		return StoreError.Unaddressable({
			reason: `'${authorityId}' is not an address segment`,
		});
	}
	return Ok(
		`epicenter/${appId}/accounts/${authorityId}/${principalId}/data/${dataId}/`,
	);
}

function localGenerationPrefix(
	appId: string,
	dataId: string,
): Result<string, StoreError> {
	if (!isAppId(appId)) {
		return StoreError.Unaddressable({
			reason: `'${appId}' is not an application id`,
		});
	}
	return Ok(`epicenter/${appId}/local/data/${dataId}/`);
}

/**
 * A generation number, admitted or refused at the boundary (ADR-0292).
 *
 * `Number.isSafeInteger(n) && n >= 1`, checked inline like any other bad
 * input, because that is what it is: a number arrives from a caller that
 * computed it. The answer to a bad one is `Unaddressable`, not
 * `GenerationNotFound`; conflating them would tell a person a generation is
 * missing when the value was never a generation at all.
 */
function isGeneration(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1;
}

/**
 * One opened replica, and the one thing that ends it.
 *
 * A pair rather than a store carrying its own disposal (ADR-0340). Opening
 * acquires a document, an exclusive Web Lock, and whatever the caller attaches
 * next; the closer is the one hand that holds all of it, and the store an
 * application is given cannot end itself.
 */
export type OpenedDatabase<TDatabase extends DataDefinition> = {
	readonly store: ReplicaData<TDatabase>;
	close(): Promise<void>;
};

export type OpenDatabaseOptions = {
	/**
	 * The id of the application doing the opening, which is not the data id
	 * (ADR-0324, ADR-0304).
	 *
	 * Self-claimed, and nothing verifies it: a deployed app is a trusted app
	 * (ADR-0334). An application that holds `@epicenter/app`'s handle never
	 * writes it here, because the handle already carries it.
	 */
	appId: string;
	/** The exact generation to open. Never discovered, never defaulted. */
	generation: number;
	/** The account this exact-generation replica belongs to. */
	account: DatabaseAccount;
};

/**
 * The bytes one generation is, and the log position they are current through.
 *
 * The position is what makes the bootstrap worth making. Without it a device
 * would seed a cursor of zero, dial, and be handed the authority's snapshot,
 * which is the same state it just downloaded; with it the socket carries only
 * what happened after.
 */
async function fetchGeneration(
	account: DatabaseAccount,
	dataId: string,
	generation: number,
): Promise<Result<{ bytes: Uint8Array; position: number }, StoreError>> {
	const url = GENERATIONS_ROUTE.item(account.baseURL, dataId, generation);
	let response: Response;
	try {
		response = await account.fetch(url);
	} catch (cause) {
		return StoreError.GenerationUnreachable({ dataId, generation, cause });
	}
	// 404 is the one answer that is a fact about the generation rather than
	// about the moment. Everything else, including 401, is retryable: a token
	// that expired mid-boot is not a missing generation.
	if (response.status === 404) {
		return StoreError.GenerationNotFound({ dataId, generation });
	}
	if (!response.ok) {
		return StoreError.GenerationUnreachable({
			dataId,
			generation,
			status: response.status,
		});
	}
	try {
		const bytes = new Uint8Array(await response.arrayBuffer());
		const header = response.headers.get(LOG_POSITION_HEADER);
		const position = header === null ? 0 : Number(header);
		return Ok({
			bytes,
			position: Number.isSafeInteger(position) && position >= 0 ? position : 0,
		});
	} catch (cause) {
		return StoreError.GenerationUnreachable({ dataId, generation, cause });
	}
}

/**
 * Open one exact generation of one database, cache-first (ADR-0292).
 *
 * This low-level opener addresses a known account generation and leaves sync
 * attachment to its caller. Application sessions enter through `openAppData`.
 *
 * The sequence, and every step of it is load-bearing:
 *
 * 1. Open the exact address and read what is there.
 * 2. **A cache hit is the presence of STATE, not the presence of the name.**
 *    `openDB` on a missing name creates it, so a name-existence test would
 *    fabricate the empty database it was asked about and every later open
 *    would read that shell as a hit.
 * 3. On a hit: hydrate and return. The caller attaches a socket afterwards if
 *    it has an account; a cached database stays usable when that fails.
 * 4. On a miss: fetch the generation, write it in one transaction, hydrate,
 *    and only then return. It bootstraps completely or fails; a fresh database
 *    never renders empty while its state is still arriving. Opening never
 *    invents a generation, because a number in a URL is an address rather than
 *    an instruction to allocate.
 *
 * It resolves once local state is durable enough to hydrate. It never waits on
 * a WebSocket round trip, and it does not attach one.
 */
export async function openDatabase<const TDatabase extends DataDefinition>(
	definition: TDatabase,
	{ appId, generation, account }: OpenDatabaseOptions,
): Promise<
	Result<OpenedDatabase<TDatabase>, StoreError | DataDefinitionParseError>
> {
	const { data: parsed, error: parseError } = compileData(definition);
	if (parseError !== null) return Err(parseError);
	const parts = createStoreOverPort({
		definition: parsed,
		acquire: () => acquireDatabase(parsed, { appId, generation, account }),
	});
	const ready = await parts.ready;
	if (ready.error !== null) return ready;
	return Ok({
		store: Object.freeze(
			Object.assign(parts.store, parts.view as DeclaredData<TDatabase>, {
				appId,
				dataId: parsed.id,
				generation,
				baseURL: account.baseURL,
				principalId: account.principalId,
			}),
		),
		close: parts.close,
	});
}

/** Acquire an exact generation's durable backing without constructing a document. */
async function acquireDatabase(
	parsed: ParsedDataDefinition,
	{
		appId,
		generation,
		account,
	}: {
		appId: string;
		generation: number;
		account?: DatabaseAccount;
	},
): Promise<Result<StoreBacking, StoreError>> {
	if (!isGeneration(generation)) {
		return StoreError.Unaddressable({
			reason: `'${generation}' is not a generation number`,
		});
	}
	const located = account
		? generationPrefix(
				appId,
				account.principalId,
				parsed.id,
				account.authorityId,
			)
		: localGenerationPrefix(appId, parsed.id);
	if (located.error !== null) return Err(located.error);

	// Asked here rather than by an application, because this is the one place
	// that knows durable storage is about to matter, and because an eviction
	// has no event: an origin's data goes wholesale and the next boot simply
	// finds nothing. Not awaited, and a refusal is ordinary.
	void requestPersistentStorage();

	const address = `${located.data}${generation}`;
	const claim = await claimDocument(address);
	if (claim.error !== null) return Err(claim.error);
	const release = claim.data.release;

	const opened = await openIdbBacking(address);
	if (opened.error !== null) {
		release();
		return Err(opened.error);
	}
	let backing = opened.data;

	if (backing.loaded.updates.length === 0) {
		// A miss. Whatever happens next, the shell this open just created must
		// not be left behind reading as a hit.
		const fetched = account
			? await fetchGeneration(account, parsed.id, generation)
			: Ok({
					bytes: new Uint8Array(
						Y.encodeStateAsUpdateV2(createDatabaseDocument()),
					),
					position: 0,
				});
		if (fetched.error !== null) {
			backing.close();
			release();
			await deleteIndexedDb(address).catch(() => undefined);
			return Err(fetched.error);
		}
		// One transaction, after the whole body has been read, so a failed
		// bootstrap leaves no half-written database. The position rides on the
		// append, which is where every cursor is read from (ADR-0298).
		const { error: writeError } = await tryAsync({
			try: () =>
				backing.create({
					bytes: fetched.data.bytes,
					position: fetched.data.position,
				}),
			catch: (cause) => StoreError.StorageFailed({ cause }),
		});
		if (writeError !== null) {
			backing.close();
			release();
			return Err(writeError);
		}
		// Reopened rather than patched in memory: what hydrates has to be what
		// a later boot would read, and a snapshot assembled here would be a
		// second answer to that question.
		backing.close();
		const reopened = await openIdbBacking(address);
		if (reopened.error !== null) {
			release();
			return Err(reopened.error);
		}
		backing = reopened.data;
	}

	const held = backing;
	return Ok({
		durable: held.port,
		loaded: held.loaded,
		dispose() {
			held.close();
			release();
		},
	});
}

/**
 * Construct the actual app document now and hydrate it from browser storage.
 * Invalid build-time declarations and account identities throw synchronously;
 * acquisition failures are reported by the engine's ready Result.
 */
export function openAppData<
	const TDefinition extends DataDefinition,
	TSqlite,
>(
	definition: TDefinition,
	{
		appId,
		account,
		blobs,
		sqlite,
		onClose,
		beforeClose,
	}: {
		appId: string;
		account?: DatabaseAccount;
		blobs: StoreBlobBacking;
		sqlite: TSqlite;
		onClose?: () => void;
		beforeClose?: () => Promise<void>;
	},
) {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const { data: parsed, error } = compileData(definition);
	if (error !== null) throw new Error(error.message, { cause: error });
	const authorityId = account?.authorityId;
	if (account !== undefined && authorityId === undefined) {
		throw new Error('The account has no stable authority identity.');
	}
	const identity =
		account !== undefined && authorityId !== undefined
			? Object.freeze({ authorityId, principalId: account.principalId })
			: null;
	const parts = createStoreOverPort<StoreError | DataDefinitionParseError>({
		definition: parsed,
		blobStore: blobs.local,
		onClose,
		beforeClose,
		local: account === undefined,
		async acquire() {
			if (account === undefined) {
				return acquireDatabase(parsed, { appId, generation: 1 });
			}
			const resolved = await resolveGeneration(definition, { appId, account });
			if (resolved.error !== null) return resolved;
			const generation = resolved.data.generation;
			const acquired = await acquireDatabase(parsed, {
				appId,
				generation,
				account,
			});
			if (acquired.error !== null) return acquired;
			return Ok({
				...acquired.data,
				replication: {
					address: { baseURL: account.baseURL, dataId: parsed.id, generation },
					transport: account,
				},
			});
		},
	});
	return Object.freeze(
		Object.assign(parts.store, parts.view as DeclaredData<TDefinition>, {
			appId,
			dataId: parsed.id,
			account: identity,
			ready: parts.ready,
			close: parts.close,
			blobs: parts.createBlobs(blobs),
			sqlite,
		}),
	);
}

/**
 * Write one generation's whole state into this device's own storage.
 *
 * The last step of an import (ADR-0293), and the only way a generation comes
 * into being on a device: a folder is parsed into one Yjs document, its state
 * is one blob, and the blob is written at that generation's address. The
 * number is already known, because the address contains it.
 *
 * `position` is where the authority put those bytes, and zero for a
 * device-owned generation that no authority has ever seen. It becomes the
 * store's cursor, derived off this append like every other one.
 *
 * Refuses an address that already holds state rather than adding to it. A
 * generation is created once and never mutated in place, so a second write
 * here would be a caller confusing import with sync.
 *
 * Not exported. Both call sites are `createGeneration` below, and the split is
 * the two halves of one operation rather than a surface: without a number
 * there is nothing to write under, and choosing the number is what
 * `createGeneration` is for.
 */
async function writeGeneration({
	appId,
	principalId,
	authorityId,
	dataId,
	generation,
	state,
	position = 0,
}: {
	appId: string;
	principalId: PrincipalId;
	authorityId: string;
	dataId: string;
	generation: number;
	state: Uint8Array;
	position?: number;
}): Promise<Result<void, StoreError>> {
	if (!isGeneration(generation)) {
		return StoreError.Unaddressable({
			reason: `'${generation}' is not a generation number`,
		});
	}
	const located = generationPrefix(appId, principalId, dataId, authorityId);
	if (located.error !== null) return Err(located.error);
	const address = `${located.data}${generation}`;

	const claim = await claimDocument(address);
	if (claim.error !== null) return Err(claim.error);
	const release = claim.data.release;
	try {
		const opened = await openIdbBacking(address);
		if (opened.error !== null) return Err(opened.error);
		const backing = opened.data;
		try {
			// Not `AlreadyOpen`: nobody holds this document, and telling a
			// person to close another window would name a repair that cannot
			// help. A generation is written once (ADR-0293).
			if (backing.loaded.updates.length > 0) {
				return StoreError.GenerationExists({ dataId, generation });
			}
			await backing.create({ bytes: state, position });
			return Ok(undefined);
		} catch (cause) {
			return StoreError.StorageFailed({ cause });
		} finally {
			backing.close();
		}
	} finally {
		release();
	}
}

/**
 * Bring one generation into being (ADR-0293).
 *
 * `from` is a whole database state, and OMITTING it mints an empty one. That
 * is not a second code path: an empty database is what a folder with no files
 * in it reads as, so the default is the value rather than a branch. It used to
 * be a named helper in the artifact layer, `emptyDatabase`, whose own comment
 * said the name was the point; making it the default is the version where the
 * name does not have to be said.
 *
 * The split with the artifact layer is where ADR-0293's diagram puts it: the
 * CLIENT parses the folder with the application's own codecs and builds one
 * Yjs document (`readArtifact`), and this takes the state that came out and
 * gives it a number and an address. Keeping the parse outside means an opener
 * does not carry the artifact layer, and it is the same call either way.
 *
 * **The client never chooses the number.** With an account the authority
 * assigns it: the state is posted whole, stored whole, and the ledger row is
 * written last, so a generation exists if and only if it is listed. Without
 * one the device assigns it, by reading the addresses it already holds, which
 * is the same operation with the network step removed rather than a second
 * feature.
 *
 * The local write happens strictly AFTER the number is known, because the
 * address contains it. Both paths end identically, with bytes at a generation's
 * address that `openDatabase` will find as a cache hit.
 *
 * **Never retry this blindly.** If a response is lost after the authority
 * created the generation, listing and comparing the maximum answers what
 * happened: higher means the import landed and that is its number, unchanged
 * means it did not.
 */
export async function createGeneration(
	definition: DataDefinition,
	{
		appId,
		from,
		account,
	}: { appId: string; from?: Uint8Array; account: DatabaseAccount },
): Promise<
	Result<{ generation: number }, StoreError | DataDefinitionParseError>
> {
	const { data: parsed, error: parseError } = compileData(definition);
	if (parseError !== null) return Err(parseError);

	const state =
		from ?? new Uint8Array(Y.encodeStateAsUpdateV2(createDatabaseDocument()));

	// Refused before the state is posted, so an account this device cannot name
	// never reaches the authority: the number would come back and have nowhere
	// to be written.
	const located = generationPrefix(
		appId,
		account.principalId,
		parsed.id,
		account.authorityId,
	);
	if (located.error !== null) return Err(located.error);
	const posted = await postGeneration(account, parsed.id, state);
	if (posted.error !== null) return Err(posted.error);
	const { error } = await writeGeneration({
		appId,
		principalId: account.principalId,
		authorityId: account.authorityId,
		dataId: parsed.id,
		generation: posted.data.generation,
		state,
		position: posted.data.position,
	});
	return error === null
		? Ok({ generation: posted.data.generation })
		: Err(error);
}

/** Post one whole state and hear back the number the authority gave it. */
async function postGeneration(
	account: DatabaseAccount,
	dataId: string,
	state: Uint8Array,
): Promise<Result<{ generation: number; position: number }, StoreError>> {
	let response: Response;
	try {
		response = await account.fetch(
			GENERATIONS_ROUTE.collection(account.baseURL, dataId),
			{
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: state as unknown as BodyInit,
			},
		);
	} catch (cause) {
		return StoreError.GenerationUnreachable({ dataId, generation: 0, cause });
	}
	if (!response.ok) {
		return StoreError.GenerationUnreachable({
			dataId,
			generation: 0,
			status: response.status,
		});
	}
	try {
		const body = (await response.json()) as {
			generation?: number;
			position?: number;
		};
		if (!Number.isSafeInteger(body.generation) || (body.generation ?? 0) < 1) {
			return StoreError.GenerationUnreachable({
				dataId,
				generation: 0,
				status: response.status,
			});
		}
		return Ok({
			generation: body.generation as number,
			position: Number.isSafeInteger(body.position)
				? (body.position as number)
				: 0,
		});
	} catch (cause) {
		return StoreError.GenerationUnreachable({ dataId, generation: 0, cause });
	}
}

/**
 * Which generation of this database to open, and minting the first one
 * (ADR-0292, ADR-0293).
 *
 * Cache first, then the account's own list. A device that already holds a copy
 * uses it without waiting for a server; one that holds none asks which exist.
 *
 * **It creates one only when the account's list comes back EMPTY**, which is a
 * first run. That distinction is the whole of this function, and it was
 * hand-rolled four times before it lived here: a device that could not SEE what
 * the account has must not invent a generation, because the authority mints the
 * next number and two devices doing that separately fork one notebook into two
 * histories that never meet. A failed listing is `GenerationUnreachable` and a
 * retry fixes it; an empty listing is a fact and a first run.
 *
 * A `Result` rather than a throw, because every arm is a boot outcome an
 * application renders: the copy is elsewhere, the account cannot be reached, or
 * this device names nothing. `epicenter.data` and every application that opens
 * its own store go through this one answer.
 */
export async function resolveGeneration(
	definition: DataDefinition,
	{ appId, account }: { appId: string; account: DatabaseAccount },
): Promise<
	Result<{ generation: number }, StoreError | DataDefinitionParseError>
> {
	const { data: parsed, error: parseError } = compileData(definition);
	if (parseError !== null) return Err(parseError);

	const held = await newestGeneration({
		appId,
		principalId: account.principalId,
		authorityId: account.authorityId,
		dataId: parsed.id,
	});
	if (held !== undefined) return Ok({ generation: held });

	const listed = await listGenerations(account, parsed.id);
	if (listed.error !== null) return Err(listed.error);
	// The maximum rather than the last element. The authority orders its listing
	// and this does not need to know that.
	if (listed.data.length > 0) {
		return Ok({ generation: Math.max(...listed.data) });
	}

	return createGeneration(definition, { appId, account });
}

/** Which generations the authority holds, oldest first. */
async function listGenerations(
	account: DatabaseAccount,
	dataId: string,
): Promise<Result<number[], StoreError>> {
	const unavailable = (extra: { status?: number; cause?: unknown }) =>
		StoreError.GenerationUnreachable({ dataId, generation: 0, ...extra });
	let response: Response;
	try {
		response = await account.fetch(
			GENERATIONS_ROUTE.collection(account.baseURL, dataId),
		);
	} catch (cause) {
		return unavailable({ cause });
	}
	if (!response.ok) return unavailable({ status: response.status });
	try {
		const body = (await response.json()) as { generations?: unknown };
		// Every element, or none of them. Filtering to the ones that parse would
		// turn `{"generations":["1","2"]}` into an empty list, and an empty list
		// is what tells `resolveGeneration` to mint: the exact fork it exists to
		// refuse, reached through a response that was merely misspelled.
		if (
			!Array.isArray(body.generations) ||
			!body.generations.every(
				(entry) => typeof entry === 'number' && isGeneration(entry),
			)
		) {
			return unavailable({});
		}
		return Ok(body.generations as number[]);
	} catch (cause) {
		return unavailable({ cause });
	}
}

/**
 * Erase every generation of this account's database that this device holds.
 *
 * The only verb in this file that deletes, and it is scoped to one account: the
 * principal is a segment of the prefix, so forgetting one person's copy on a
 * shared device leaves the other person's alone. It is plural in the
 * generation, because a device that holds several holds them under one prefix
 * and a person forgetting their copy means all of it.
 *
 * Never called as a step in a protocol (ADR-0281). Opening does not repair
 * itself and sign-out deletes nothing. A person decides that this account's
 * copy on this device should be gone, and this is what they invoked.
 *
 * **Every generation is claimed before any is deleted, and then they go oldest
 * first.** The claim is what makes a refusal cost nothing: a generation another
 * window holds open answers `AlreadyOpen`, which names the repair, and nothing
 * is deleted. The order is what makes an interrupted delete legible. Deleting
 * is not atomic across databases, so a crash between two of them leaves the
 * rest; going oldest first means what survives is the newest, which is what the
 * person was looking at. That is not damage. A device holding some generations
 * and not others is the ordinary state of a device (ADR-0281): a stale replica
 * is not dangerous, it is somewhere else, and the next open resolves the newest
 * one held exactly as it always does.
 *
 * So there is no removal-intent record and no recovery screen. Retrying is the
 * same call, it is idempotent, and it finishes the job.
 *
 * It reaches only this storage generation's names. A record written under an
 * older address is not addressed by this prefix and is not deleted: stranded
 * bytes cost storage, and reaping them would make an upgrade the moment
 * somebody's unsynced work became unrecoverable.
 */
export async function eraseGenerations({
	appId,
	authorityId,
	principalId,
	dataId,
}: {
	appId: string;
	authorityId: string;
	principalId: PrincipalId;
	dataId: string;
}): Promise<Result<{ erased: number }, StoreError>> {
	const located = generationPrefix(appId, principalId, dataId, authorityId);
	if (located.error !== null) return Err(located.error);
	const names = await heldGenerationNames(located.data);

	// The same claim an open takes, so "somebody has this open" has one answer
	// on this origin rather than a second one read off a delete that blocked.
	const claims: Array<{ name: string; release(): void }> = [];
	const release = () => {
		for (const claim of claims) claim.release();
	};
	for (const name of names) {
		const claim = await claimDocument(name);
		if (claim.error !== null) {
			release();
			return Err(claim.error);
		}
		claims.push({ name, release: claim.data.release });
	}

	try {
		// Oldest first, so an interrupted erase leaves the newest generation
		// rather than a number nobody chose. `heldGenerationNames` answers in no
		// order, and the remainder after the prefix is the number by grammar.
		const oldestFirst = [...names].sort(
			(left, right) =>
				Number(left.slice(located.data.length)) -
				Number(right.slice(located.data.length)),
		);
		for (const name of oldestFirst) {
			const { error } = await tryAsync({
				try: () => deleteIndexedDb(name),
				catch: (cause) => StoreError.StorageFailed({ cause }),
			});
			if (error !== null) return Err(error);
		}
	} finally {
		release();
	}
	return Ok({ erased: names.length });
}

/** Every IndexedDB name under one generation prefix, in no order. */
async function heldGenerationNames(prefix: string): Promise<string[]> {
	const names = (await indexedDB.databases())
		.map(({ name }) => name)
		.filter((name): name is string => name !== undefined);
	// The grammar rather than `Number`, which reads `' 1'`, `'0x1'` and `'1e0'`
	// as one. Nothing here writes those; a durable name is not the place to be
	// lenient about what it means.
	return names.filter(
		(name) =>
			name.startsWith(prefix) &&
			/^[1-9][0-9]*$/.test(name.slice(prefix.length)),
	);
}

/**
 * The newest generation of this database this device holds, or `undefined`
 * (ADR-0292).
 *
 * Newest is the HIGHEST number, not the latest timestamp: the number is the
 * order. Parsed rather than sorted, because `9` sorts above `10`.
 *
 * Not exported, and that is the point of `resolveGeneration` above: what this
 * device holds is half an answer, and the half that mints when it comes back
 * empty is the half that forks a notebook. Every caller wants the whole
 * decision, so the whole decision is what is public.
 *
 * Identifiers rather than a definition, so this stays a question with no error
 * channel. A device that holds none and a device that cannot name an address
 * both answer the same way, and the honest answer is "none".
 *
 * It takes the principal, because the account is in the address again. What it
 * counts is every generation of this database that THIS account holds through
 * this application, so a copy another person left on the same device is not
 * miscounted as one to open.
 */
async function newestGeneration({
	appId,
	principalId,
	authorityId,
	dataId,
}: {
	appId: string;
	principalId: PrincipalId;
	authorityId: string;
	dataId: string;
}): Promise<number | undefined> {
	const located = generationPrefix(appId, principalId, dataId, authorityId);
	// A name this store cannot build addresses nothing, so there is nothing
	// here to find. `openDatabase` refuses the same input loudly; this one is a
	// question about what is on disk and the honest answer is "none".
	if (located.error !== null) return undefined;
	const prefix = located.data;
	let newest: number | undefined;
	for (const name of await heldGenerationNames(prefix)) {
		const parsed = Number(name.slice(prefix.length));
		if (newest === undefined || parsed > newest) newest = parsed;
	}
	return newest;
}
