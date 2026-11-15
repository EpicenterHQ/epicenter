/**
 * A moment as an app's fields write it, in this computer's time zone: the
 * one that runs the action, which for `epicenter serve` is the person's own.
 * `localDay` is what `field.date` holds and `localTime` what
 * `field.datetime` holds, so a field reads as the person's day and clock
 * rather than UTC's.
 */

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
