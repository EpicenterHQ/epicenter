/**
 * A moment as an app's fields write it, in this computer's time zone: the
 * one that runs the action, which for `epicenter serve` is the person's own.
 * `localDay` is what `field.date` holds and `localTime` what
 * `field.datetime` holds, so a field reads as the person's day and clock
 * rather than UTC's.
 */

import { customAlphabet } from 'nanoid';

const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');

/** `at` as a day here: `2026-11-10`. */
export function localDay(at: Date = new Date()): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** `at` as RFC 3339 in this computer's offset: `2026-11-10T22:41:05+08:00`. */
export function localTime(at: Date = new Date()): string {
	const offset = -at.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
	return `${localDay(at)}T${clock}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** Lowercase only, so two names never differ by case alone on a case-insensitive disk. */
const random = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

/**
 * A name that sorts by the moment it was made (UTC, to the millisecond),
 * then 8 random lowercase letters and digits so two names made in one
 * millisecond differ. It holds no `.`, `:` or `/`, so it is safe in any path
 * segment and splits cleanly in `{id}.{ext}`.
 *
 * @example
 * ```ts
 * timeId(new Date('2026-10-30T22:41:05.123Z')); // '2026-10-30T22-41-05-123Z-k3x9a2f8'
 * ```
 */
export function timeId(at: Date = new Date()): string {
	const stamp = at
		.toISOString()
		.replace(/\.(\d{3})Z$/, '-$1Z')
		.replaceAll(':', '-');
	return `${stamp}-${random()}`;
}
