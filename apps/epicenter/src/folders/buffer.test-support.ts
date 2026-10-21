import type { FileEdit as NativeFileEdit } from '@epicenter/folder/edits';

/** Inspect held input after narrowing the current buffer snapshot. */
export function unsavedOf(buffer: ReturnType<NativeFileEdit['getBuffer']> | undefined) {
	return buffer?.status === 'ready' ? buffer.unsaved : undefined;
}
