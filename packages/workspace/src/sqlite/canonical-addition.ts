import {
	type JsonObject,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	type WireRowIntent,
} from '@epicenter/row-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';
import type { WorkspaceSyncSettlement } from './canonical-sync-supervisor.js';
import { readLocalRow } from './local-workspace-storage.js';

export type LogicalWorkspaceRow = {
	table: string;
	rowId: string;
	fields: JsonObject;
	document?: Uint8Array;
};

/** Portable user content. It deliberately contains no synchronization state. */
export type LogicalWorkspaceCopy = {
	rows: LogicalWorkspaceRow[];
	kv: JsonObject;
};

/**
 * One logically coordinated workspace export (ADR-0147), never an atomic
 * cross-plane snapshot: the scalar cut and each row's compact document state
 * are captured sequentially from local durable storage.
 *
 * `settlement` is `null` for a Device workspace, which has no authority to
 * settle against. For an Account workspace it reports the best-effort scalar
 * settlement taken before capture; a non-`caught-up` outcome means remote
 * changes may be missing, while locally visible content (including
 * unsynchronized intents) is always captured. A row without a `document`
 * field is the explicit omission record: no locally available document state
 * existed for it, and authority-side state was deliberately not fetched.
 */
export type LogicalWorkspaceExport = LogicalWorkspaceCopy & {
	settlement: WorkspaceSyncSettlement | null;
};

export function captureLogicalWorkspace({
	addresses,
	readCurrentRow,
	captureDocument,
}: {
	addresses: readonly { table: string; rowId: string }[];
	readCurrentRow(table: string, rowId: string): JsonObject | undefined;
	/** Owner-side compact document capture; undefined means no durable state. */
	captureDocument?(address: {
		table: string;
		rowId: string;
	}): Uint8Array | undefined;
}): LogicalWorkspaceCopy {
	const rows: LogicalWorkspaceRow[] = [];
	let kv: JsonObject = {};
	for (const { table, rowId } of addresses) {
		const fields = readCurrentRow(table, rowId);
		if (fields === undefined) continue;
		if (table === RESERVED_KV_TABLE && rowId === RESERVED_KV_ROW_ID) {
			kv = structuredClone(fields);
			continue;
		}
		const document = captureDocument?.({ table, rowId });
		rows.push({
			table,
			rowId,
			fields: structuredClone(fields),
			...(document === undefined ? {} : { document }),
		});
	}
	return { rows, kv };
}

/** Admit a logical copy as ordinary new work in its destination replica. */
export function logicalWorkspaceIntents(
	copy: LogicalWorkspaceCopy,
): WireRowIntent[] {
	const intents: WireRowIntent[] = [];
	for (const row of copy.rows) {
		intents.push({
			kind: 'create',
			table: row.table,
			rowId: row.rowId,
			fields: structuredClone(row.fields),
		});
	}
	if (Object.keys(copy.kv).length === 0) return intents;
	intents.push({
		kind: 'update',
		table: RESERVED_KV_TABLE,
		rowId: RESERVED_KV_ROW_ID,
		fields: { set: structuredClone(copy.kv), unset: [] },
	});
	return intents;
}

/**
 * Fold each row's locally durable document state into a logical copy.
 *
 * A row keeps its scalar-captured document bytes when the store holds nothing
 * for its address. A row without a `document` field afterwards is the explicit
 * omission record: no locally available document state existed for it at
 * capture time, and whether authority-side state exists is deliberately not
 * asked here.
 */
export async function withCapturedDocuments(
	copy: LogicalWorkspaceCopy,
	capture: (address: {
		table: string;
		rowId: string;
	}) => Promise<Uint8Array | undefined>,
): Promise<LogicalWorkspaceCopy> {
	return {
		...copy,
		rows: await Promise.all(
			copy.rows.map(async (row) => {
				const document = await capture({ table: row.table, rowId: row.rowId });
				return document === undefined ? row : { ...row, document };
			}),
		),
	};
}

export function captureLocalWorkspace(
	source: SqliteDatabase,
	captureDocument?: (address: {
		table: string;
		rowId: string;
	}) => Uint8Array | undefined,
): LogicalWorkspaceCopy {
	const addresses = source.all<{ table: string; rowId: string }>(
		`SELECT table_key AS "table", row_id AS "rowId" FROM "rows"
		 ORDER BY table_key, row_id`,
	);
	return captureLogicalWorkspace({
		addresses,
		readCurrentRow: (table, rowId) => readLocalRow(source, table, rowId),
		captureDocument,
	});
}

/**
 * Delete only logical content from a local Device workspace. The optional
 * callback deletes the workspace's document logs inside the same transaction
 * so scalar death and document death commit together.
 */
export function deleteLocalWorkspace(
	sqlite: SqliteDatabase,
	deleteDocumentRows: () => void = () => undefined,
): void {
	sqlite.transaction(() => {
		sqlite.run('DELETE FROM "rows"');
		deleteDocumentRows();
	});
}
