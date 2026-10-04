import type {
	Change,
	JsonObject,
	JsonValue,
	Record as SyncRecord,
} from './schemas.js';

export const DATA_ADMISSION_LIMITS = {
	namespaceKeyBytes: 128,
	memberKeyBytes: 64,
	rowIdLength: 24,
	replicaIdLength: 24,
	lifetimeIdLength: 24,
	changesPerBatch: 64,
	recordsPerPage: 64,
	unsetKeysPerChange: 128,
	fieldKeyBytes: 512,
	jsonDepth: 16,
	propertiesPerObject: 1_024,
	encodedRecordBytes: 508 * 1024,
	encodedChangeBytes: 700 * 1024,
	encodedBatchBytes: 768 * 1024,
	encodedPageBytes: 8 * 1024 * 1024,
} as const;

const textEncoder = new TextEncoder();

/**
 * A namespace key is collision-resistant reverse-domain naming: at least three
 * dot-separated lowercase labels, hyphens only inside a label.
 */
const NAMESPACE_KEY =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){2,}$/;

/**
 * A member key names one table or one value inside a namespace: dot-separated
 * lowercase kebab segments, e.g. `recordings` or `settings.sound.manual-start`.
 * Tables and values share this one grammar; the address `kind` keeps them
 * unambiguous even when they collide.
 */
const MEMBER_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const RUNTIME_ID = /^[a-z0-9]{24}$/;

export function encodedBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function encodedJsonBytes(value: unknown): number {
	return encodedBytes(JSON.stringify(value));
}

export function isNamespaceKey(value: string): boolean {
	const bytes = encodedBytes(value);
	return (
		bytes >= 5 &&
		bytes <= DATA_ADMISSION_LIMITS.namespaceKeyBytes &&
		NAMESPACE_KEY.test(value)
	);
}

export function isMemberKey(value: string): boolean {
	const bytes = encodedBytes(value);
	return (
		bytes >= 1 &&
		bytes <= DATA_ADMISSION_LIMITS.memberKeyBytes &&
		MEMBER_KEY.test(value)
	);
}

export function isRuntimeId(value: string): boolean {
	return RUNTIME_ID.test(value);
}

function isJsonAtDepth(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (
		typeof value !== 'object' ||
		depth >= DATA_ADMISSION_LIMITS.jsonDepth ||
		ancestors.has(value)
	) {
		return false;
	}
	ancestors.add(value);
	const prototype = Object.getPrototypeOf(value);
	const isValid = Array.isArray(value)
		? value.every((child) => isJsonAtDepth(child, depth + 1, ancestors))
		: (prototype === Object.prototype || prototype === null) &&
			Object.keys(value).length <= DATA_ADMISSION_LIMITS.propertiesPerObject &&
			Object.values(value).every((child) =>
				isJsonAtDepth(child, depth + 1, ancestors),
			);
	ancestors.delete(value);
	return isValid;
}

export function isJsonValue(value: unknown): value is JsonValue {
	return isJsonAtDepth(value, 0, new Set());
}

export function isJsonObject(value: unknown): value is JsonObject {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		isJsonValue(value)
	);
}

function isFieldKey(value: string): boolean {
	return (
		value.length > 0 &&
		encodedBytes(value) <= DATA_ADMISSION_LIMITS.fieldKeyBytes
	);
}

function isAdmissibleAddress(value: Change | SyncRecord): boolean {
	if (!isNamespaceKey(value.namespace)) return false;
	return 'rowId' in value
		? isMemberKey(value.table) && isRuntimeId(value.rowId)
		: isMemberKey(value.value);
}

export function isAdmissibleChange(change: Change): boolean {
	if (!isAdmissibleAddress(change)) return false;
	if (encodedJsonBytes(change) > DATA_ADMISSION_LIMITS.encodedChangeBytes)
		return false;

	switch (change.kind) {
		case 'create':
			return isJsonObject(change.fields);
		case 'update': {
			if (!isJsonObject(change.fields.set)) return false;
			if (
				Object.keys(change.fields.set).length === 0 &&
				change.fields.unset.length === 0
			)
				return false;
			const unset = new Set(change.fields.unset);
			return (
				unset.size === change.fields.unset.length &&
				change.fields.unset.every(isFieldKey) &&
				Object.keys(change.fields.set).every(
					(key) => isFieldKey(key) && !unset.has(key),
				)
			);
		}
		case 'delete':
			return true;
		case 'set':
			return isJsonValue(change.payload);
		case 'unset':
			return true;
		default:
			return change satisfies never;
	}
}

export function isAdmissibleRecord(record: SyncRecord): boolean {
	if (
		!isAdmissibleAddress(record) ||
		!Number.isSafeInteger(record.changedSequence) ||
		record.changedSequence < 1
	) {
		return false;
	}
	if (encodedJsonBytes(record) > DATA_ADMISSION_LIMITS.encodedRecordBytes)
		return false;
	return record.kind === 'row'
		? isJsonObject(record.fields)
		: record.kind === 'value'
			? isJsonValue(record.payload)
			: true;
}
