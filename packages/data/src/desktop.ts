import * as Y from '@y/y';
import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
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
import type {
	BoundData,
	ListOptions,
	ListPage,
	TableLens,
	ValueLens,
} from './epicenter.js';
import type { JsonValue } from './protocol/index.js';

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
	const tableListeners = new Map<string, Set<(changedIds: string[]) => void>>();
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
	>({
		tables,
		values,
	}: {
		tables: TTables;
		values: TValues;
	}): BoundData<TTables, TValues> {
		requireOpen();
		return Object.freeze({
			tables: Object.freeze(
				Object.fromEntries(
					Object.entries(tables).map(([name, definition]) => [
						name,
						createTableLens(definition),
					]),
				),
			),
			values: Object.freeze(
				Object.fromEntries(
					Object.entries(values).map(([name, definition]) => [
						name,
						createValueLens(definition),
					]),
				),
			),
		}) as BoundData<TTables, TValues>;
	}

	function notifyTable(namespace: string, table: string, rowId: string): void {
		for (const listener of tableListeners.get(
			tableListenerAddress(namespace, table),
		) ?? []) {
			listener([rowId]);
		}
	}

	function createTableLens<TDefinition extends TableDefinition>(
		definition: TDefinition,
	): TableLens<TDefinition> {
		const serialized = serializeTableDefinition(definition);
		const lens = {
			async create(fields: CreateInputFor<TDefinition>) {
				const row = await request<RowFor<TDefinition>>({
					kind: 'table-create',
					definition: serialized,
					fields,
				});
				notifyTable(definition.namespace, definition.table, row.id);
				return row;
			},
			get(rowId: string) {
				return request<Awaited<ReturnType<TableLens<TDefinition>['get']>>>({
					kind: 'table-get',
					definition: serialized,
					rowId,
				});
			},
			async update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				const result = await request<
					Awaited<ReturnType<TableLens<TDefinition>['update']>>
				>({ kind: 'table-update', definition: serialized, rowId, patch });
				if (result.error === null && result.data !== undefined) {
					notifyTable(definition.namespace, definition.table, rowId);
				}
				return result;
			},
			async delete(rowId: string) {
				const deleted = await request<boolean>({
					kind: 'table-delete',
					definition: serialized,
					rowId,
				});
				if (deleted) {
					notifyTable(definition.namespace, definition.table, rowId);
				}
				return deleted;
			},
			list(options: ListOptions<TDefinition> = {}) {
				return request<ListPage<TDefinition>>({
					kind: 'table-list',
					definition: serialized,
					options,
				});
			},
			subscribe(listener: (changedIds: string[]) => void) {
				const listenerAddress = tableListenerAddress(
					definition.namespace,
					definition.table,
				);
				const listeners = tableListeners.get(listenerAddress) ?? new Set();
				listeners.add(listener);
				tableListeners.set(listenerAddress, listeners);
				return () => listeners.delete(listener);
			},
			openDocument: (rowId: string) => openDocument(serialized, rowId),
		};
		return Object.freeze(lens) as TableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const serialized = serializeValueDefinition(definition);
		return Object.freeze({
			get: () =>
				request<Awaited<ReturnType<ValueLens<TDefinition>['get']>>>({
					kind: 'value-get',
					definition: serialized,
				}),
			async set(value: ValueFor<TDefinition>) {
				await request<void>({
					kind: 'value-set',
					definition: serialized,
					value: value as JsonValue,
				});
				const listenerAddress = valueListenerAddress(
					definition.namespace,
					definition.value,
				);
				for (const listener of valueListeners.get(listenerAddress) ?? [])
					listener();
			},
			async unset() {
				await request<void>({ kind: 'value-unset', definition: serialized });
				const listenerAddress = valueListenerAddress(
					definition.namespace,
					definition.value,
				);
				for (const listener of valueListeners.get(listenerAddress) ?? [])
					listener();
			},
			subscribe(listener: () => void) {
				const listenerAddress = valueListenerAddress(
					definition.namespace,
					definition.value,
				);
				const listeners = valueListeners.get(listenerAddress) ?? new Set();
				listeners.add(listener);
				valueListeners.set(listenerAddress, listeners);
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
			rowId,
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
		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === remoteDocumentOrigin) return;
			persistenceTail = persistenceTail.then(() =>
				request<void>({
					kind: 'document-update',
					documentId: opened.documentId,
					update: encodeBytes(update),
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
				if (refreshFailure !== undefined) throw refreshFailure;
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
			address: {
				namespace: definition.namespace,
				table: definition.table,
				rowId,
			},
			applyUpdate(update, origin) {
				Y.applyUpdateV2(document, update, origin);
			},
			encodeStateVector: () => new Uint8Array(Y.encodeStateVector(document)),
			encodeStateAsUpdate: (stateVector) =>
				new Uint8Array(Y.encodeStateAsUpdateV2(document, stateVector)),
			observe(listener) {
				document.on('updateV2', listener);
				return () => document.off('updateV2', listener);
			},
			subscribeRevocation: () => () => undefined,
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
	definition: TableDefinition,
): SerializedTableDefinition {
	const compiled = compileTableDefinition(definition);
	return {
		namespace: definition.namespace,
		table: definition.table,
		fields: cloneJson(definition.fields),
		optionalFields: [...compiled.optional],
	};
}

function serializeValueDefinition(
	definition: ValueDefinition,
): SerializedValueDefinition {
	compileValueDefinition(definition);
	return {
		namespace: definition.namespace,
		value: definition.value,
		schema: cloneJson(definition.schema),
	};
}

function tableListenerAddress(namespace: string, table: string): string {
	return `${namespace}\0${table}`;
}

function valueListenerAddress(namespace: string, value: string): string {
	return `${namespace}\0${value}`;
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
