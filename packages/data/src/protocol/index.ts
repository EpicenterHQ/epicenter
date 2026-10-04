export {
	DATA_ADMISSION_LIMITS,
	encodedBytes,
	encodedJsonBytes,
	isAdmissibleChange,
	isAdmissibleRecord,
	isJsonObject,
	isJsonValue,
	isMemberKey,
	isNamespaceKey,
	isRuntimeId,
} from './admission.js';
export { canonicalJson, sha256Hex } from './canonical.js';
export { type FoldResult, foldChange } from './fold.js';
export {
	type Batch,
	BatchSchema,
	type Change,
	ChangeSchema,
	type ExchangeRequest,
	ExchangeRequestSchema,
	type ExchangeResponse,
	ExchangeResponseSchema,
	type ExchangeSuccess,
	type JsonObject,
	type JsonValue,
	type LifetimeId,
	LifetimeIdSchema,
	type MemberKey,
	MemberKeySchema,
	type NamespaceKey,
	NamespaceKeySchema,
	ProtocolValidationError,
	parseChange,
	parseExchangeRequest,
	parseExchangeResponse,
	parseJsonValue,
	parseLifetimeId,
	parseMemberKey,
	parseNamespaceKey,
	parseRecord,
	parseReplicaId,
	parseRowId,
	type Receipt,
	ReceiptSchema,
	type Record,
	RecordSchema,
	type ReplicaId,
	ReplicaIdSchema,
	type RowAddress,
	type RowId,
	RowIdSchema,
	type ScalarAddress,
	type ValueAddress,
} from './schemas.js';

import { canonicalJson, sha256Hex } from './canonical.js';
import type { Change, ScalarAddress, Record as SyncRecord } from './schemas.js';

export function batchDigest(changes: readonly Change[]): string {
	return sha256Hex(canonicalJson(changes));
}

/** The structured scalar address of one change or latest-state record. */
export function scalarAddressOf(value: Change | SyncRecord): ScalarAddress {
	return 'rowId' in value
		? {
				kind: 'row',
				namespace: value.namespace,
				table: value.table,
				rowId: value.rowId,
			}
		: { kind: 'value', namespace: value.namespace, value: value.value };
}

/** One collision-free comparison key for a structured scalar address. */
export function scalarAddressKey(address: ScalarAddress): string {
	return address.kind === 'row'
		? `row\0${address.namespace}\0${address.table}\0${address.rowId}`
		: `value\0${address.namespace}\0${address.value}`;
}
