/**
 * Three rows merged by field and the body by line, with no table: the core
 * of `mergeFile`'s row merge (ADR-0551).
 *
 * Values compare as JSON, so object key order does not matter and arrays and
 * objects are one unit each. For each field, equal values agree and a side
 * unchanged from the base yields to the other.
 *
 * This module loads only the line merge.
 */
import { type LineMerge, mergeLines } from './git/merge-lines.js';
import type { Row } from './row-text.js';

/** A row with no schema type: what a merge reads and writes. */
export type AnyRow = Row<Record<string, unknown>>;

/** One field both sides changed differently; `undefined` is no such field. */
type FieldUnit = {
	readonly kind: 'field';
	readonly field: string;
	readonly base: unknown;
	readonly ours: unknown;
	readonly theirs: unknown;
};

/** Whether two JSON values are the same value, whatever their key order. */
export function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	)
		return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		return (
			left.length === right.length &&
			left.every((item, index) => sameValue(item, right[index]))
		);
	}
	const leftKeys = Object.keys(left);
	const rightRecord = right as Record<string, unknown>;
	return (
		leftKeys.length === Object.keys(right).length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(right, key) &&
				sameValue((left as Record<string, unknown>)[key], rightRecord[key]),
		)
	);
}

/** Equal values agree; a side unchanged from the base yields. */
function choose<T>(
	base: T,
	ours: T,
	theirs: T,
	same: (left: T, right: T) => boolean,
): { readonly value: T } | undefined {
	if (same(ours, theirs) || same(theirs, base)) return { value: ours };
	if (same(ours, base)) return { value: theirs };
	return undefined;
}

/** Set `name` on `fields` as an own data property, `__proto__` included; `undefined` removes it. */
export function setField(
	fields: Record<string, unknown>,
	name: string,
	value: unknown,
) {
	if (value === undefined) {
		delete fields[name];
		return;
	}
	Object.defineProperty(fields, name, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

const fieldOf = (row: AnyRow | null, name: string) =>
	row !== null && Object.hasOwn(row.fields, name)
		? row.fields[name]
		: undefined;

/**
 * Merge three rows. Two added rows with no base merge over an empty one, so
 * only what both added alike agrees.
 */
export async function mergeRows(
	base: AnyRow | null,
	ours: AnyRow,
	theirs: AnyRow,
): Promise<{
	/** Every field that merged; a competing one is left out. */
	readonly fields: Record<string, unknown>;
	/** Each field both sides changed differently. */
	readonly conflicts: readonly FieldUnit[];
	/** The body's line merge; it competes when it has regions. */
	readonly body: LineMerge;
}> {
	const fields: Record<string, unknown> = {};
	const conflicts: FieldUnit[] = [];
	const names = new Set([
		...Object.keys(base?.fields ?? {}),
		...Object.keys(ours.fields),
		...Object.keys(theirs.fields),
	]);
	for (const name of names) {
		const [b, o, t] = [
			fieldOf(base, name),
			fieldOf(ours, name),
			fieldOf(theirs, name),
		];
		const chosen = choose(b, o, t, sameValue);
		if (chosen === undefined)
			conflicts.push({
				kind: 'field',
				field: name,
				base: b,
				ours: o,
				theirs: t,
			});
		else setField(fields, name, chosen.value);
	}
	const body = await mergeLines({
		base: base?.body ?? '',
		ours: ours.body,
		theirs: theirs.body,
	});
	return { fields, conflicts, body };
}
