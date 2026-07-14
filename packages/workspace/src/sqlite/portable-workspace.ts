import type { SnapshotRow } from '@epicenter/record-sync';
import { Value } from 'typebox/value';
import type { Kv, KvDefinitions } from '../document/kv.js';
import { sha256Hex } from '../shared/sha256.js';
import type { AsyncWorkspace } from './client.js';
import type { TableDefinitions, WorkspaceDefinition } from './definition.js';
import type { WorkspaceDocumentOpener } from './document-client.js';
import { inspectDocumentFormat } from './document-format.js';
import { createDocumentGuidIdentity } from './document-guid.js';
import type { BlobRef } from './field.js';
import { canonicalJson } from './schema-descriptor.js';
import type { WorkspaceVersionLockEntry } from './workspace-version.js';

export const PORTABLE_WORKSPACE_FORMAT =
	'epicenter.portable-workspace/1' as const;

export type PortableDocument = {
	readonly table: string;
	readonly rowId: string;
	readonly field: string;
	readonly guid: string;
	readonly formatHash: string;
	readonly hash: string;
	readonly bytes: Uint8Array;
};

export type PortableBlob = BlobRef & {
	readonly bytes: Uint8Array;
};

export type PortableWorkspaceContent = {
	readonly rows: readonly SnapshotRow[];
	readonly tablesStateHash: string;
	readonly kv: Readonly<Record<string, unknown>>;
	readonly documents: readonly PortableDocument[];
	readonly blobs: readonly PortableBlob[];
};

export type PortableWorkspaceManifest = {
	readonly format: typeof PORTABLE_WORKSPACE_FORMAT;
	readonly appId: string;
	readonly version: number;
	readonly workspaceId: string;
	readonly lockEntry: WorkspaceVersionLockEntry;
	/** Hash of canonical logical rows, distinct from the SQLite file-byte hash. */
	readonly tablesStateHash: string;
	readonly content: {
		readonly tables: PortableFileManifest & { readonly rows: number };
		readonly kv: PortableFileManifest & { readonly keys: number };
		readonly documents: readonly (PortableFileManifest & {
			readonly table: string;
			readonly rowId: string;
			readonly field: string;
			readonly guid: string;
			readonly formatHash: string;
		})[];
		readonly blobs: readonly (PortableFileManifest & BlobRef)[];
	};
};

export type PortableFileManifest = {
	readonly path: string;
	readonly hash: string;
	readonly size: number;
};

export type TablesApplyMutation =
	| {
			readonly kind: 'create';
			readonly table: string;
			readonly row: Readonly<Record<string, unknown>> & { readonly id: string };
	  }
	| {
			readonly kind: 'patch';
			readonly table: string;
			readonly rowId: string;
			readonly cells: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly kind: 'remove';
			readonly table: string;
			readonly rowId: string;
	  };

export type TablesApplyPlan = {
	readonly mutations: readonly TablesApplyMutation[];
	readonly creates: readonly {
		table: string;
		rowId: string;
		after: Readonly<Record<string, unknown>> & { readonly id: string };
	}[];
	readonly updates: readonly {
		table: string;
		rowId: string;
		changes: Readonly<
			Record<string, { readonly before: unknown; readonly after: unknown }>
		>;
	}[];
	readonly deletes: readonly {
		table: string;
		rowId: string;
		before: Readonly<Record<string, unknown>> & { readonly id: string };
	}[];
	readonly documentFallout: readonly {
		table: string;
		rowId: string;
		field: string;
	}[];
	readonly blobFallout: readonly BlobRef[];
};

type ExportableWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = AsyncWorkspace<TTables, WorkspaceDocumentOpener | undefined> & {
	readonly kv: Kv<TKv> | undefined;
};

export type CollectPortableWorkspaceOptions = {
	/** Fetch immutable bytes for a reachable BlobRef. Required only when used. */
	readBlob?(ref: BlobRef): Promise<Uint8Array>;
};

/**
 * Freeze every reachable durable plane into one validated, in-memory export.
 * Filesystem and SQLite adapters consume this value without rediscovering
 * documents or blobs from storage metadata.
 */
export async function collectPortableWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	workspace: ExportableWorkspace<TTables, TKv>,
	options: CollectPortableWorkspaceOptions = {},
): Promise<PortableWorkspaceContent> {
	const rows = normalizeSnapshot(
		definition,
		await workspace.readTablesSnapshot(),
	);
	const kv = readKv(definition, workspace.kv);
	const documents = await readDocuments(definition, workspace, rows);
	const blobs = await readBlobs(definition, rows, options.readBlob);

	return Object.freeze({
		rows: Object.freeze(rows),
		tablesStateHash: `sha256:${sha256Hex(canonicalJson(rows))}`,
		kv: Object.freeze(kv),
		documents: Object.freeze(documents),
		blobs: Object.freeze(blobs),
	});
}

/** Plan the exact forward table mutations from current live state to desired. */
export function planTablesApply(
	definition: WorkspaceDefinition,
	currentInput: readonly SnapshotRow[],
	desiredInput: readonly SnapshotRow[],
): TablesApplyPlan {
	const current = normalizeSnapshot(definition, currentInput);
	const desired = normalizeSnapshot(definition, desiredInput);
	const currentById = new Map(
		current.map((row) => [snapshotIdentity(row), row] as const),
	);
	const desiredById = new Map(
		desired.map((row) => [snapshotIdentity(row), row] as const),
	);
	const mutations: TablesApplyMutation[] = [];
	const creates: TablesApplyPlan['creates'][number][] = [];
	const updates: {
		table: string;
		rowId: string;
		changes: Readonly<
			Record<string, { readonly before: unknown; readonly after: unknown }>
		>;
	}[] = [];
	const deletes: TablesApplyPlan['deletes'][number][] = [];
	const documentFallout: { table: string; rowId: string; field: string }[] = [];

	for (const row of desired) {
		const before = currentById.get(snapshotIdentity(row));
		if (!before) {
			const after = Object.freeze({ id: row.rowId, ...row.cells });
			mutations.push({
				kind: 'create',
				table: row.table,
				row: after,
			});
			creates.push({ table: row.table, rowId: row.rowId, after });
			continue;
		}
		const cells = Object.fromEntries(
			Object.entries(row.cells).filter(
				([field, value]) => !sameJson(value, before.cells[field]),
			),
		);
		if (Object.keys(cells).length === 0) continue;
		mutations.push({
			kind: 'patch',
			table: row.table,
			rowId: row.rowId,
			cells: Object.freeze(cells),
		});
		updates.push({
			table: row.table,
			rowId: row.rowId,
			changes: Object.freeze(
				Object.fromEntries(
					Object.keys(cells)
						.toSorted()
						.map((field) => [
							field,
							Object.freeze({
								before: before.cells[field],
								after: row.cells[field],
							}),
						]),
				),
			),
		});
	}

	for (const row of current) {
		if (desiredById.has(snapshotIdentity(row))) continue;
		mutations.push({ kind: 'remove', table: row.table, rowId: row.rowId });
		deletes.push({
			table: row.table,
			rowId: row.rowId,
			before: Object.freeze({ id: row.rowId, ...row.cells }),
		});
		const table = definition.tables[row.table];
		for (const field of Object.keys(table?.documents ?? {}).toSorted()) {
			documentFallout.push({ table: row.table, rowId: row.rowId, field });
		}
	}

	const desiredBlobHashes = blobRefs(definition, desired);
	const blobFallout = [...blobRefs(definition, current).values()]
		.filter((ref) => !desiredBlobHashes.has(ref.hash))
		.toSorted((left, right) => left.hash.localeCompare(right.hash));

	return Object.freeze({
		mutations: Object.freeze(mutations),
		creates: Object.freeze(creates),
		updates: Object.freeze(updates),
		deletes: Object.freeze(deletes),
		documentFallout: Object.freeze(documentFallout),
		blobFallout: Object.freeze(blobFallout),
	});
}

function snapshotIdentity(row: SnapshotRow): string {
	return `${row.table}\0${row.rowId}`;
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function blobRefs(
	definition: WorkspaceDefinition,
	rows: readonly SnapshotRow[],
): Map<string, BlobRef> {
	const refs = new Map<string, BlobRef>();
	for (const row of rows) {
		const table = definition.tables[row.table];
		if (!table) continue;
		for (const field of Object.keys(table.blobs)) {
			const value = row.cells[field];
			if (value !== null) {
				const ref = value as BlobRef;
				refs.set(ref.hash, ref);
			}
		}
	}
	return refs;
}

function normalizeSnapshot<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	input: readonly SnapshotRow[],
): SnapshotRow[] {
	const seen = new Set<string>();
	return [...input]
		.toSorted(
			(left, right) =>
				left.table.localeCompare(right.table) ||
				left.rowId.localeCompare(right.rowId),
		)
		.map((snapshot) => {
			const table = definition.tables[snapshot.table];
			if (!table) {
				throw new Error(
					`Portable export cannot represent unknown table '${snapshot.table}'`,
				);
			}
			const identity = `${snapshot.table}\0${snapshot.rowId}`;
			if (seen.has(identity)) {
				throw new Error(
					`Portable export contains duplicate row '${snapshot.table}.${snapshot.rowId}'`,
				);
			}
			seen.add(identity);
			const row = { id: snapshot.rowId, ...snapshot.cells };
			for (const [name, column] of Object.entries(table.compiledColumns)) {
				if (name === 'id' || Object.hasOwn(row, name)) continue;
				if (!column.isNullable) {
					throw new Error(
						`Portable export row '${snapshot.table}.${snapshot.rowId}' is missing '${name}'`,
					);
				}
				(row as Record<string, unknown>)[name] = null;
			}
			if (!Value.Check(table.schema, row)) {
				throw new Error(
					`Portable export row '${snapshot.table}.${snapshot.rowId}' does not match the locked table schema`,
				);
			}
			return Object.freeze({
				table: snapshot.table,
				rowId: snapshot.rowId,
				cells: Object.freeze(
					Object.fromEntries(
						Object.entries(row).filter(([name]) => name !== 'id'),
					),
				),
			}) as SnapshotRow;
		});
}

function readKv<TKv extends KvDefinitions>(
	definition: WorkspaceDefinition<TableDefinitions, TKv>,
	kv: Kv<TKv> | undefined,
): Record<string, unknown> {
	const keys = Object.keys(definition.kv).toSorted();
	if (keys.length > 0 && !kv) {
		throw new Error('Complete portable export requires the workspace KV mount');
	}
	return Object.fromEntries(keys.map((key) => [key, kv?.get(key)]));
}

async function readDocuments<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	workspace: AsyncWorkspace<TTables, WorkspaceDocumentOpener | undefined>,
	rows: readonly SnapshotRow[],
): Promise<PortableDocument[]> {
	const documents: PortableDocument[] = [];
	for (const row of rows) {
		const tableDefinition = definition.tables[row.table];
		const table = (
			workspace.tables as unknown as Record<
				string,
				{ docs: Record<string, { open?: (rowId: string) => unknown }> }
			>
		)[row.table];
		if (!tableDefinition || !table) continue;
		for (const [field, format] of Object.entries(
			tableDefinition.documents,
		).toSorted(([left], [right]) => left.localeCompare(right))) {
			const declared = table.docs[field];
			if (!declared?.open) {
				throw new Error(
					`Complete portable export requires a document runtime for '${row.table}.${field}'`,
				);
			}
			const opened = declared.open(row.rowId) as {
				guid: string;
				whenReady: Promise<void>;
				encodeState(): Uint8Array;
				[Symbol.dispose](): void;
			};
			try {
				await opened.whenReady;
				const identity = createDocumentGuidIdentity({
					workspaceId: definition.workspaceId,
					table: row.table,
					document: field,
					format,
				});
				if (opened.guid !== identity.guid(row.rowId)) {
					throw new Error(
						`Document opener returned the wrong guid for '${row.table}.${field}'`,
					);
				}
				const bytes = opened.encodeState();
				documents.push(
					Object.freeze({
						table: row.table,
						rowId: row.rowId,
						field,
						guid: opened.guid,
						formatHash: inspectDocumentFormat(format).formatHash,
						hash: await sha256Bytes(bytes),
						bytes: new Uint8Array(bytes),
					}),
				);
			} finally {
				opened[Symbol.dispose]();
			}
		}
	}
	return documents;
}

async function readBlobs<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	rows: readonly SnapshotRow[],
	readBlob: CollectPortableWorkspaceOptions['readBlob'],
): Promise<PortableBlob[]> {
	const refs = new Map<string, BlobRef>();
	for (const row of rows) {
		const table = definition.tables[row.table];
		if (!table) continue;
		for (const field of Object.keys(table.blobs).toSorted()) {
			const value = row.cells[field];
			if (value === null) continue;
			const ref = value as BlobRef;
			const existing = refs.get(ref.hash);
			if (
				existing &&
				(existing.size !== ref.size || existing.mediaType !== ref.mediaType)
			) {
				throw new Error(`Blob '${ref.hash}' has conflicting metadata`);
			}
			refs.set(ref.hash, ref);
		}
	}
	if (refs.size > 0 && !readBlob) {
		throw new Error('Complete portable export requires a blob reader');
	}

	const blobs: PortableBlob[] = [];
	for (const ref of [...refs.values()].toSorted((left, right) =>
		left.hash.localeCompare(right.hash),
	)) {
		const bytes = await readBlob?.(ref);
		if (!bytes) throw new Error(`Blob '${ref.hash}' is unavailable`);
		if (bytes.byteLength !== ref.size) {
			throw new Error(`Blob '${ref.hash}' has the wrong byte length`);
		}
		const hash = await sha256Bytes(bytes);
		if (hash !== ref.hash) throw new Error(`Blob '${ref.hash}' failed hashing`);
		blobs.push(Object.freeze({ ...ref, bytes: new Uint8Array(bytes) }));
	}
	return blobs;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const owned = new Uint8Array(bytes.byteLength);
	owned.set(bytes);
	const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}
