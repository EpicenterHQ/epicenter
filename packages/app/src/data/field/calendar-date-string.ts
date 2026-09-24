/**
 * @fileoverview `CalendarDateString` branded type and runtime companion.
 *
 * A calendar day string in ISO `YYYY-MM-DD` form. It carries no time, offset, or
 * time zone meaning.
 */

import { Format } from 'typebox/format';
import type { Brand } from 'wellcrafted/brand';

/** Branded ISO calendar date string. */
export type CalendarDateString = string & Brand<'CalendarDateString'>;

export const CalendarDateString = {
	/**
	 * Runtime predicate for ISO calendar dates.
	 */
	is(value: unknown): value is CalendarDateString {
		if (typeof value !== 'string') return false;
		return Format.Test('date', value);
	},
};
