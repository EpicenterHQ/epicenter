/**
 * Reading a Git LFS pointer out of a blob, for the receiver and the write
 * translator. Which paths must hold one is `storedWithLfs`
 * (`@epicenter/definition/contract`, decisions 40 and 58); the pointer format
 * is `parsePointer`'s.
 */
import {
	type LfsPointer,
	parsePointer,
	writePointer,
} from '@epicenter/definition/merge';

/** No pointer is longer; anything larger is not read as one. */
export const MAX_POINTER_BYTES = 512;

/**
 * The pointer `bytes` hold, or null when they are not exactly one in its
 * canonical layout (`writePointer`): an attachment's version is the blob id
 * of that layout on every computer (ADR-0808), so the receiver refuses any
 * other, as it refuses a path that collides by case.
 */
export function readPointer(bytes: Uint8Array): LfsPointer | null {
	if (bytes.length > MAX_POINTER_BYTES) return null;
	const text = new TextDecoder().decode(bytes);
	const pointer = parsePointer(text);
	return pointer &&
		Number.isSafeInteger(pointer.size) &&
		writePointer(pointer) === text
		? pointer
		: null;
}
