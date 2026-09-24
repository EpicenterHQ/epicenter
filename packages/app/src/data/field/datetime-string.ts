/**
 * @fileoverview `DateTimeString` branded type and runtime companion.
 *
 * An RFC 3339 / ISO 8601 datetime string, branded so it can't be accidentally
 * mixed with arbitrary strings. The brand is the entire public contract: the
 * schema is built via `field.datetime()`, which delegates validation to
 * TypeBox v1's built-in `date-time` format validator.
 *
 * RFC 3339 accepts both Z (`...Z`) and offset (`...±HH:MM`) forms. Use
 * `field.instant()` / `InstantString` when SQLite TEXT ordering must be
 * chronological by schema, not just by writer convention.
 *
 * For zoned datetimes where the originating IANA zone matters (calendar
 * events, reminders, scheduled actions), pair the instant or datetime field with a
 * separate IANA timezone field. See the `<field>` + `<field>Zone` naming
 * convention in the workspace spec.
 */

import { Format } from 'typebox/format';
import type { Brand } from 'wellcrafted/brand';

/**
 * Branded RFC 3339 / ISO 8601 datetime string.
 *
 * @example `"2024-01-01T20:00:00.000Z"`
 */
export type DateTimeString = string & Brand<'DateTimeString'>;

export const DateTimeString = {
	/**
	 * Runtime predicate. Delegates to TypeBox's built-in `date-time` format
	 * validator (auto-registered).
	 */
	is(value: unknown): value is DateTimeString {
		if (typeof value !== 'string') return false;
		return Format.Test('date-time', value);
	},

	/**
	 * Current instant in RFC 3339 Z form, branded.
	 *
	 * @example `DateTimeString.now()` → `"2026-05-24T22:45:00.000Z"`
	 */
	now(): DateTimeString {
		return new Date().toISOString() as DateTimeString;
	},
};
