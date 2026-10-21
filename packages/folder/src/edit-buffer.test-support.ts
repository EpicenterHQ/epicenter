/** Narrow a buffer for assertions without inventing another source or lifecycle. */
import type { BufferSnapshot } from './edits.js';
export function unsavedOf(edit: { getBuffer(): BufferSnapshot }) {
	const buffer = edit.getBuffer();
	return buffer.status === 'ready' ? buffer.unsaved : undefined;
}
