/**
 * Edit as text: what a person typed over a capture file's exact Markdown,
 * frontmatter included, and has not saved.
 *
 * The local folder's edit layer (`edits.row`) drafts a row's fields and
 * body; a file edited as text can change anything, valid or not, so its
 * draft is the whole text, saved through the folder's files.
 *
 * - One draft per path holds the text typed and the source it started from.
 *   A reread never replaces it. It saves `saveAfterMs` after the last change,
 *   and at once on `save()`.
 * - A save sends the whole text over the source it started from
 *   (`files.write(path, from, text)`), and the folder merges it with whatever
 *   was saved meanwhile. Once it landed and the rows were read again, the
 *   draft goes, unless typing changed it meanwhile: that typing stays,
 *   starting from the text this save sent. Saves of one path run one at a
 *   time.
 * - A failed save keeps the draft and its error; `save()` tries again, and so
 *   does further typing, after its pause.
 *
 * The local folder's context closes the folder without knowing these
 * drafts, so the page sends them when it goes away (`settle`).
 */
import type { FolderFiles, SaveError } from '@epicenter/folder';
import { SAVE_AFTER_MS } from '@epicenter/svelte/edits';
import type { QueryClient } from '@tanstack/query-core';
import { SvelteMap } from 'svelte/reactivity';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('capture/text-drafts');

type Draft = {
	/** The source the typing started from, or the text its last save sent. */
	readonly base: string;
	readonly text: string;
	/** Changes with each keystroke, so a landed save knows whether typing followed it. */
	readonly revision: number;
	readonly saving: boolean;
	/** Why the last save failed, until one lands. */
	readonly error: SaveError | undefined;
};

export type TextDrafts = ReturnType<typeof createTextDrafts>;

export function createTextDrafts({
	files,
	queryClient,
	rowsKey,
	refused,
	saveAfterMs = SAVE_AFTER_MS,
}: {
	/** The folder's root files; a capture's path is `captures/<stem>.md`. */
	files: FolderFiles;
	/** The page's cache, which a landed save reads again before its draft goes. */
	queryClient: QueryClient;
	/** The key of the rows the text is read from. */
	rowsKey: readonly unknown[];
	/** Whether `path` takes no typing now: the folder closes, or it is deleted. */
	refused: (path: string) => boolean;
	saveAfterMs?: number;
}) {
	const drafts = new SvelteMap<string, Draft>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The save loop of each path with one running. */
	const running = new Map<string, Promise<void>>();
	/** Paths asked to save again while a save of them ran. */
	const again = new Set<string>();
	let revisions = 0;

	function clearTimer(path: string) {
		clearTimeout(timers.get(path));
		timers.delete(path);
	}

	function schedule(path: string) {
		clearTimer(path);
		timers.set(
			path,
			setTimeout(() => {
				timers.delete(path);
				void flush(path);
			}, saveAfterMs),
		);
	}

	/** Send the path's draft now; resolves once no save of it runs. */
	function flush(path: string): Promise<void> {
		clearTimer(path);
		const run = running.get(path);
		if (run !== undefined) {
			again.add(path);
			return run;
		}
		const started = drain(path)
			.catch((cause: unknown) => {
				// Thrown, not answered: the folder closed under the save. The
				// draft stays for the page to show while it lasts.
				const draft = drafts.get(path);
				if (draft !== undefined) drafts.set(path, { ...draft, saving: false });
				log.warn(new Error(`${path} was not saved`, { cause }));
			})
			.finally(() => running.delete(path));
		running.set(path, started);
		return started;
	}

	async function drain(path: string) {
		do {
			again.delete(path);
			const draft = drafts.get(path);
			if (draft === undefined) return;
			drafts.set(path, { ...draft, saving: true });
			const saved = await files.write(path, draft.base, draft.text);
			const settled = drafts.get(path);
			if (settled === undefined) return;
			if (saved.error !== null) {
				drafts.set(path, { ...settled, saving: false, error: saved.error });
				continue;
			}
			await queryClient.invalidateQueries({ queryKey: rowsKey });
			const after = drafts.get(path);
			if (after === undefined) return;
			if (after.revision === draft.revision) drafts.delete(path);
			else
				drafts.set(path, {
					...after,
					base: draft.text,
					saving: false,
					error: undefined,
				});
		} while (again.has(path));
	}

	return {
		/** The text draft of `path`. Asking again answers the same typing. */
		text(path: string) {
			return {
				/** The text typed and not saved, or `undefined` with none. */
				get typed() {
					return drafts.get(path)?.text;
				},
				/**
				 * Type `text` over the file shown as `from`; it saves after a
				 * pause. The first change of a draft starts from `from`. Answers
				 * whether it was taken.
				 */
				change(from: string, text: string): boolean {
					if (refused(path)) return false;
					const draft = drafts.get(path);
					drafts.set(path, {
						base: draft?.base ?? from,
						text,
						revision: ++revisions,
						saving: draft?.saving ?? false,
						error: draft?.error,
					});
					schedule(path);
					return true;
				},
				/** Save what is typed now; resolves once no save of it runs. */
				save: () => flush(path),
				get saving() {
					return drafts.get(path)?.saving ?? false;
				},
				/** Why its last save failed, while the typing is held. */
				get error() {
					return drafts.get(path)?.error;
				},
				/** Let go of the typing; answers it, or `undefined` while a save runs. */
				discard(): string | undefined {
					if (running.has(path)) return undefined;
					const draft = drafts.get(path);
					if (draft === undefined) return undefined;
					clearTimer(path);
					drafts.delete(path);
					return draft.text;
				},
			};
		},

		/** Whether `path` holds typing that has not saved. */
		held: (path: string) => drafts.has(path),

		/** Send every draft once and wait; answers the paths still not saved. */
		async settle(): Promise<string[]> {
			const paths = [...drafts.keys()];
			await Promise.allSettled(paths.map((path) => flush(path)));
			return paths.filter((path) => drafts.has(path));
		},

		/** Whether any typing is held, or a save runs. */
		get busy() {
			return drafts.size > 0;
		},

		/** The paths whose last save failed and that no save is retrying. */
		get failures(): { path: string; error: SaveError }[] {
			return [...drafts].flatMap(([path, draft]) =>
				draft.error !== undefined && !draft.saving
					? [{ path, error: draft.error }]
					: [],
			);
		},
	};
}
