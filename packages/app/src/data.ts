/**
 * @fileoverview Structured data, bound through one Lens the app declares.
 *
 * An app names its own durable namespace, its tables, and its values, and binds
 * them here. Nothing about that declaration is Epicenter's to own: a Lens is
 * inert JSON vocabulary from `@epicenter/lens`, which is why two apps can
 * import the same contract module and reach the same data without either of
 * them, or the contract, depending on this client.
 *
 * # Why `bind` is asynchronous
 *
 * The rest of this package has no opener, because there is no connection behind
 * recording or transcription. Data does have one. A bound handle promises to
 * report when its data may be stale, and that promise is only keepable if the
 * observation carrier is already established when the handle is handed over. A
 * synchronous `bind` would have to open the carrier lazily, which leaves a
 * window where an app has subscribed, read, and missed a change that landed in
 * between. Awaiting the bind closes that window at the one place a caller
 * already expects to wait.
 *
 * This does not reintroduce the `openEpicenter()` that ADR-0186 refused. There
 * is still no handle-wide session, no configuration, and no connection object
 * an app holds: `bind` is per Lens, and what it waits for is the document's
 * shared observation carrier.
 *
 * # One carrier per document, however many Lenses
 *
 * A Lens is one namespace, and an app may declare several. What an app must not
 * get is one host surface, one socket, and one reconnect loop per declaration:
 * the host broadcasts every committed address to every surface, so a second
 * socket carries a second copy of the same firehose, heals its own gap on its
 * own schedule, and registers a second surface the host has to keep.
 *
 * So the carrier belongs to the document rather than to the binding. The first
 * `bind` opens it, every later `bind` joins it, and it closes when the last
 * binding lets go. `close()` still means what it says at the call site: this
 * binding is finished, its handles refuse further use, and its listeners are
 * released. Whether that was also the last one is the transport's business,
 * not the app's.
 *
 * # Reading is a re-read, never a push
 *
 * Nothing here streams row contents. Invalidation says what may be stale; the
 * app re-reads through the handle it already has. That keeps one copy of the
 * data (the host's) and leaves the app in charge of what it caches.
 */

import {
	type ConstrainedUpdate,
	type CreateInputFor,
	createInvalidationDispatcher,
	type InvalidationDispatcher,
	type Lens,
	type NonconformingRowError,
	type ObservationCarrier,
	openObservationCarrier,
	type RowAddress,
	type RowFor,
	serializeTableDefinition,
	serializeValueDefinition,
	splitUpdate,
	type TableDefinition,
	type TableDefinitions,
	type TableInvalidation,
	type ValueAddress,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from '@epicenter/lens';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

import {
	DATA_OBSERVE_ROUTE,
	DATA_ROUTE,
	type WireDataOperation,
	type WireDataResponse,
	type WireEntriesPage,
} from './data-protocol.js';
import {
	type BindDataError,
	DataErrors,
	type DataOperationError,
	type DataReadError,
	HostErrors,
} from './errors.js';
import { hostIsReachable } from './host.js';

/** One classified traversal, grouped. */
export type TableScan<TDefinition extends TableDefinition> = {
	rows: RowFor<TDefinition>[];
	nonconforming: NonconformingRowError[];
};

/** One entry of a traversal: a row, or the reason it could not be read as one. */
export type TableEntry<TDefinition extends TableDefinition> = Result<
	RowFor<TDefinition>,
	NonconformingRowError
>;

/** Stop receiving invalidations. Calling it twice is a no-op. */
export type Unsubscribe = () => void;

export type TableHandle<TDefinition extends TableDefinition> = {
	create(
		fields: CreateInputFor<TDefinition>,
	): Promise<Result<RowFor<TDefinition>, DataOperationError>>;
	get(
		rowId: string,
	): Promise<Result<RowFor<TDefinition> | undefined, DataReadError>>;
	update<const TChanges extends Record<string, unknown>>(
		rowId: string,
		patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
	): Promise<Result<RowFor<TDefinition> | undefined, DataReadError>>;
	/** `false` when the row was already gone, which is not a failure. */
	delete(rowId: string): Promise<Result<boolean, DataOperationError>>;
	/**
	 * Read every live row and group the results. Use {@link entries} when the
	 * table should not be held in memory all at once.
	 */
	scan(): Promise<Result<TableScan<TDefinition>, DataOperationError>>;
	/**
	 * Stream every live row in stable row-ID order without materializing the
	 * table. Paging is internal; a caller may stop early. Iteration throws only
	 * on transport failure, because a caller mid-loop has no Result to inspect.
	 */
	entries(): AsyncIterable<TableEntry<TDefinition>>;
	/**
	 * Report when rows reachable through this handle may be stale.
	 *
	 * Registration is synchronous, does no I/O, and never fires initially, so
	 * subscribing and then reading is race-free with nothing to discard.
	 *
	 * `{ scope: 'rows' }` names exactly the rows a commit touched.
	 * `{ scope: 'table' }` means the handle cannot name them, so everything
	 * reachable through it may have moved; it arrives after an observation gap,
	 * where a row deleted while the carrier was down has left nothing to name.
	 *
	 * Ignoring the payload and re-reading everything is always correct.
	 *
	 * @example
	 * ```ts
	 * const stop = notes.subscribe((invalidation) => {
	 *   if (invalidation.scope === 'table') return void reloadEverything();
	 *   for (const rowId of invalidation.rowIds) void reread(rowId);
	 * });
	 * ```
	 */
	subscribe(listener: (invalidation: TableInvalidation) => void): Unsubscribe;
};

export type ValueHandle<TDefinition extends ValueDefinition> = {
	get(): Promise<Result<ValueFor<TDefinition> | undefined, DataReadError>>;
	set(value: ValueFor<TDefinition>): Promise<Result<void, DataOperationError>>;
	unset(): Promise<Result<void, DataOperationError>>;
	/**
	 * Report when this value may be stale.
	 *
	 * No payload, because a value has no smaller identity to name: the handle
	 * already is the thing that changed. Re-read to find out what it holds.
	 */
	subscribe(listener: () => void): Unsubscribe;
};

export type BoundData<
	TTables extends TableDefinitions,
	TValues extends ValueDefinitions,
> = {
	tables: { [K in keyof TTables]: TableHandle<TTables[K]> };
	values: { [K in keyof TValues]: ValueHandle<TValues[K]> };
	/**
	 * Finish with this binding: its handles refuse further use and its listeners
	 * stop firing.
	 *
	 * An app that lives as long as its window never needs this; a surface that
	 * binds and unbinds does. Other bindings in the same document are unaffected,
	 * and the shared observation carrier closes only once the last one lets go.
	 */
	close(): Promise<void>;
};

export type DataNamespace = {
	/**
	 * Bind one Lens and wait for its liveness to be established.
	 *
	 * Outside an Epicenter host this answers `HostUnavailable`, like every other
	 * capability here, rather than throwing or handing back a handle that will
	 * fail on first use.
	 */
	bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>(
		lens: Lens<TTables, TValues>,
	): Promise<Result<BoundData<TTables, TValues>, BindDataError>>;
};

function originOf(): string {
	const origin = (globalThis as { location?: { origin?: unknown } }).location
		?.origin;
	if (typeof origin !== 'string') {
		throw new Error('Epicenter data requires a document origin');
	}
	return origin;
}

function observeUrl(origin: string): string {
	const url = new URL(DATA_OBSERVE_ROUTE, origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.toString();
}

/**
 * Ask the host to perform one operation on behalf of one surface.
 *
 * Deliberately takes the surface rather than closing over it: the same request
 * is issued while a transport is being opened, while it is live, and once more
 * after the last binding has let it go.
 */
async function request<TResult>(
	{ origin, surfaceId }: { origin: string; surfaceId: string },
	operation: WireDataOperation,
): Promise<Result<TResult, DataOperationError>> {
	let envelope: WireDataResponse;
	let status: number;
	try {
		const response = await fetch(new URL(DATA_ROUTE, origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ surfaceId, operation }),
		});
		status = response.status;
		envelope = (await response.json()) as WireDataResponse;
	} catch (cause) {
		return DataErrors.DataFailed({ operation: operation.kind, cause });
	}
	if (envelope.error !== null) {
		// The host answers a missing data owner and a refused operation the same
		// way it answers a bad patch: a named error. Only the first is a claim
		// about the system, so only the first becomes "unavailable".
		return envelope.error.name === 'DesktopEpicenterUnavailable'
			? DataErrors.DataUnavailable({ message: envelope.error.message })
			: DataErrors.DataFailed({
					operation: operation.kind,
					cause: `${envelope.error.name}: ${envelope.error.message}`,
				});
	}
	if (status >= 400) {
		return DataErrors.DataFailed({
			operation: operation.kind,
			cause: new Error(`Epicenter data answered HTTP ${status}`),
		});
	}
	return Ok(envelope.data as TResult);
}

/**
 * The one host surface this document holds, and the carrier that keeps it live.
 *
 * Every binding in the document shares all of it: one `surfaceId` the host
 * registered once, one socket carrying one copy of the invalidation stream, and
 * one dispatcher that fans that stream out to whichever handles are subscribed.
 */
type DataTransport = {
	origin: string;
	surfaceId: string;
	observation: InvalidationDispatcher;
	carrier: ObservationCarrier;
	/** How many bindings are still holding this transport. */
	bindings: number;
};

let heldTransport: DataTransport | undefined;
/**
 * The acquisition in flight, so binds in the same tick share one host `open`
 * and one dial rather than racing to register two surfaces.
 */
let pendingTransport: Promise<Result<DataTransport, BindDataError>> | undefined;

async function openTransport(): Promise<Result<DataTransport, BindDataError>> {
	const origin = originOf();
	const surfaceId = crypto.randomUUID();
	const surface = { origin, surfaceId };
	const observation = createInvalidationDispatcher();

	const opened = await request<void>(surface, { kind: 'open' });
	if (opened.error !== null) return Err(opened.error);
	// The carrier is established before this resolves. That ordering is the whole
	// reason `bind` is asynchronous: once a caller holds a handle, subscribing and
	// then reading cannot straddle a gap.
	let carrier: ObservationCarrier;
	try {
		carrier = await openObservationCarrier({
			observation,
			dial: () => {
				if (typeof WebSocket === 'undefined') {
					throw new Error('Epicenter data observation requires WebSocket');
				}
				return new WebSocket(observeUrl(origin));
			},
		});
	} catch (cause) {
		// `open` registered this surface before the carrier dial failed. Close that
		// registration before declining, or every failed bind leaves a host-owned
		// surface behind until the process exits.
		const released = await request<void>(surface, { kind: 'disconnect' });
		// A cleanup that also failed is named rather than substituted: the carrier
		// is still the reason this bind produced no handle, and it is the one an
		// app author can act on.
		const leaked =
			released.error === null
				? ''
				: ` The host surface it had already opened could not be released either: ${released.error.message}`;
		return DataErrors.DataUnavailable({
			message: `Epicenter is present but its data observation carrier would not open, so a bound handle could not promise to report changes: ${extractErrorMessage(cause)}${leaked}`,
		});
	}
	return Ok({ origin, surfaceId, observation, carrier, bindings: 0 });
}

/**
 * Join the document's transport, opening one if there is none.
 *
 * A caller that is answered `Ok` has already been counted; it owes exactly one
 * {@link releaseTransport}. A failed acquisition is forgotten rather than
 * remembered, so a bind after the host comes back dials again instead of
 * replaying the old refusal forever.
 */
async function acquireTransport(): Promise<
	Result<DataTransport, BindDataError>
> {
	if (heldTransport !== undefined) {
		heldTransport.bindings += 1;
		return Ok(heldTransport);
	}
	pendingTransport ??= openTransport().then(
		(opened) => {
			pendingTransport = undefined;
			if (opened.error === null) heldTransport = opened.data;
			return opened;
		},
		(cause: unknown) => {
			pendingTransport = undefined;
			throw cause;
		},
	);
	const acquired = await pendingTransport;
	if (acquired.error !== null) return acquired;
	// Counted after the await rather than inside `openTransport`, so every caller
	// that joined the same in-flight acquisition is counted exactly once.
	acquired.data.bindings += 1;
	return acquired;
}

/**
 * Give back one binding's hold, and tear the transport down if it was the last.
 *
 * The shared slot is cleared before the host is told, so a bind that arrives
 * during the teardown opens a fresh surface rather than joining a closing one.
 */
async function releaseTransport(held: DataTransport): Promise<void> {
	held.bindings -= 1;
	if (held.bindings > 0) return;
	if (heldTransport === held) heldTransport = undefined;
	held.carrier.close();
	// Deliberately not routed through the binding's `call`: the host should hear
	// that this surface is gone even though no further operation may be issued.
	await request<void>(held, { kind: 'disconnect' });
}

/** What `subscribe` answers on a closed binding: nothing was installed. */
const NOT_SUBSCRIBED: Unsubscribe = () => undefined;

/** The one data namespace. */
export const data: DataNamespace = { bind };

async function bind<
	const TTables extends TableDefinitions,
	const TValues extends ValueDefinitions,
>(
	lens: Lens<TTables, TValues>,
): Promise<Result<BoundData<TTables, TValues>, BindDataError>> {
	if (!hostIsReachable()) {
		return HostErrors.HostUnavailable({ operation: 'data.bind' });
	}
	const acquired = await acquireTransport();
	if (acquired.error !== null) return Err(acquired.error);
	const transport = acquired.data;
	const { observation } = transport;
	let isClosed = false;

	function call<TResult>(
		operation: WireDataOperation,
	): Promise<Result<TResult, DataOperationError>> {
		if (isClosed) {
			return Promise.resolve(
				DataErrors.DataFailed({
					operation: operation.kind,
					cause: new Error('This data binding is closed'),
				}),
			);
		}
		return request<TResult>(transport, operation);
	}

	/**
	 * Remember one listener this binding installed on the shared dispatcher.
	 *
	 * The dispatcher outlives this binding, so `close()` has to take back exactly
	 * what this binding put in. Clearing the dispatcher, which is what a
	 * per-binding carrier could afford to do, would silence every other binding
	 * in the document.
	 */
	const installed = new Set<Unsubscribe>();
	function retain(unsubscribe: () => void): Unsubscribe {
		const release: Unsubscribe = () => {
			if (!installed.delete(release)) return;
			unsubscribe();
		};
		installed.add(release);
		return release;
	}

	const tables = Object.fromEntries(
		Object.entries(lens.tables).map(([tableName, definition]) => [
			tableName,
			createTableHandle(lens.namespace, tableName, definition),
		]),
	);
	const values = Object.fromEntries(
		Object.entries(lens.values).map(([valueName, definition]) => [
			valueName,
			createValueHandle(lens.namespace, valueName, definition),
		]),
	);

	const bound: BoundData<TTables, TValues> = {
		tables: Object.freeze(tables) as BoundData<TTables, TValues>['tables'],
		values: Object.freeze(values) as BoundData<TTables, TValues>['values'],
		async close() {
			if (isClosed) return;
			isClosed = true;
			for (const release of [...installed]) release();
			await releaseTransport(transport);
		},
	};
	return Ok(Object.freeze(bound));

	function createTableHandle<TDefinition extends TableDefinition>(
		namespace: string,
		tableName: string,
		definition: TDefinition,
	): TableHandle<TDefinition> {
		const wire = serializeTableDefinition(namespace, tableName, definition);
		const addressOf = (rowId: string): RowAddress => ({
			kind: 'row',
			namespace,
			tableName,
			rowId,
		});

		const readEntriesPage = (after?: string) =>
			call<WireEntriesPage>({
				kind: 'table-entries-page',
				definition: wire,
				...(after === undefined ? {} : { after }),
			});

		async function* entries(): AsyncIterable<TableEntry<TDefinition>> {
			let after: string | undefined;
			do {
				const page = await readEntriesPage(after);
				if (page.error !== null) throw page.error;
				// The host already classified each entry as an ordinary Result; this
				// only names the row type the caller's Lens gives it.
				const entries = page.data.entries as TableEntry<TDefinition>[];
				for (const entry of entries) yield entry;
				after = page.data.nextAfter;
			} while (after !== undefined);
		}

		return Object.freeze({
			create: (fields: CreateInputFor<TDefinition>) =>
				call<RowFor<TDefinition>>({
					kind: 'table-create',
					definition: wire,
					fields: fields as Record<string, unknown>,
				}),
			async get(rowId: string) {
				const answered = await call<
					Result<RowFor<TDefinition> | undefined, NonconformingRowError>
				>({ kind: 'table-get', definition: wire, address: addressOf(rowId) });
				return answered.error !== null ? Err(answered.error) : answered.data;
			},
			async update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				const answered = await call<
					Result<RowFor<TDefinition> | undefined, NonconformingRowError>
				>({
					kind: 'table-update',
					definition: wire,
					address: addressOf(rowId),
					...splitUpdate(patch),
				});
				return answered.error !== null ? Err(answered.error) : answered.data;
			},
			delete: (rowId: string) =>
				call<boolean>({
					kind: 'table-delete',
					definition: wire,
					address: addressOf(rowId),
				}),
			async scan() {
				const rows: RowFor<TDefinition>[] = [];
				const nonconforming: NonconformingRowError[] = [];
				let after: string | undefined;
				do {
					const page = await readEntriesPage(after);
					if (page.error !== null) return Err(page.error);
					const entries = page.data.entries as TableEntry<TDefinition>[];
					for (const entry of entries) {
						if (entry.error === null) rows.push(entry.data);
						else nonconforming.push(entry.error);
					}
					after = page.data.nextAfter;
				} while (after !== undefined);
				return Ok({ rows, nonconforming });
			},
			entries,
			subscribe: (listener: (invalidation: TableInvalidation) => void) =>
				isClosed
					? NOT_SUBSCRIBED
					: retain(observation.subscribeTable(namespace, tableName, listener)),
		}) as TableHandle<TDefinition>;
	}

	function createValueHandle<TDefinition extends ValueDefinition>(
		namespace: string,
		valueName: string,
		definition: TDefinition,
	): ValueHandle<TDefinition> {
		const address: ValueAddress = { kind: 'value', namespace, valueName };
		const wire = serializeValueDefinition(address, definition);
		return Object.freeze({
			async get() {
				const answered = await call<
					Result<ValueFor<TDefinition> | undefined, DataReadError>
				>({ kind: 'value-get', definition: wire, address });
				return answered.error !== null ? Err(answered.error) : answered.data;
			},
			set: (value: ValueFor<TDefinition>) =>
				call<void>({ kind: 'value-set', definition: wire, address, value }),
			unset: () =>
				call<void>({ kind: 'value-unset', definition: wire, address }),
			subscribe: (listener: () => void) =>
				isClosed
					? NOT_SUBSCRIBED
					: retain(observation.subscribeValue(address, listener)),
		}) as ValueHandle<TDefinition>;
	}
}
