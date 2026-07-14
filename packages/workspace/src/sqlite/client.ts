import type { SnapshotRow } from '@epicenter/record-sync';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { Guid } from '../shared/id.js';
import {
	assertWorkspaceDefinition,
	type RowFor,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
import type {
	OpenedDocument,
	WorkspaceDocumentOpener,
} from './document-client.js';
import type { DocumentFormat } from './document-format.js';
import { createDocumentGuidIdentity } from './document-guid.js';
import type {
	TableListOptions,
	WorkspaceCommitDelta,
	WorkspaceMutation,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './service-protocol.js';

export type {
	TableListOptions,
	WorkspaceCommitDelta,
	WorkspaceMutation,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './service-protocol.js';

/** Runtime brand that lets transitional reactive adapters avoid probe reads. */
export const asyncWorkspaceHandle = Symbol('epicenter.asyncWorkspaceHandle');

export type TableCommitDelta<
	TRow extends { id: string } = { id: string } & Record<string, unknown>,
> = {
	upserted: readonly TRow[];
	removed: readonly string[];
};

/** Async boundary implemented by a browser worker, Bun service, or test port. */
export type WorkspaceServicePort = {
	request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResponse>;
	/** Register locally before returning; never round-trip to subscribe. */
	observe(callback: (delta: WorkspaceCommitDelta) => void): () => void;
};

/** One declared child document, openable when the workspace has a runtime. */
type AsyncTableDoc<
	TFormat extends DocumentFormat = DocumentFormat,
	TRowId extends string = string,
	TDocumentOpener extends WorkspaceDocumentOpener | undefined = undefined,
> = {
	guid(rowId: TRowId): Guid;
} & (TDocumentOpener extends WorkspaceDocumentOpener
	? { open(rowId: TRowId): OpenedDocument<TFormat> }
	: object);

type AsyncTableDocs<
	TDocs extends Readonly<Record<string, DocumentFormat>>,
	TRowId extends string = string,
	TDocumentOpener extends WorkspaceDocumentOpener | undefined = undefined,
> = {
	readonly [K in keyof TDocs]: AsyncTableDoc<TDocs[K], TRowId, TDocumentOpener>;
};

export type AsyncTable<
	TRow extends { id: string },
	TDocs extends Readonly<Record<string, DocumentFormat>> = Readonly<
		Record<string, DocumentFormat>
	>,
	TDocumentOpener extends WorkspaceDocumentOpener | undefined = undefined,
> = {
	readonly [asyncWorkspaceHandle]: 'table';
	get(id: TRow['id']): Promise<TRow | null>;
	list(options?: {
		where?: Partial<TRow>;
		orderBy?: keyof TRow & string;
		desc?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<TRow[]>;
	has(id: TRow['id']): Promise<boolean>;
	count(): Promise<number>;
	/** Allocate a fresh UUID and return the committed row. */
	create(cells: CreateInput<TRow>): Promise<TRow>;
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): Promise<TRow | null>;
	remove(id: TRow['id']): Promise<void>;
	observe(callback: (delta: TableCommitDelta<TRow>) => void): () => void;
	/** Child-document identity and, when mounted, its typed opener. */
	readonly docs: AsyncTableDocs<TDocs, TRow['id'], TDocumentOpener>;
};

export type AsyncTables<
	TTables extends TableDefinitions,
	TDocumentOpener extends WorkspaceDocumentOpener | undefined = undefined,
> = {
	[K in keyof TTables]: AsyncTable<
		RowFor<TTables[K]>,
		TTables[K]['documents'],
		TDocumentOpener
	>;
};

type BatchTable<TRow extends { id: string }> = {
	create(cells: CreateInput<TRow>): TRow['id'];
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): void;
	remove(id: TRow['id']): void;
};

type CreateInput<TRow extends { id: string }> = Omit<TRow, 'id'> & {
	id?: never;
};

export type WorkspaceWriteBatch<TTables extends TableDefinitions> = {
	tables: { [K in keyof TTables]: BatchTable<RowFor<TTables[K]>> };
};

export type AsyncWorkspace<
	TTables extends TableDefinitions,
	TDocumentOpener extends WorkspaceDocumentOpener | undefined = undefined,
> = {
	tables: AsyncTables<TTables, TDocumentOpener>;
	/** Read one stable logical snapshot of every live application table. */
	readTablesSnapshot(): Promise<readonly SnapshotRow[]>;
	/** Execute one SELECT and validate every returned row. */
	sql<TResultSchema extends TSchema>(
		query: string,
		parameters: readonly (string | number | null)[],
		resultSchema: TResultSchema,
	): Promise<Static<TResultSchema>[]>;
	/** Run now, then again after commits that touch any declared table. */
	observeSql(
		tables: readonly (keyof TTables & string)[],
		run: () => void,
	): () => void;
	/** Build one serializable, write-only atomic mutation. */
	transact(build: (batch: WorkspaceWriteBatch<TTables>) => void): Promise<void>;
};

export function createWorkspaceClient<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	port: WorkspaceServicePort,
): AsyncWorkspace<TTables, undefined>;
export function createWorkspaceClient<
	TTables extends TableDefinitions,
	TDocumentOpener extends WorkspaceDocumentOpener,
>(
	definition: WorkspaceDefinition<TTables>,
	port: WorkspaceServicePort,
	documents: TDocumentOpener,
): AsyncWorkspace<TTables, TDocumentOpener>;
export function createWorkspaceClient<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	port: WorkspaceServicePort,
	documents?: WorkspaceDocumentOpener,
): AsyncWorkspace<TTables, WorkspaceDocumentOpener | undefined> {
	assertWorkspaceDefinition(definition);
	function rowForTable(
		tableName: string,
		value: unknown,
		expectedId?: string,
	): { id: string } & Record<string, unknown> {
		const table = definition.tables[tableName];
		if (!table || !Value.Check(table.schema, value)) {
			throw new Error(
				`Workspace service returned an invalid '${tableName}' row`,
			);
		}
		const row = value as { id: string } & Record<string, unknown>;
		if (expectedId !== undefined && row.id !== expectedId) {
			throw new Error(
				`Workspace service returned row '${row.id}' for '${tableName}.${expectedId}'`,
			);
		}
		return row;
	}

	function expectResponse<TKind extends WorkspaceServiceResponse['kind']>(
		response: WorkspaceServiceResponse,
		kind: TKind,
	): Extract<WorkspaceServiceResponse, { kind: TKind }> {
		if (response.kind !== kind) {
			throw new Error(
				`Workspace service returned '${response.kind}' for a '${kind}' request`,
			);
		}
		return response as Extract<WorkspaceServiceResponse, { kind: TKind }>;
	}

	async function sendMutations(
		mutations: WorkspaceMutation[],
	): Promise<readonly unknown[]> {
		if (mutations.length === 0) return [];
		const response = await port.request({ kind: 'mutate', mutations });
		const results = expectResponse(response, 'mutation').results;
		if (results.length !== mutations.length) {
			throw new Error(
				'Workspace service returned the wrong mutation result count',
			);
		}
		for (const [index, mutation] of mutations.entries()) {
			const result = results[index];
			if (mutation.kind === 'create') {
				rowForTable(mutation.table, result, mutation.row.id as string);
			} else if (mutation.kind === 'patch') {
				if (result !== null) {
					rowForTable(mutation.table, result, mutation.rowId);
				}
			} else if (result !== null) {
				throw new Error(
					`Workspace service returned a value for '${mutation.kind}'`,
				);
			}
		}
		return results;
	}

	const tables = Object.fromEntries(
		Object.entries(definition.tables).map(([tableName, tableDefinition]) => {
			// Child-document identity is derived from the definition alone. A
			// composed runtime adds opening without changing that identity.
			const docs = Object.fromEntries(
				Object.entries<DocumentFormat>(tableDefinition.documents).map(
					([field, type]) => {
						const identity = createDocumentGuidIdentity({
							workspaceId: definition.workspaceId,
							table: tableName,
							document: field,
							format: type,
						});
						return [
							field,
							documents
								? {
										guid: identity.guid,
										open: (rowId: string) =>
											documents.open({ identity, format: type }, rowId),
									}
								: { guid: identity.guid },
						];
					},
				),
			);
			const table: AsyncTable<{ id: string }> = {
				[asyncWorkspaceHandle]: 'table',
				docs,
				async get(rowId) {
					const response = await port.request({
						kind: 'get',
						table: tableName,
						rowId,
					});
					const row = expectResponse(response, 'row').row;
					return row === null ? null : rowForTable(tableName, row, rowId);
				},
				async list(options) {
					const response = await port.request({
						kind: 'list',
						table: tableName,
						options: options as TableListOptions | undefined,
					});
					return expectResponse(response, 'rows').rows.map((row) =>
						rowForTable(tableName, row),
					);
				},
				async has(rowId) {
					const response = await port.request({
						kind: 'has',
						table: tableName,
						rowId,
					});
					return expectResponse(response, 'boolean').value;
				},
				async count() {
					const response = await port.request({
						kind: 'count',
						table: tableName,
					});
					return expectResponse(response, 'count').value;
				},
				async create(cells) {
					const id = crypto.randomUUID();
					const results = await sendMutations([
						{
							kind: 'create',
							table: tableName,
							row: { ...cells, id },
						},
					]);
					return results[0] as { id: string } & Record<string, unknown>;
				},
				async patch(rowId, cells) {
					const results = await sendMutations([
						{
							kind: 'patch',
							table: tableName,
							rowId,
							cells,
						},
					]);
					return (results[0] ?? null) as { id: string } | null;
				},
				async remove(rowId) {
					await sendMutations([{ kind: 'remove', table: tableName, rowId }]);
				},
				observe(callback) {
					return port.observe((delta) => {
						const tableDelta = delta.tables[tableName];
						if (tableDelta) {
							callback({
								upserted: tableDelta.upserted.map((row) =>
									rowForTable(tableName, row),
								),
								removed: tableDelta.removed,
							} satisfies TableCommitDelta<{ id: string }>);
						}
					});
				},
			};
			return [tableName, table];
		}),
	) as AsyncTables<TTables, WorkspaceDocumentOpener | undefined>;

	return {
		tables,
		async readTablesSnapshot() {
			const response = await port.request({ kind: 'readTablesSnapshot' });
			return expectResponse(response, 'tablesSnapshot').rows;
		},
		async sql(query, parameters, resultSchema) {
			const response = await port.request({
				kind: 'sql',
				query,
				parameters: [...parameters],
			});
			const rows = expectResponse(response, 'sql').rows;
			for (const [index, row] of rows.entries()) {
				if (!Value.Check(resultSchema, row)) {
					throw new Error(`sql() returned an invalid row at index ${index}`);
				}
			}
			return rows as Static<typeof resultSchema>[];
		},
		observeSql(tableNames, run) {
			const watched = new Set<string>();
			for (const tableName of tableNames) {
				if (!Object.hasOwn(definition.tables, tableName)) {
					throw new Error(`Unknown workspace table '${tableName}'`);
				}
				watched.add(tableName);
			}
			const stop = port.observe((delta) => {
				if (Object.keys(delta.tables).some((table) => watched.has(table)))
					run();
			});
			try {
				run();
			} catch (cause) {
				stop();
				throw cause;
			}
			return stop;
		},
		async transact(build) {
			const mutations: WorkspaceMutation[] = [];
			const batchTables = Object.fromEntries(
				Object.keys(definition.tables).map((tableName) => [
					tableName,
					{
						create(cells: Record<string, unknown>) {
							const id = crypto.randomUUID();
							mutations.push({
								kind: 'create',
								table: tableName,
								row: { ...cells, id },
							});
							return id;
						},
						patch(rowId: string, cells: Record<string, unknown>) {
							mutations.push({ kind: 'patch', table: tableName, rowId, cells });
						},
						remove(rowId: string) {
							mutations.push({ kind: 'remove', table: tableName, rowId });
						},
					},
				]),
			) as unknown as WorkspaceWriteBatch<TTables>['tables'];
			const result: unknown = build({
				tables: batchTables,
			});
			if (
				result &&
				typeof (result as PromiseLike<unknown>).then === 'function'
			) {
				void Promise.resolve(result).catch(() => undefined);
				throw new Error('Workspace transaction builders must be synchronous');
			}
			await sendMutations(mutations);
		},
	};
}
