import { InstantString } from '@epicenter/app/field';
import { fromSubscription, type Tracked } from '@epicenter/svelte';
import type { HoneycrispData, NoteId } from './data.js';
import { notePreview, noteTitle } from './editor/node-text.js';
import { navigation } from './navigation.svelte.js';

/** Create a note in the displayed folder and select it. */
export function createNote(data: HoneycrispData): void {
	const now = InstantString.now();
	navigation.selectNote(
		data.tables.notes.create({
			folderId: navigation.folderId,
			title: '',
			pinned: false,
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
		}).id,
	);
}

/** Move a note to Recently Deleted and clear its selection. */
export function deleteNote(data: HoneycrispData, id: NoteId): void {
	data.tables.notes.update(id, { deletedAt: InstantString.now() });
	navigation.noteRemoved(id);
}

/** Permanently remove a note and clear its selection. */
export function permanentlyDeleteNote(data: HoneycrispData, id: NoteId): void {
	data.tables.notes.delete(id);
	navigation.noteRemoved(id);
}

/** Keep title and edit time current while the editor holds a note open. */
export function openContent(data: HoneycrispData, id: NoteId) {
	const content = data.tables.notes.get(id)?.content;
	if (content === undefined) return undefined;
	// Coalesced to one write per animation-frame-ish burst, because a
	// keystroke is a commit and writing the row on each one would write a row
	// per character. Reading the title itself is cheap now (`noteTitle` slices
	// the first block), so what this defends is the WRITE, not the read.
	// A `setTimeout(0)` rather than a debounce with a delay:
	// what is being avoided is one write per keystroke inside a burst, not
	// writes during sustained typing, and a person who stops typing and
	// closes the tab should not lose their title to a pending timer.
	let queued: ReturnType<typeof setTimeout> | undefined;
	let isClosed = false;
	const flush = () => {
		if (queued === undefined) return;
		clearTimeout(queued);
		queued = undefined;
		// The row may have disappeared since this body's edit was queued.
		data.tables.notes.update(id, {
			title: noteTitle(content),
			updatedAt: InstantString.now(),
		});
	};
	const stop = data.tables.notes.watch(content, () => {
		if (isClosed || queued !== undefined) return;
		queued = setTimeout(flush, 0);
	});
	function close() {
		if (isClosed) return;
		isClosed = true;
		stop();
		data.signal.removeEventListener('abort', close);
		if (data.signal.aborted) {
			clearTimeout(queued);
			queued = undefined;
			return;
		}
		flush();
	}
	// Retirement fences the store before UI teardown. Its pending derivations
	// belong to the retired data and must be cancelled before close can flush.
	data.signal.addEventListener('abort', close, { once: true });
	return {
		content,
		close,
	};
}

/** Subscribe to the preview of this note only. */
export function previewOf(data: HoneycrispData, id: NoteId): Tracked<string> {
	const body = data.tables.notes.get(id)?.content;
	if (body === undefined) return { current: '' };
	return fromSubscription(
		(update) => data.tables.notes.watch(body, update),
		() => notePreview(body),
	);
}
