/**
 * The one folder the Folders window has open, and choosing another.
 *
 * Choosing another folder first leaves the open one: its drafts
 * (`createFileDrafts`) are sent, and every save started is waited for. Only
 * then is the open folder's handle closed and the next one opened: a native
 * handle's `close` does not wait for file work, so nothing else would. When
 * a draft did not save, the folder stays open with its typing, and `kept`
 * says which files; nothing typed is let go by choosing. Closing the window
 * leaves the same way, then closes the handle whatever stayed unsaved.
 *
 * Choices made while one is still leaving or opening keep only the newest.
 */
import type { Folder } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import {
	createFileDrafts,
	type FileDrafts,
	type Unsaved,
} from './drafts.svelte';

/** A folder the window opened with no tables, and the typing held in it. */
export type OpenedFolder = {
	/** The scope the shell listed it under. */
	readonly id: string;
	readonly folder: Folder<Record<never, never>>;
	readonly drafts: FileDrafts;
};

export function createFolderSwitch({
	open,
	watch,
	saved,
	saveAfterMs,
}: {
	/** Open the folder listed as `id`. */
	open: (
		id: string,
	) => Promise<Result<Folder<Record<never, never>>, { message: string }>>;
	/**
	 * Wire the folder opened as `id` to the page before anything reads it;
	 * answers what undoes that once it is left.
	 */
	watch: (id: string, folder: Folder<Record<never, never>>) => () => void;
	/** Read file `path` of the folder opened as `id` again, once a save of it landed. */
	saved: (id: string, path: string) => Promise<void>;
	saveAfterMs?: number;
}) {
	let chosen = $state<string>();
	let opened = $state.raw<OpenedFolder>();
	let opening = $state(false);
	let problem = $state<string>();
	let kept = $state.raw<Unsaved[]>();
	/** What undoes `watch` for the open folder. */
	let unwatch: (() => void) | undefined;
	/** The last handle's close; the next opens only after it. */
	let closing: Promise<void> = Promise.resolve();
	let sequence = 0;

	/** Stop watching `previous` and close its handle. */
	function shut(previous: OpenedFolder) {
		if (opened === previous) opened = undefined;
		unwatch?.();
		unwatch = undefined;
		closing = previous.folder.close();
		return closing;
	}

	return {
		/** The folder chosen last, which is open or opening. */
		get chosen() {
			return chosen;
		},
		get opened() {
			return opened;
		},
		get opening() {
			return opening;
		},
		/** Why the chosen folder did not open. */
		get problem() {
			return problem;
		},
		/** The drafts that kept the open folder open when another was chosen. */
		get kept() {
			return kept;
		},

		/** Open folder `id`, once the open one is left. */
		async choose(id: string) {
			if (id === chosen && (opened !== undefined || opening)) return;
			const seq = ++sequence;
			kept = undefined;
			const previous = opened;
			if (previous !== undefined) {
				// A choice made meanwhile waits for the same leaving, and goes on.
				const unsaved = await previous.drafts.leave();
				if (seq !== sequence) return;
				if (unsaved.length > 0) {
					kept = unsaved;
					return;
				}
				await shut(previous);
			}
			chosen = id;
			problem = undefined;
			opening = true;
			// One handle at a time: a close started by an earlier choice finishes first.
			await closing;
			if (seq !== sequence) return;
			const { data, error } = await open(id);
			if (seq !== sequence) {
				await data?.close();
				return;
			}
			opening = false;
			if (error !== null) {
				problem = error.message;
				return;
			}
			unwatch = watch(id, data);
			opened = {
				id,
				folder: data,
				drafts: createFileDrafts({
					files: data.files,
					saved: (path) => saved(id, path),
					saveAfterMs,
				}),
			};
		},

		/**
		 * Leave the open folder and close it, whatever stayed unsaved; answers
		 * the drafts that did not save.
		 */
		async close(): Promise<Unsaved[]> {
			++sequence;
			opening = false;
			const previous = opened;
			let unsaved: Unsaved[] = [];
			if (previous !== undefined) {
				unsaved = await previous.drafts.leave();
				await shut(previous);
			}
			await closing;
			return unsaved;
		},
	};
}

export type FolderSwitch = ReturnType<typeof createFolderSwitch>;
