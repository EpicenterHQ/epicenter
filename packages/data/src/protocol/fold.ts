import { isAdmissibleRecord } from './admission.js';
import type { Change, JsonObject, Record as SyncRecord } from './schemas.js';

/**
 * One fold outcome per change:
 *
 * - `applied`: the change produced a new winning latest-state record.
 * - `noop`: the change is semantically benign against the current record (a
 *   create over an existing address, a mutation of a missing or tombstoned
 *   row, an unset of an unset value). The authority answers a benign noop
 *   that has a current record by touching that record with a fresh changed
 *   sequence, so ordinary scanning re-delivers authority truth to the replica
 *   whose optimistic state suppressed it.
 * - `inadmissible`: the change passed change admission but its merged
 *   latest-state record exceeds the record bound. This is never benign: the
 *   authority must refuse the whole batch envelope, and the submitting
 *   replica parks the exact refused obligation instead of reporting idle.
 */
export type FoldResult =
	| { kind: 'applied'; record: SyncRecord }
	| { kind: 'noop'; current: SyncRecord | undefined }
	| { kind: 'inadmissible'; reason: 'record-bound' };

function admit(record: SyncRecord): FoldResult {
	return isAdmissibleRecord({
		...record,
		changedSequence: Number.MAX_SAFE_INTEGER,
	})
		? { kind: 'applied', record }
		: { kind: 'inadmissible', reason: 'record-bound' };
}

function sameAddress(current: SyncRecord | undefined, change: Change): boolean {
	if (current === undefined || current.namespace !== change.namespace)
		return false;
	return 'rowId' in change
		? 'rowId' in current &&
				current.table === change.table &&
				current.rowId === change.rowId
		: !('rowId' in current) && current.value === change.value;
}

export function foldChange(
	current: SyncRecord | undefined,
	change: Change,
	nextSequence: number,
): FoldResult {
	const existing = sameAddress(current, change) ? current : undefined;
	switch (change.kind) {
		case 'create':
			return existing === undefined
				? admit({
						kind: 'row',
						namespace: change.namespace,
						table: change.table,
						rowId: change.rowId,
						changedSequence: nextSequence,
						fields: structuredClone(change.fields),
					})
				: { kind: 'noop', current: existing };
		case 'update': {
			if (existing?.kind !== 'row') return { kind: 'noop', current: existing };
			const fields: JsonObject = structuredClone(existing.fields);
			for (const [key, value] of Object.entries(change.fields.set)) {
				Object.defineProperty(fields, key, {
					configurable: true,
					enumerable: true,
					value: structuredClone(value),
					writable: true,
				});
			}
			for (const key of change.fields.unset) delete fields[key];
			return admit({ ...existing, changedSequence: nextSequence, fields });
		}
		case 'delete':
			return existing?.kind === 'row'
				? admit({
						kind: 'row-deleted',
						namespace: change.namespace,
						table: change.table,
						rowId: change.rowId,
						changedSequence: nextSequence,
					})
				: { kind: 'noop', current: existing };
		case 'set':
			return admit({
				kind: 'value',
				namespace: change.namespace,
				value: change.value,
				changedSequence: nextSequence,
				payload: structuredClone(change.payload),
			});
		case 'unset':
			return existing?.kind === 'value'
				? admit({
						kind: 'value-unset',
						namespace: change.namespace,
						value: change.value,
						changedSequence: nextSequence,
					})
				: { kind: 'noop', current: existing };
		default:
			return change satisfies never;
	}
}
