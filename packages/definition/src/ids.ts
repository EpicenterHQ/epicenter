/**
 * `@epicenter/definition/ids`: helpers for naming files.
 *
 * A contract never mints a file's name (decision 5): `create` takes every
 * placeholder from its caller. These are the two names a caller usually
 * wants. `timeId()` sorts by when it was made, which suits captures and
 * recordings; `nanoid()` is a short random name.
 */
import { customAlphabet } from 'nanoid';

export { nanoid } from 'nanoid';

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
