/** Inspect the save lifecycle without requesting a read. */
import type { BufferSnapshot, FileEdit } from '@epicenter/folder/edits';

export function unsavedOf(edit: Pick<FileEdit, 'getBuffer'>) {
	return unsavedIn(edit.getBuffer());
}

export function unsavedIn(buffer: BufferSnapshot) {
	return buffer.status === 'ready' ? buffer.unsaved : undefined;
}
