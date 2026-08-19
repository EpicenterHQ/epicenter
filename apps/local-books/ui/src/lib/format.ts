// Presentation helpers for the books surface. None of this invents state; it only
// makes the mirror's own bytes (QuickBooks ids, ISO timestamps, SQLite column
// values) scannable for a human.

import type { TableColumn } from './types';

const moneyFmt = new Intl.NumberFormat(undefined, {
	style: 'currency',
	currency: 'USD',
});
const numberFmt = new Intl.NumberFormat();

/**
 * Format one cell by the column's declared SQLite type (from
 * `pragma_table_xinfo`). Every REAL in the mirror is money, so REAL renders as
 * currency; QuickBooks booleans arrive as `json_extract` 0/1, so the flag
 * columns render yes/no.
 */
export function formatCell(
	value: unknown,
	column: Pick<TableColumn, 'name' | 'type'>,
): string {
	if (value === null || value === undefined) return '';
	if (column.type === 'REAL') {
		const n = Number(value);
		return Number.isFinite(n) ? moneyFmt.format(n) : String(value);
	}
	if (column.type === 'INTEGER') {
		if (column.name === 'active' || column.name === 'deleted') {
			return value === 1 ? 'yes' : 'no';
		}
		const n = Number(value);
		return Number.isFinite(n) ? numberFmt.format(n) : String(value);
	}
	return String(value);
}

/** "2m ago" style relative time for the sync status. */
export function relativeTime(iso: string | null): string {
	if (!iso) return 'never';
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return 'never';
	const seconds = Math.round((Date.now() - then) / 1000);
	if (seconds < 10) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** Compact ISO timestamp for detail rows: date + short time, local. */
export function shortTimestamp(iso: string | null): string {
	if (!iso) return '-';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
}

/**
 * Parse a cell that holds serialized JSON (the `raw` blob, `_meta` values), or
 * null when the value is not a JSON object/array. Presentation-side parsing:
 * the API ships column values verbatim.
 */
export function asJson(value: unknown): unknown | null {
	if (typeof value !== 'string') return null;
	const first = value.trimStart()[0];
	if (first !== '{' && first !== '[') return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export { numberFmt };
