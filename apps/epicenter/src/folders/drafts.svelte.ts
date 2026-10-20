/**
 * What a person typed into the files of the window's folder and has not
 * saved, held by the window for as long as the folder is open, not by the
 * editor that shows a file. Choosing another file keeps the typing; choosing
 * it again shows it, with why its save failed.
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
 * - **Settling** sends every draft now and waits for every save started,
 *   and answers the drafts still held. It refuses no input: the window
 *   settles when it is hidden and when it is asked to close, and typing goes
 *   on afterward as before. The folder context closes the handle only after
 *   its work settled, once the editor is gone.
 *
 * The folder editor builds one for its window and registers it with the
 * folder context (`registerWork`).
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

/** A draft still held once a settle finished, as `settle` answers it. */
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
	const running = new SvelteMap<string, Promise<void>>();
	/** Files asked to save again while a save of them ran. */
	const again = new Set<string>();
	let revisions = 0;

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
				/**
				 * Type `text`; it saves after a pause. The first keystroke of a
				 * draft starts from `base`, the file as shown, and is refused
				 * without one. Answers whether it was taken.
				 */
				type(text: string, base: DraftBase | undefined): boolean {
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
				 * Refused while a save of it runs.
				 */
				discard(): boolean {
					if (running.has(path) || !drafts.has(path)) return false;
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

		/**
		 * Whether closing now could lose something: typing is held, which a
		 * failed save keeps, or a save runs.
		 */
		get busy(): boolean {
			return drafts.size > 0 || running.size > 0;
		},

		/**
		 * Send every draft now and wait for every save started, refusing no
		 * input. Answers the drafts still held: those whose save failed, and
		 * typing that arrived meanwhile.
		 */
		async settle(): Promise<Unsaved[]> {
			await Promise.allSettled([...drafts.keys()].map(flush));
			await Promise.allSettled([...running.values()]);
			return [...drafts].map(([path, draft]) => unsavedOf(path, draft));
		},
	};
}

export type FileDrafts = ReturnType<typeof createFileDrafts>;
