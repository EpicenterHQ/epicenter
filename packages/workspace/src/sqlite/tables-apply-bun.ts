import {
	type Cells,
	isAdmissibleOperationSet,
	type Operation,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordAuthorityDescriptor,
	type SnapshotRow,
} from '@epicenter/record-sync';
import type { WorkspaceDefinition } from './definition.js';
import type { BlobRef } from './field.js';
import { planTablesApply, type TablesApplyPlan } from './portable-workspace.js';
import { readPortableTables } from './portable-workspace-bun.js';
import type { ReplicaSyncPort } from './replica.js';
import type { TablesAuthorityPort } from './replica-http.js';

export type ApplyPortableTablesOptions = {
	tablesPath: string;
	authority: ReplicaSyncPort & TablesAuthorityPort;
	/** Every review is against the latest authority head. */
	confirm(plan: TablesApplyPlan, head: number): boolean | Promise<boolean>;
	/** Prove every desired BlobRef and its exact metadata exist before review. */
	isBlobAvailable?(ref: BlobRef): boolean | Promise<boolean>;
	signal?: AbortSignal;
};

export type ApplyPortableTablesResult =
	| { readonly status: 'applied'; readonly head: number }
	| { readonly status: 'no-changes'; readonly head: number }
	| { readonly status: 'cancelled'; readonly head: number };

/**
 * Make live tables exactly match an edited portable `tables.sqlite3` file.
 *
 * The function plans against the latest authority state, asks the caller to
 * approve the complete value-level diff, and admits the operations through one
 * compare-and-swap. A moved head always causes a new plan and approval. This
 * tables-only operation does not apply KV, documents, or blob bytes.
 *
 * @example
 * ```ts
 * await applyPortableTables(definition, {
 *   tablesPath: './export/tables.sqlite3',
 *   authority,
 *   isBlobAvailable: hasExactBlob,
 *   confirm: async (plan, head) => review(plan, head),
 * });
 * ```
 */
export async function applyPortableTables(
	definition: WorkspaceDefinition,
	options: ApplyPortableTablesOptions,
): Promise<ApplyPortableTablesResult> {
	const desired = readPortableTables(definition, options.tablesPath);
	const desiredBlobs = portableBlobRefs(definition, desired);
	if (desiredBlobs.length > 0 && !options.isBlobAvailable) {
		throw new Error('Tables apply requires a blob availability checker');
	}
	for (const ref of desiredBlobs) {
		if (!(await options.isBlobAvailable?.(ref))) {
			throw new Error(`Desired blob '${ref.hash}' is unavailable`);
		}
	}

	const opened = parseAuthorityDescriptor(
		await options.authority.openAuthority(
			{
				workspaceId: definition.workspaceId,
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				recordsDescriptor: definition.recordsDescriptor,
				recordsSchemaHash: definition.recordsSchemaHash,
			},
			options.signal,
		),
	);
	if (
		opened.recordsDescriptor !== definition.recordsDescriptor ||
		opened.recordsSchemaHash !== definition.recordsSchemaHash
	) {
		throw new Error(
			'Authority tables schema does not match the locked definition',
		);
	}
	const envelope = {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		recordsEpoch: opened.recordsEpoch,
	};

	for (;;) {
		const state = await options.authority.readTablesState(
			{ ...envelope, kind: 'tablesState' },
			options.signal,
		);
		if (!state.ok) {
			throw new Error(`Tables state refused: ${state.reason}`);
		}
		const plan = planTablesApply(definition, state.rows, desired);
		if (plan.mutations.length === 0) {
			return { status: 'no-changes', head: state.head };
		}
		const operations = plan.mutations.map(toOperation);
		if (!isAdmissibleOperationSet(operations)) {
			throw new Error('Desired table diff exceeds the atomic apply ceiling');
		}
		if (!(await options.confirm(plan, state.head))) {
			return { status: 'cancelled', head: state.head };
		}
		const applied = await options.authority.applyTables(
			{
				...envelope,
				kind: 'tablesApply',
				expectedHead: state.head,
				operations,
			},
			options.signal,
		);
		if (applied.ok) return { status: 'applied', head: applied.newHead };
		if (applied.reason === 'head-moved') continue;
		throw new Error(`Tables apply refused: ${applied.reason}`);
	}
}

function toOperation(
	mutation: TablesApplyPlan['mutations'][number],
): Operation {
	switch (mutation.kind) {
		case 'create': {
			const cells = { ...mutation.row } as Record<string, unknown>;
			delete cells.id;
			return {
				kind: 'createRow',
				table: mutation.table,
				rowId: mutation.row.id,
				cells: cells as Cells,
			};
		}
		case 'patch':
			return {
				kind: 'updateRow',
				table: mutation.table,
				rowId: mutation.rowId,
				cells: mutation.cells as Cells,
			};
		case 'remove':
			return {
				kind: 'deleteRow',
				table: mutation.table,
				rowId: mutation.rowId,
			};
	}
}

function portableBlobRefs(
	definition: WorkspaceDefinition,
	rows: readonly SnapshotRow[],
): BlobRef[] {
	const refs = new Map<string, BlobRef>();
	for (const row of rows) {
		const table = definition.tables[row.table];
		for (const field of Object.keys(table?.blobs ?? {})) {
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
	return [...refs.values()].toSorted((left, right) =>
		left.hash.localeCompare(right.hash),
	);
}

function parseAuthorityDescriptor(value: unknown): RecordAuthorityDescriptor {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		typeof (value as { recordsEpoch?: unknown }).recordsEpoch !== 'string' ||
		typeof (value as { recordsDescriptor?: unknown }).recordsDescriptor !==
			'string' ||
		typeof (value as { recordsSchemaHash?: unknown }).recordsSchemaHash !==
			'string'
	) {
		throw new Error('Authority returned an invalid tables descriptor');
	}
	return value as RecordAuthorityDescriptor;
}
