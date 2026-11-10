/**
 * Names for files that sort by when they were made, copied from the waiting
 * product's ids (ADR-0843: new code copies from it, never imports it).
 */
import { customAlphabet } from 'nanoid';

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
