/**
 * Text typed into a file as its exact text and not yet saved: a row file
 * opened in Source, for repair, or any other text file opened from Files.
 * Rows edited as fields and body are `@epicenter/svelte/edits`
 * drafts; this is the same rule for a file's whole text.
 *
 * - A draft holds the text the edit started from and what is typed. A
 *   reread never replaces it.
 * - It saves `saveAfterMs` after the last change, and at once on `save`, as
 *   `files.write(path, from, typed)`: the folder merges it with whatever was
 *   saved meanwhile (ADR-0632).
 * - A landed save lets the draft go once the file was read again, unless
 *   typing changed it meanwhile; that typing stays, starting from what this
 *   save sent. The saves of one file run one at a time.
 * - A failed save keeps the draft and its error, and is reported. `save`
 *   tries again; so does further typing.
 * - `close` refuses new typing, sends every draft once, and answers the
 *   drafts that still did not save.
 */
import { type FolderFiles, SaveError } from '@epicenter/folder';
import { SvelteMap } from 'svelte/reactivity';

/** How long after the last change a draft saves. */
export const SAVE_AFTER_MS = 1000;

type Draft = {
	/** The text the typing started from, or the text the last save sent. */
	readonly from: string;
	readonly text: string;
	readonly revision: number;
	readonly saving: boolean;
	readonly error: SaveError | undefined;
};

/** A file's typing that did not save. */
export type UnsavedText = {
	readonly path: string;
	readonly text: string;
	readonly error: SaveError | undefined;
};

export function createTextDrafts({
	files,
	saved,
	failed,
	saveAfterMs = SAVE_AFTER_MS,
}: {
	files: Pick<FolderFiles, 'write'>;
	/** Read `path` again once a save of it landed; the draft goes after. */
	saved: (path: string) => Promise<void>;
	/** Hear a save that failed; the draft is kept. */
	failed: (failure: UnsavedText) => void;
	saveAfterMs?: number;
}) {
	const drafts = new SvelteMap<string, Draft>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const running = new Map<string, Promise<void>>();
	const again = new Set<string>();
	let revisions = 0;
	let fenced = false;
	let closing: Promise<UnsavedText[]> | undefined;

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

	function flush(path: string): Promise<void> {
		clearTimer(path);
		const run = running.get(path);
		if (run !== undefined) {
			again.add(path);
			return run;
		}
		const started = drain(path)
			.catch((cause: unknown) => {
				const draft = drafts.get(path);
				if (draft === undefined) return;
				const error = SaveError.StorageFailed({ cause }).error;
				drafts.set(path, { ...draft, saving: false, error });
				failed({ path, text: draft.text, error });
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
			const { from, text, revision } = draft;
			drafts.set(path, { ...draft, saving: true });
			const { error } = await files.write(path, from, text);
			const after = drafts.get(path);
			if (after === undefined) return;
			if (error !== null) {
				drafts.set(path, { ...after, saving: false, error });
				failed({ path, text: after.text, error });
				continue;
			}
			await saved(path);
			const current = drafts.get(path);
			if (current === undefined) return;
			if (current.revision === revision) drafts.delete(path);
			else
				drafts.set(path, {
					...current,
					from: text,
					saving: false,
					error: undefined,
				});
		} while (again.has(path));
	}

	const unsavedOf = (path: string, draft: Draft): UnsavedText => ({
		path,
		text: draft.text,
		error: draft.error,
	});

	async function settle(paths: readonly string[]): Promise<UnsavedText[]> {
		await Promise.allSettled(paths.map((path) => flush(path)));
		return paths.flatMap((path) => {
			const draft = drafts.get(path);
			return draft === undefined ? [] : [unsavedOf(path, draft)];
		});
	}

	return {
		/** What is typed into `path` and not saved, read reactively. */
		typed: (path: string) => drafts.get(path)?.text,
		/**
		 * Type `text` into `path`, whose text the edit starts from is `from`;
		 * a draft keeps the text it started from. Answers whether it was taken.
		 */
		change(path: string, from: string, text: string): boolean {
			if (fenced) return false;
			const draft = drafts.get(path);
			drafts.set(path, {
				from: draft?.from ?? from,
				text,
				revision: ++revisions,
				saving: draft?.saving ?? false,
				error: draft?.error,
			});
			schedule(path);
			return true;
		},
		/** Save what is typed into `path` now; resolves once no save of it runs. */
		save: (path: string) => flush(path),
		/** Whether typing into `path` is held. */
		held: (path: string) => drafts.has(path),
		/** Whether typing into `path` is held and not failed: saving or about to. */
		writing(path?: string): boolean {
			const pending = (draft: Draft) =>
				draft.saving || draft.error === undefined;
			if (path !== undefined) {
				const draft = drafts.get(path);
				return draft !== undefined && pending(draft);
			}
			return [...drafts.values()].some(pending);
		},
		/** Why the last save of `path` failed, while its typing is held. */
		error: (path: string) => drafts.get(path)?.error,
		/** Let go of what is typed into `path`; answers the text it let go. */
		discard(path: string): string | undefined {
			if (running.has(path)) return undefined;
			const draft = drafts.get(path);
			if (draft === undefined) return undefined;
			clearTimer(path);
			drafts.delete(path);
			return draft.text;
		},
		/** The drafts whose last save failed and that no save is retrying. */
		get failures(): UnsavedText[] {
			return [...drafts.entries()]
				.filter(([, draft]) => draft.error !== undefined && !draft.saving)
				.map(([path, draft]) => unsavedOf(path, draft));
		},
		/** Send the draft of `path`, or every draft, once; answers what still did not save. */
		settled(path?: string): Promise<UnsavedText[]> {
			return settle(path === undefined ? [...drafts.keys()] : [path]);
		},
		/** Refuse new typing, send every draft once, and answer what did not save. */
		close(): Promise<UnsavedText[]> {
			closing ??= (async () => {
				fenced = true;
				return settle([...drafts.keys()]);
			})();
			return closing;
		},
	};
}

export type TextDrafts = ReturnType<typeof createTextDrafts>;
