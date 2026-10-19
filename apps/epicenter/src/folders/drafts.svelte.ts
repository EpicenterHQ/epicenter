/**
 * What a person typed into the files of the open folder and has not saved,
 * held by the window for as long as the folder is open, not by the editor
 * that shows a file. Choosing another file keeps the typing; choosing it
 * again shows it, with why its save failed.
 *
 * - **Drafts.** One draft per file holds the text typed since the file last
 *   saved, and the content it started from. A reread never replaces it. It
 *   saves `SAVE_AFTER_MS` after the last keystroke, and at once on `save()`.
 * - **A landed save.** The folder merges the draft, by line, with whatever
 *   was saved meanwhile. The draft is held until the file was read again,
 *   then let go, unless typing changed it meanwhile: that typing stays,
 *   starting from the content this save sent. Saves of one file run one at
 *   a time.
 * - **A failed save** keeps the draft and its error. `save()` tries again;
 *   so does further typing, after its pause. `discard()` lets it go, and
 *   only when the person asks.
 * - **Leaving** the folder refuses input, sends every draft, and waits for
 *   every save started. When all saved, input stays refused and the folder
 *   may close. Otherwise input is taken again, and the drafts that did not
 *   save are answered, so the folder stays open with them.
 *
 * `createFolderSwitch` builds one per opened folder.
 */
import type { FileContent, FolderFiles, SaveError } from '@epicenter/folder';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { savedText } from './files';

/** How long after the last keystroke a draft saves. */
export const SAVE_AFTER_MS = 1000;

/** What a draft starts from: the file's content, and whether it ends its lines with `\r\n`. */
export type DraftBase = {
	readonly content: FileContent;
	readonly crlf: boolean;
};

/** One file's typing that has not saved. */
type Draft = DraftBase & {
	readonly text: string;
	/** Changes with each keystroke, so a landed save knows whether typing followed it. */
	readonly revision: number;
	readonly saving: boolean;
	/** Why the last save failed, until one lands. */
	readonly error: SaveError | Error | undefined;
};

/** A draft that did not save, as `leave` answers it. */
export type Unsaved = {
	readonly path: string;
	readonly text: string;
	readonly error: SaveError | Error | undefined;
};

export function createFileDrafts({
	files,
	saved,
	saveAfterMs = SAVE_AFTER_MS,
}: {
	files: Pick<FolderFiles, 'write'>;
	/** Read `path` again once a save of it landed, before its draft goes. */
	saved: (path: string) => Promise<void>;
	saveAfterMs?: number;
}) {
	const drafts = new SvelteMap<string, Draft>();
	/** Files whose save waits for the pause after typing. */
	const waiting = new SvelteSet<string>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The save loop of each file with one running. */
	const running = new Map<string, Promise<void>>();
	/** Files asked to save again while a save of them ran. */
	const again = new Set<string>();
	let revisions = 0;
	let fenced = $state(false);
	let leaving: Promise<Unsaved[]> | undefined;

	function clearTimer(path: string) {
		clearTimeout(timers.get(path));
		timers.delete(path);
		waiting.delete(path);
	}

	function schedule(path: string) {
		clearTimer(path);
		waiting.add(path);
		timers.set(
			path,
			setTimeout(() => {
				timers.delete(path);
				waiting.delete(path);
				void flush(path);
			}, saveAfterMs),
		);
	}

	/** Send the file's draft now; resolves once no save of it runs. */
	function flush(path: string): Promise<void> {
		clearTimer(path);
		const run = running.get(path);
		if (run !== undefined) {
			again.add(path);
			return run;
		}
		const started = drain(path).finally(() => running.delete(path));
		running.set(path, started);
		return started;
	}

	async function drain(path: string) {
		do {
			again.delete(path);
			const draft = drafts.get(path);
			if (draft === undefined) return;
			const { content: from, crlf, text, revision } = draft;
			const content = savedText(text, crlf);
			drafts.set(path, { ...draft, saving: true });
			let error: SaveError | Error | null;
			try {
				({ error } = await files.write(path, from, content));
			} catch (cause) {
				// A closed handle throws instead of saving.
				error = cause instanceof Error ? cause : new Error(String(cause));
			}
			const settled = drafts.get(path);
			if (settled === undefined) return;
			if (error !== null) {
				drafts.set(path, { ...settled, saving: false, error });
				continue;
			}
			await saved(path).catch(() => {});
			const after = drafts.get(path);
			if (after === undefined) return;
			if (after.revision === revision) drafts.delete(path);
			else
				drafts.set(path, {
					...after,
					content,
					saving: false,
					error: undefined,
				});
		} while (again.has(path));
	}

	const unsavedOf = (path: string, { text, error }: Draft): Unsaved => ({
		path,
		text,
		error,
	});

	return {
		/** The typing of file `path`; asking again answers the same typing. */
		file(path: string) {
			return {
				/** The text typed and not saved, or `undefined` when none is held. */
				get text() {
					return drafts.get(path)?.text;
				},
				/** Whether typing is held that has not saved. */
				get held() {
					return drafts.has(path);
				},
				/** Whether a save of it runs or waits for the pause after typing. */
				get saving() {
					return (drafts.get(path)?.saving ?? false) || waiting.has(path);
				},
				/** Why its last save failed, while the typing is held. */
				get error() {
					return drafts.get(path)?.error;
				},
				/** Whether input is refused, because the folder is being left. */
				get locked() {
					return fenced;
				},
				/**
				 * Type `text`; it saves after a pause. The first keystroke of a
				 * draft starts from `base`, the file as shown, and is refused
				 * without one. Answers whether it was taken: nothing is while the
				 * folder is being left.
				 */
				type(text: string, base: DraftBase | undefined): boolean {
					if (fenced) return false;
					const draft = drafts.get(path);
					const from = draft ?? base;
					if (from === undefined) return false;
					drafts.set(path, {
						content: from.content,
						crlf: from.crlf,
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
				/**
				 * Let go of typing that did not save, as the person asked.
				 * Refused while a save of it runs or the folder is being left.
				 */
				discard(): boolean {
					if (fenced || running.has(path) || !drafts.has(path)) return false;
					clearTimer(path);
					drafts.delete(path);
					return true;
				},
			};
		},

		/** The files whose typing is held, sorted. */
		get held(): string[] {
			return [...drafts.keys()].sort();
		},

		/** The drafts whose last save failed and that no save is retrying. */
		get failures(): Unsaved[] {
			return [...drafts]
				.filter(([, draft]) => draft.error !== undefined && !draft.saving)
				.map(([path, draft]) => unsavedOf(path, draft));
		},

		/** Whether input is refused, because the folder is being left. */
		get fenced() {
			return fenced;
		},

		/**
		 * Refuse input, send every draft, and wait for every save started.
		 * Answers the drafts that did not save; when there are any, input is
		 * taken again. Calls while one runs answer the same completion.
		 */
		leave(): Promise<Unsaved[]> {
			leaving ??= (async () => {
				fenced = true;
				await Promise.allSettled([...drafts.keys()].map(flush));
				await Promise.allSettled([...running.values()]);
				const kept = [...drafts].map(([path, draft]) => unsavedOf(path, draft));
				if (kept.length > 0) {
					fenced = false;
					leaving = undefined;
				}
				return kept;
			})();
			return leaving;
		},
	};
}

export type FileDrafts = ReturnType<typeof createFileDrafts>;
