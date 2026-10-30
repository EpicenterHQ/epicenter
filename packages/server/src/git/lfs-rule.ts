/**
 * Decision 40, the one rule the receiver and the write translator both
 * enforce: inside a data folder, every file except a `.md` note and Git's
 * own `.gitattributes` and `.gitignore` is a Git LFS pointer, whatever
 * `.gitattributes` says. The pointer format is phase 1's (`parsePointer`).
 */
import { type LfsPointer, parsePointer } from '@epicenter/definition/merge';

const GIT_METADATA = new Set(['.gitattributes', '.gitignore']);
/** No pointer is longer; anything larger is not read as one. */
export const MAX_POINTER_BYTES = 512;

/** Whether `path` must be stored as an LFS pointer. */
export function needsPointer(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return !name.endsWith('.md') && !GIT_METADATA.has(name);
}

/** The pointer `bytes` hold, or null when they are not exactly one. */
export function readPointer(bytes: Uint8Array): LfsPointer | null {
	if (bytes.length > MAX_POINTER_BYTES) return null;
	const pointer = parsePointer(new TextDecoder().decode(bytes));
	return pointer && Number.isSafeInteger(pointer.size) ? pointer : null;
}
