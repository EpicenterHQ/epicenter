import type { SqliteValue } from '@epicenter/sqlite';

/** Only the named main-schema tables are readable by this statement. */
export type QueryOptions = {
	tables: readonly string[];
	parameters?: readonly SqliteValue[];
	signal?: AbortSignal;
};

/** Preserve SQLite integers and blobs without JSON precision loss. */
export type QueryValue =
	| null
	| string
	| number
	| { integer: string }
	| { blob: string };
export type QueryResult = {
	columns: string[];
	rows: QueryValue[][];
	truncated: boolean;
};

export const QUERY_LIMITS = {
	sqlBytes: 64 * 1024,
	valueBytes: 1024 * 1024,
	columns: 128,
	rows: 1000,
	resultBytes: 1024 * 1024,
	vmOperations: 1_000_000,
	deadlineMs: 1000,
	progressInterval: 1000,
} as const;

/** Native and WASM executors admit these built-in functions and no others. */
export const QUERY_FUNCTIONS = [
	'count',
	'sum',
	'avg',
	'min',
	'max',
	'total',
	'abs',
	'round',
	'length',
	'lower',
	'upper',
	'trim',
	'ltrim',
	'rtrim',
	'substr',
	'substring',
	'replace',
	'instr',
	'coalesce',
	'ifnull',
	'nullif',
	'iif',
	'typeof',
	'hex',
	'unhex',
	'unicode',
	'char',
	'printf',
	'format',
	'date',
	'time',
	'datetime',
	'julianday',
	'unixepoch',
	'strftime',
	'timediff',
	'json',
	'json_array',
	'json_object',
	'json_extract',
	'json_array_length',
	'json_type',
	'json_valid',
	'json_quote',
	'json_each',
	'json_tree',
	'json_group_array',
	'json_group_object',
	'like',
	'glob',
	'randomblob',
	'zeroblob',
] as const;

const encoder = new TextEncoder();

/** Validate values received across the worker or native response boundary. */
export function isQueryResult(value: unknown): value is QueryResult {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('columns' in value) ||
		!Array.isArray(value.columns) ||
		value.columns.length === 0 ||
		value.columns.length > QUERY_LIMITS.columns ||
		!value.columns.every(
			(column) =>
				typeof column === 'string' &&
				column.length <= QUERY_LIMITS.sqlBytes &&
				encoder.encode(column).length <= QUERY_LIMITS.sqlBytes,
		) ||
		!('rows' in value) ||
		!Array.isArray(value.rows) ||
		value.rows.length > QUERY_LIMITS.rows ||
		!('truncated' in value) ||
		typeof value.truncated !== 'boolean'
	)
		return false;
	let bytes = encoder.encode(
		JSON.stringify({ columns: value.columns, rows: [], truncated: false }),
	).length;
	if (bytes > QUERY_LIMITS.resultBytes) return false;
	for (const [index, row] of value.rows.entries()) {
		if (
			!Array.isArray(row) ||
			row.length !== value.columns.length ||
			!row.every(isQueryValue)
		)
			return false;
		bytes += encoder.encode(JSON.stringify(row)).length + (index ? 1 : 0);
		if (bytes > QUERY_LIMITS.resultBytes) return false;
	}
	return true;
}

function isQueryValue(value: unknown): value is QueryValue {
	if (value === null) return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value === 'string')
		return (
			value.length <= QUERY_LIMITS.valueBytes &&
			encoder.encode(value).length <= QUERY_LIMITS.valueBytes
		);
	if (
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1
	)
		return false;
	if (
		'integer' in value &&
		typeof value.integer === 'string' &&
		/^(0|-?[1-9][0-9]*)$/.test(value.integer) &&
		value.integer.length <= 20
	) {
		const integer = BigInt(value.integer);
		return integer >= -(1n << 63n) && integer < 1n << 63n;
	}
	return (
		'blob' in value &&
		typeof value.blob === 'string' &&
		value.blob.length <= QUERY_LIMITS.valueBytes * 2 &&
		/^(?:[0-9a-f]{2})*$/.test(value.blob)
	);
}
