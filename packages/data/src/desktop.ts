import * as Y from '@y/y';
import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
	type Lens,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
import {
	type DesktopOperation,
	type DesktopRequest,
	type DesktopResponse,
	desktopEpicenterUrl,
	type SerializedTableDefinition,
	type SerializedValueDefinition,
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
import {
	addressKey,
	type JsonValue,
	type RowAddress,
	type ValueAddress,
} from './protocol/index.js';

export type OpenDesktopEpicenterOptions = {
	baseUrl?: string;
	fetch?: (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	) => Promise<Response>;
};

const remoteDocumentOrigin = Object.freeze({ kind: 'desktop-document-remote' });

/** Open one trusted WebView proxy to the Bun-owned desktop Epicenter. */
export async function openDesktopEpicenter({
	baseUrl = defaultOrigin(),
	fetch: fetchInput = globalThis.fetch,
}: OpenDesktopEpicenterOptions = {}) {
	const surfaceId = crypto.randomUUID();
	const tableListeners = new Map<
		string,
		Map<string, Set<(changedIds: string[]) => void>>
	>();
	const valueListeners = new Map<string, Set<() => void>>();
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

	await request<void>({ kind: 'open' });

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

	function notifyTable(address: RowAddress): void {
		for (const listener of tableListeners
			.get(address.namespace)
			?.get(address.tableName) ?? [])
			listener([address.rowId]);
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		table: string,
		definition: TDefinition,
	): TableLens<TDefinition> {
		const serialized = serializeTableDefinition(namespace, table, definition);
		const tableListenerGroup = tableListeners.get(namespace) ?? new Map();
		tableListeners.set(namespace, tableListenerGroup);
		const readEntriesPage = (after?: string) =>
			request<TableEntriesPage<TDefinition>>({
				kind: 'table-entries-page',
				definition: serialized,
				...(after === undefined ? {} : { after }),
			});
		const lens = {
			async create(fields: CreateInputFor<TDefinition>) {
				const row = await request<RowFor<TDefinition>>({
					kind: 'table-create',
					definition: serialized,
					fields,
				});
				notifyTable(rowAddress(namespace, table, row.id));
				return row;
			},
			get(rowId: string) {
				const address = rowAddress(namespace, table, rowId);
				return request<Awaited<ReturnType<TableLens<TDefinition>['get']>>>({
					kind: 'table-get',
					definition: serialized,
					address,
				});
			},
			async update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				const address = rowAddress(namespace, table, rowId);
				const result = await request<
					Awaited<ReturnType<TableLens<TDefinition>['update']>>
				>({ kind: 'table-update', definition: serialized, address, patch });
				if (result.error === null && result.data !== undefined) {
					notifyTable(address);
				}
				return result;
			},
			async delete(rowId: string) {
				const address = rowAddress(namespace, table, rowId);
				const deleted = await request<boolean>({
					kind: 'table-delete',
					definition: serialized,
					address,
				});
				if (deleted) notifyTable(address);
				return deleted;
			},
			...createTableReadMethods(readEntriesPage),
			subscribe(listener: (changedIds: string[]) => void) {
				const listeners = tableListenerGroup.get(table) ?? new Set();
				listeners.add(listener);
				tableListenerGroup.set(table, listeners);
				return () => listeners.delete(listener);
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
		const listenerKey = addressKey(address);
		const serialized = serializeValueDefinition(address, definition);
		return Object.freeze({
			get: () =>
				request<Awaited<ReturnType<ValueLens<TDefinition>['get']>>>({
					kind: 'value-get',
					definition: serialized,
					address,
				}),
			async set(value: ValueFor<TDefinition>) {
				await request<void>({
					kind: 'value-set',
					definition: serialized,
					address,
					value: value as JsonValue,
				});
				for (const listener of valueListeners.get(listenerKey) ?? [])
					listener();
			},
			async unset() {
				await request<void>({
					kind: 'value-unset',
					definition: serialized,
					address,
				});
				for (const listener of valueListeners.get(listenerKey) ?? [])
					listener();
			},
			subscribe(listener: () => void) {
				const listeners = valueListeners.get(listenerKey) ?? new Set();
				listeners.add(listener);
				valueListeners.set(listenerKey, listeners);
				return () => listeners.delete(listener);
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
			// The Bun host owns synchronization for this surface, so it owns the
			// parked diagnostics too; nothing is ever parked on this side.
			return {
				state: 'local' as const,
				lastError: undefined,
				parked: [] as const,
			};
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
			tableListeners.clear();
			valueListeners.clear();
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

function serializeTableDefinition(
	namespace: string,
	table: string,
	definition: TableDefinition,
): SerializedTableDefinition {
	const compiled = compileTableDefinition(definition);
	return {
		namespace,
		table,
		fields: cloneJson(definition.fields),
		optionalFields: [...compiled.optional],
	};
}

function serializeValueDefinition(
	address: ValueAddress,
	definition: ValueDefinition,
): SerializedValueDefinition {
	compileValueDefinition(definition);
	return { address, value: cloneJson(definition.value) };
}

function rowAddress(
	namespace: string,
	tableName: string,
	rowId: string,
): RowAddress {
	return { kind: 'row', namespace, tableName, rowId };
}

function cloneJson<TValue>(value: TValue): TValue {
	return JSON.parse(JSON.stringify(value)) as TValue;
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

export type { DesktopRequest, DesktopResponse } from './desktop-protocol.js';
export { DESKTOP_EPICENTER_ROUTE } from './desktop-protocol.js';
