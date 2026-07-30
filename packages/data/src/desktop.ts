import {
	type ConstrainedUpdate,
	type CreateInputFor,
	createInvalidationDispatcher,
	type Lens,
	type ObservationCarrier,
	type ObservationSocket,
	openObservationCarrier,
	type RowFor,
	serializeTableDefinition,
	serializeValueDefinition,
	splitUpdate,
	type TableDefinition,
	type TableDefinitions,
	type TableInvalidation,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from '@epicenter/lens';
import * as Y from '@y/y';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import {
	type DesktopOperation,
	type DesktopRequest,
	type DesktopResponse,
	desktopEpicenterObserveUrl,
	desktopEpicenterUrl,
	type SerializedTableDefinition,
} from './desktop-protocol.js';
import {
	type RowDocument,
	registerRowDocumentConnectionTarget,
} from './documents.js';
import {
	type BoundData,
	createTableReadMethods,
	type TableEntriesPage,
	type TableLens,
	type ValueLens,
} from './epicenter.js';
import type { JsonValue, RowAddress, ValueAddress } from './protocol/index.js';

export type OpenDesktopEpicenterOptions = {
	baseUrl?: string;
	fetch?: (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	) => Promise<Response>;
	/**
	 * Open the observation carrier. Defaults to a same-origin `WebSocket`, whose
	 * session cookie and `Origin` header are what the host checks.
	 */
	createObservationSocket?(url: string): ObservationSocket;
	/**
	 * How long to wait before redialing after the carrier drops. Called with the
	 * number of consecutive failures, starting at 1.
	 */
	reconnectDelayMs?(attempt: number): number;
	log?: Logger;
};

const remoteDocumentOrigin = Object.freeze({ kind: 'desktop-document-remote' });

/**
 * Open one trusted WebView proxy to the Bun-owned desktop Epicenter.
 *
 * A surface reaches this by being compiled for the desktop host, never by
 * detecting one. The build that the host serves is selected by the `tauri`
 * resolve condition, so the module that names this opener is already the answer
 * to "is this a desktop surface"; asking the DOM the same question at runtime
 * would only be a second, weaker copy of a fact the bundler already fixed.
 */
export async function openDesktopEpicenter({
	baseUrl = defaultOrigin(),
	fetch: fetchInput = globalThis.fetch,
	createObservationSocket = defaultObservationSocket,
	reconnectDelayMs,
	log = createLogger('data/desktop'),
}: OpenDesktopEpicenterOptions = {}) {
	const surfaceId = crypto.randomUUID();
	const observation = createInvalidationDispatcher({ log });
	const documents = new Set<RowDocument>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Desktop Epicenter is disposed');
	}

	async function request<TResult>(
		operation: DesktopOperation,
	): Promise<TResult> {
		requireOpen();
		const response = await fetchInput(desktopEpicenterUrl(baseUrl), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ surfaceId, operation } satisfies DesktopRequest),
		});
		const envelope = (await response.json()) as DesktopResponse;
		if (!response.ok || envelope.error !== null) {
			const cause = new Error(
				envelope.error?.message ?? `Desktop Epicenter HTTP ${response.status}`,
			);
			if (envelope.error !== null) cause.name = envelope.error.name;
			throw cause;
		}
		return envelope.data as TResult;
	}

	// Order matters, and it is the whole of law 7. The carrier is established
	// before this opener resolves, so by the time an app holds a handle it can
	// subscribe and then read with nothing able to land in between. That is what
	// buys the right to promise no initial fire: there is no gap to cover.
	await request<void>({ kind: 'open' });
	let carrier: ObservationCarrier;
	try {
		carrier = await openObservationCarrier({
			observation,
			dial: () => createObservationSocket(desktopEpicenterObserveUrl(baseUrl)),
			redialDelayMs: reconnectDelayMs,
			log,
		});
	} catch (cause) {
		// `open` registered this surface before the carrier dial failed. Release
		// that registration before rejecting the opener. Cleanup failure is
		// reported rather than thrown: it must not displace the carrier failure
		// that explains why no handle was returned.
		try {
			await request<void>({ kind: 'disconnect' });
		} catch (disconnectCause) {
			log.error(
				new Error(
					'Desktop Epicenter could not release a failed surface registration',
					{ cause: disconnectCause },
				),
			);
		}
		isDisposed = true;
		throw new Error(
			`Desktop Epicenter could not open its observation carrier: ${extractErrorMessage(cause)}`,
			{ cause },
		);
	}

	function bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>(lens: Lens<TTables, TValues>): BoundData<TTables, TValues> {
		requireOpen();
		return Object.freeze({
			tables: Object.freeze(
				Object.fromEntries(
					Object.entries(lens.tables).map(([table, definition]) => [
						table,
						createTableLens(lens.namespace, table, definition),
					]),
				),
			),
			values: Object.freeze(
				Object.fromEntries(
					Object.entries(lens.values).map(([value, definition]) => [
						value,
						createValueLens(lens.namespace, value, definition),
					]),
				),
			),
		}) as BoundData<TTables, TValues>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		table: string,
		definition: TDefinition,
	): TableLens<TDefinition> {
		const serialized = serializeTableDefinition(namespace, table, definition);
		const readEntriesPage = (after?: string) =>
			request<TableEntriesPage<TDefinition>>({
				kind: 'table-entries-page',
				definition: serialized,
				...(after === undefined ? {} : { after }),
			});
		const lens = {
			create(fields: CreateInputFor<TDefinition>) {
				return request<RowFor<TDefinition>>({
					kind: 'table-create',
					definition: serialized,
					fields,
				});
			},
			get(rowId: string) {
				const address = rowAddress(namespace, table, rowId);
				return request<Awaited<ReturnType<TableLens<TDefinition>['get']>>>({
					kind: 'table-get',
					definition: serialized,
					address,
				});
			},
			update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				const address = rowAddress(namespace, table, rowId);
				return request<Awaited<ReturnType<TableLens<TDefinition>['update']>>>({
					kind: 'table-update',
					definition: serialized,
					address,
					...splitUpdate(patch),
				});
			},
			delete(rowId: string) {
				const address = rowAddress(namespace, table, rowId);
				return request<boolean>({
					kind: 'table-delete',
					definition: serialized,
					address,
				});
			},
			...createTableReadMethods(readEntriesPage),
			subscribe(listener: (invalidation: TableInvalidation) => void) {
				requireOpen();
				return observation.subscribeTable(namespace, table, listener);
			},
			openDocument: (rowId: string) => openDocument(serialized, rowId),
		};
		return Object.freeze(lens) as TableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		namespace: string,
		valueName: string,
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const address: ValueAddress = {
			kind: 'value',
			namespace,
			valueName: valueName,
		};
		const serialized = serializeValueDefinition(address, definition);
		return Object.freeze({
			get: () =>
				request<Awaited<ReturnType<ValueLens<TDefinition>['get']>>>({
					kind: 'value-get',
					definition: serialized,
					address,
				}),
			set(value: ValueFor<TDefinition>) {
				return request<void>({
					kind: 'value-set',
					definition: serialized,
					address,
					value: value as JsonValue,
				});
			},
			unset() {
				return request<void>({
					kind: 'value-unset',
					definition: serialized,
					address,
				});
			},
			subscribe(listener: () => void) {
				requireOpen();
				return observation.subscribeValue(address, listener);
			},
		});
	}

	async function openDocument(
		definition: SerializedTableDefinition,
		rowId: string,
	): Promise<RowDocument> {
		const opened = await request<{ documentId: number; update: string }>({
			kind: 'document-open',
			definition,
			address: rowAddress(definition.namespace, definition.table, rowId),
		});
		const document = new Y.Doc({ gc: true });
		let disposed = false;
		let persistenceTail = Promise.resolve();
		let refreshFailure: unknown;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				const update = await request<string>({
					kind: 'document-refresh',
					documentId: opened.documentId,
				});
				if (!disposed) {
					Y.applyUpdateV2(document, decodeBytes(update), remoteDocumentOrigin);
				}
			} catch (cause) {
				refreshFailure = cause;
			} finally {
				if (!disposed && !isDisposed) {
					refreshTimer = setTimeout(() => void refresh(), 500);
				}
			}
		};
		let persistFailure: Error | undefined;
		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === remoteDocumentOrigin) return;
			persistenceTail = persistenceTail.then(() =>
				request<void>({
					kind: 'document-update',
					documentId: opened.documentId,
					update: encodeBytes(update),
				}).catch((cause) => {
					// Fail closed: once the owner has missed an edit, later edits
					// would silently diverge from durable state.
					persistFailure ??= new Error(
						'Row document persistence failed; the handle is closed to protect durable state',
						{ cause },
					);
				}),
			);
		};
		document.on('updateV2', persist);
		Y.applyUpdateV2(document, decodeBytes(opened.update), remoteDocumentOrigin);
		refreshTimer = setTimeout(() => void refresh(), 500);

		const handle: RowDocument = {
			get: document.get.bind(document),
			transact: document.transact.bind(document),
			async whenDurable() {
				await persistenceTail;
				if (persistFailure !== undefined) throw persistFailure;
				if (refreshFailure !== undefined) throw refreshFailure;
			},
			async pull() {
				// The Bun owner runs the pull: overlap safety, the version cache,
				// and the accepted-origin apply all live with the owner document.
				await persistenceTail;
				if (persistFailure !== undefined) throw persistFailure;
				return request<Awaited<ReturnType<RowDocument['pull']>>>({
					kind: 'document-pull',
					documentId: opened.documentId,
				});
			},
			async syncIssue() {
				return request<Awaited<ReturnType<RowDocument['syncIssue']>>>({
					kind: 'document-issue',
					documentId: opened.documentId,
				});
			},
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				documents.delete(handle);
				clearTimeout(refreshTimer);
				document.off('updateV2', persist);
				await persistenceTail;
				if (!isDisposed) {
					await request<void>({
						kind: 'document-close',
						documentId: opened.documentId,
					});
				}
				document.destroy();
			},
		};
		registerRowDocumentConnectionTarget(handle, {
			address: rowAddress(definition.namespace, definition.table, rowId),
			applyUpdate(update, origin) {
				Y.applyUpdateV2(document, update, origin);
			},
			encodeStateAsUpdate: () =>
				new Uint8Array(Y.encodeStateAsUpdateV2(document)),
			observe(listener) {
				document.on('updateV2', listener);
				return () => document.off('updateV2', listener);
			},
		});
		documents.add(handle);
		return handle;
	}

	return Object.freeze({
		bind,
		async attachSync() {
			throw new Error('Desktop synchronization is owned by the Bun host');
		},
		get syncStatus() {
			return { state: 'local' as const, lastError: undefined };
		},
		subscribeSyncStatus() {
			return () => undefined;
		},
		async [Symbol.asyncDispose]() {
			if (isDisposed) return;
			for (const document of [...documents]) {
				await document[Symbol.asyncDispose]();
			}
			await request<void>({ kind: 'disconnect' });
			isDisposed = true;
			carrier.close();
		},
	});
}

function defaultOrigin(): string {
	const location = (globalThis as { location?: { origin?: unknown } }).location;
	if (typeof location?.origin !== 'string') {
		throw new Error('Desktop Epicenter requires an explicit baseUrl');
	}
	return location.origin;
}

function rowAddress(
	namespace: string,
	tableName: string,
	rowId: string,
): RowAddress {
	return { kind: 'row', namespace, tableName, rowId };
}

function decodeBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBytes(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function defaultObservationSocket(url: string): ObservationSocket {
	if (typeof WebSocket === 'undefined') {
		throw new Error(
			'Desktop Epicenter requires WebSocket for live data observation',
		);
	}
	return new WebSocket(url);
}

export type { ObservationSocket } from '@epicenter/lens';
export type {
	DesktopInvalidationFrame,
	DesktopRequest,
	DesktopResponse,
} from './desktop-protocol.js';
export {
	DESKTOP_EPICENTER_OBSERVE_ROUTE,
	DESKTOP_EPICENTER_ROUTE,
	describeThrownError,
} from './desktop-protocol.js';
