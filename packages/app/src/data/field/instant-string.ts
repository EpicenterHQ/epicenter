/**
 * @fileoverview `InstantString` branded type and runtime companion.
 *
 * A canonical UTC instant string in fixed millisecond precision. This is stricter
 * than RFC 3339 `date-time`: it rejects offsets and variable fractional precision so
 * SQLite TEXT ordering matches chronological ordering.
 */

import { Format } from 'typebox/format';
import type { Brand } from 'wellcrafted/brand';

// Persisted schema discriminator: changing this string would make stored
// `field.instant()` schemas stop recognizing as `instant`.
export const INSTANT_STRING_PATTERN =
	'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

const instantStringPattern = new RegExp(INSTANT_STRING_PATTERN);

/** Branded canonical UTC instant string. */
export type InstantString = string & Brand<'InstantString'>;

export const InstantString = {
	/**
	 * Runtime predicate for the canonical UTC instant format.
	 */
	is(value: unknown): value is InstantString {
		if (typeof value !== 'string') return false;
		return instantStringPattern.test(value) && Format.Test('date-time', value);
	},

	/**
	 * Current instant in canonical UTC form.
	 *
	 * @example `"2026-06-09T14:00:00.000Z"`
	 */
	now(): InstantString {
		return new Date().toISOString() as InstantString;
	},

	/**
	 * Convert a `Date` to canonical UTC form. The boundary helper for callers
	 * holding a `Date` (e.g. a POSIX `mtime`): `Date.prototype.toISOString`
	 * always emits the fixed millisecond-precision UTC form this brand requires.
	 */
	fromDate(date: Date): InstantString {
		return date.toISOString() as InstantString;
	},
};
