/**
 * Edit sessions over `@epicenter/folder` files: the app owns the draft, the
 * folder's autosave writes it.
 *
 * A session edits one file's draft, a row (`createRowSession`) or text
 * (`createTextSession`). Each edit changes the draft and requests a save at
 * once; one write runs at a time and only the latest request waits, so rapid
 * typing writes the latest draft. A save never assigns the draft. Every write
 * is guarded by the bytes the session last saved, so a change made elsewhere,
 * or a deleted file, is `Conflict`.
 *
 * The folder merges the draft with that change, from the value the session
 * last saved, the way sync merges (ADR-0514): independent changes combine
 * and are written over the newer file with no question, and the draft
 * becomes the result. Parts both changed differently, a file deleted
 * elsewhere, or a file that is no longer this kind become `review`, which
 * shows the person only those parts. Input waits until `resolve` answers
 * every part at once; there is no other way out but leaving the file.
 *
 * Nothing else retries on its own; `retry` requests the draft again.
 *
 * Commands (`resolve`, `rename`) run one at a time and lock
 * input while they run, so no edit lands between a command's read and its
 * write; `settled` waits for a running command as well as the saves. A
 * released session takes no input, and a command that was running when it
 * was released starts nothing after its next await. The app releases a
 * session when the person leaves the file.
 */
import {
	type Autosave,
	type AutosaveError,
	type FileCapture,
	type FileError,
	type FileTable,
	type FolderFiles,
	type Row,
	type RowReadError,
	rowStemOf,
	type SaveMerge,
	type SaveState,
	type SyncChoiceProblem,
	type SyncChoices,
	type SyncConflict,
	wellFormed,
} from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

export const SessionError = defineErrors({
	/** Another command on this session is running. */
	Busy: () => ({
		message: 'Another change to this file is still in progress.',
	}),
	/** The app let this session go; it changes nothing more. */
	Released: () => ({ message: 'This file is no longer open here.' }),
	/** No review waits for a choice, or a newer one replaced it. */
	NothingToResolve: () => ({
		message: 'Nothing here is waiting for a choice.',
	}),
});
export type SessionError = InferErrors<typeof SessionError>;

/** A failure a session reports: anything with a name and a message. */
type Failure = { readonly name: string; readonly message: string };

/** What reading the file again found. */
export type Reread<TValue, TOther> =
	| {
			readonly kind: 'value';
			readonly file: FileCapture;
			readonly value: TValue;
	  }
	/** Nothing is at the path. */
	| { readonly kind: 'gone' }
	/**
	 * The file is there but cannot be shown as this session's value, such as
	 * a row whose text is not valid.
	 */
	| {
			readonly kind: 'other';
			readonly file: FileCapture;
			readonly detail: TOther;
	  };

/** How a session reaches its kind of file. */
export type EditSource<TValue, TError extends Failure, TOther> = {
	autosave(
		file: FileCapture,
		options: { onState(state: SaveState<TError>): void },
	): Autosave<TValue, TError>;
	reread(path: string): Promise<Result<Reread<TValue, TOther>, Failure>>;
	/**
	 * Merge the draft with a change made elsewhere and write what merges, as
	 * the folder does (`table.merge`, `files.merge`).
	 */
	merge(
		path: string,
		versions: { readonly base: TValue; readonly ours: TValue },
	): Promise<Result<SaveMerge, Failure>>;
};

/**
 * The parts of a draft that compete with a change made elsewhere, for the
 * shared review (`@epicenter/svelte/sync-review`). `local` is the draft,
 * `incoming` the file as it is now. `problems` are what the folder refused
 * in the last `resolve`, shown beside their parts.
 */
export type SaveReview = {
	readonly id: string;
	readonly conflicts: readonly SyncConflict[];
	readonly problems: readonly SyncChoiceProblem[];
};

/**
 * What the file holds after `resolve` wrote the choices: the session's
 * value, which the draft now shows; nothing, so the item closes; or a file
 * that is no longer this session's kind, which opens again as it is.
 */
export type Resolved = 'shown' | 'gone' | 'other';

function captureOf({ path, sha256 }: FileCapture): FileCapture {
	return { path, sha256 };
}

/** Whether two drafts hold the same value: the same text, or the same row. */
function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function createEditSession<TValue, TError extends Failure, TOther>(
	source: EditSource<TValue, TError, TOther>,
	opened: { readonly file: FileCapture; readonly value: TValue },
	{ locked: lockedOutside = () => false }: { locked?: () => boolean } = {},
) {
	let draft = $state(opened.value);
	/**
	 * The value the file held at `state.file`, as this session last saved or
	 * read it: the base a change made elsewhere merges from.
	 */
	let base: { sha256: string; value: TValue } = {
		sha256: opened.file.sha256,
		value: opened.value,
	};
	/** The latest value handed to the autosave. */
	let requested = opened.value;
	let review = $state.raw<SaveReview | undefined>();
	/** Writes `review`'s answer over the version its merge read. */
	let answer:
		| ((
				choices: SyncChoices,
		  ) => Promise<Result<FileCapture | undefined, Failure>>)
		| undefined;
	/** The merge started for the latest change made elsewhere, until it ends. */
	let merging: Promise<unknown> | undefined;
	let state = $state.raw<SaveState<TError>>({
		status: 'saved',
		file: captureOf(opened.file),
	});
	/** Advanced each time a read replaces the draft, so a view can remount. */
	let generation = $state(0);
	let command = $state.raw<Promise<unknown> | undefined>();
	let released = $state(false);
	let save!: Autosave<TValue, TError>;
	start(opened.file, opened.value);

	/**
	 * A new autosave from `file`, which holds `value`. A replaced autosave's
	 * late states are ignored.
	 */
	function start(file: FileCapture, value: TValue) {
		base = { sha256: file.sha256, value };
		review = undefined;
		answer = undefined;
		state = { status: 'saved', file: captureOf(file) };
		const session = source.autosave(file, {
			onState(next) {
				if (save !== session) return;
				state = next;
				// `saved` follows the latest request once nothing waits, so the
				// file now holds exactly what was last requested.
				if (next.status === 'saved' && next.file.sha256 !== base.sha256)
					base = { sha256: next.file.sha256, value: requested };
				// Admitted now, so `settled` and any command wait for the merge.
				if (changedElsewhere(next)) void reconcile();
			},
		});
		save = session;
	}

	/** A save refused because the file changed or went away elsewhere. */
	function changedElsewhere(next: SaveState<TError>): boolean {
		return next.status === 'error' && next.error.name === 'Conflict';
	}

	function request() {
		requested = $state.snapshot(draft) as TValue;
		save.request(requested);
	}

	const locked = () =>
		released ||
		command !== undefined ||
		review !== undefined ||
		lockedOutside();

	/** Run one command with input locked. Refused while another runs or once released. */
	async function run<T>(
		work: () => Promise<Result<T, Failure>>,
	): Promise<Result<T, Failure>> {
		// A command the person asked for waits for a merge already running,
		// rather than being refused as busy.
		while (merging !== undefined) await merging;
		if (released) return SessionError.Released();
		if (command !== undefined) return SessionError.Busy();
		const running = (async () => {
			await save.settled();
			if (released) return SessionError.Released();
			return work();
		})();
		command = running;
		try {
			return await running;
		} finally {
			command = undefined;
		}
	}

	async function settled(): Promise<SaveState<TError>> {
		for (;;) {
			while (command !== undefined) await command.catch(() => {});
			const current = save;
			const latest = await save.settled();
			// A save refused by a change elsewhere starts a merge; wait for it too.
			if (command === undefined && save === current) return latest;
		}
	}

	/** Show `shown` in place of the draft, over `file`, which holds `value`. */
	function replace(file: FileCapture, value: TValue, shown: TValue = value) {
		draft = shown;
		generation += 1;
		start(file, value);
	}

	/** Show the file as a write left it: the draft becomes what it holds now. */
	async function showWritten(path: string): Promise<Result<Resolved, Failure>> {
		const { data: found, error } = await source.reread(path);
		if (released) return SessionError.Released();
		if (error !== null) return Err(error);
		if (found.kind !== 'value') return Ok(found.kind);
		// A draft the write left as it was stays on screen, so a view does
		// not remount and lose its undo history for nothing.
		if (sameValue(found.value, $state.snapshot(draft)))
			start(found.file, found.value);
		else replace(found.file, found.value);
		return Ok('shown');
	}

	/**
	 * Merge the draft with a change made elsewhere. The folder writes what
	 * merges, and the draft becomes the result; anything else becomes
	 * `review`. A merge that cannot read the file leaves the conflict for
	 * `retry`.
	 */
	function reconcile() {
		const running = run(async () => {
			if (review !== undefined) return Ok(undefined);
			const path = state.file.path;
			const { data: merged, error } = await source.merge(path, {
				base: base.value,
				ours: $state.snapshot(draft) as TValue,
			});
			if (released) return SessionError.Released();
			if (error !== null) return Err(error);
			if (merged.kind === 'saved') return showWritten(path);
			review = Object.freeze({
				id: crypto.randomUUID(),
				conflicts: merged.conflicts,
				problems: [],
			});
			answer = merged.resolve;
			return Ok(undefined);
		});
		merging = running;
		void running.finally(() => {
			if (merging === running) merging = undefined;
		});
		return running;
	}

	/**
	 * Write one choice for every part of `review` over the version its merge
	 * read. A refusal keeps the review with its problems; a further change
	 * made elsewhere starts a new review.
	 */
	async function resolve(
		choices: SyncChoices,
	): Promise<Result<Resolved, Failure>> {
		const shown = review;
		const resolved = await run(async () => {
			const write = answer;
			if (shown === undefined || review !== shown || write === undefined)
				return SessionError.NothingToResolve();
			const { error } = await write(choices);
			if (released) return SessionError.Released();
			if (error === null) return showWritten(state.file.path);
			if (error.name === 'InvalidChoices' && 'problems' in error)
				review = Object.freeze({
					...shown,
					problems: error.problems as readonly SyncChoiceProblem[],
				});
			return Err(error);
		});
		if (
			resolved.error?.name === 'Conflict' &&
			shown !== undefined &&
			review === shown
		) {
			review = undefined;
			void reconcile();
		}
		return resolved;
	}

	return {
		/** The value on screen: the caller's to read, changed only through `edit`. */
		get draft() {
			return draft;
		},
		get state() {
			return state;
		},
		get path() {
			return state.file.path;
		},
		/** Advanced each time a read replaces the draft. */
		get generation() {
			return generation;
		},
		/** Input is refused now: a command runs, the app locked it, or it was released. */
		get locked() {
			return locked();
		},
		/** The competing parts awaiting the person's choice, if a merge left any. */
		get review() {
			return review;
		},
		/**
		 * Change the draft and save it: `change` mutates the draft or returns
		 * its replacement. Refused, changing nothing, while locked.
		 */
		edit(change: (draft: TValue) => TValue | void) {
			if (locked()) return;
			const next = change(draft);
			if (next !== undefined) draft = next;
			request();
		},
		/** Request the draft again after a failed save. */
		retry() {
			if (!locked()) request();
		},
		/** The latest save state once running commands and saves have finished. */
		settled,
		/** Let the session go: it takes no input, and a running command starts nothing more. */
		release() {
			released = true;
		},
		/**
		 * Answer every part of `review` at once and write the result over the
		 * version its merge read. `shown`: the draft now shows the file;
		 * `gone`: the file was left deleted; `other`: it is no longer this
		 * session's kind. The caller closes or reopens the item for the last two.
		 */
		resolve,
		/**
		 * Take a newer version of the file when nothing of the person's is
		 * waiting: no command runs, the session is saved, and no edit lands
		 * while it reads. A file that is gone or cannot be shown is left for
		 * the next save to report. Answers whether the draft changed.
		 */
		async adopt(): Promise<boolean> {
			if (locked() || state.status !== 'saved') return false;
			const before = state;
			const { data: found } = await source.reread(before.file.path);
			if (locked() || state !== before || found?.kind !== 'value') return false;
			if (found.file.sha256 === before.file.sha256) return false;
			replace(found.file, found.value);
			return true;
		},
		/**
		 * Move the file once its saves have landed: `move` performs the guarded
		 * move of what the last save confirmed and answers the capture at the
		 * new path. A draft whose save failed is requested again there.
		 */
		rename(
			move: (file: FileCapture) => Promise<Result<FileCapture, Failure>>,
		): Promise<Result<undefined, Failure>> {
			return run(async () => {
				const failed = state.status === 'error';
				const { data: moved, error } = await move(state.file);
				if (error !== null) return Err(error);
				start(moved, base.value);
				if (failed && !released) request();
				return Ok(undefined);
			});
		},
	};
}

export type EditSession<TValue, TError extends Failure, TOther> = ReturnType<
	typeof createEditSession<TValue, TError, TOther>
>;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type RowSaveErrorOf<TFields> =
	Parameters<
		Parameters<FileTable<TFields>['autosave']>[1]['onState']
	>[0] extends SaveState<infer E>
		? E
		: never;

/** Why a row file cannot be shown as a row: its text is not a valid row, or not text. */
export type RowProblem = Extract<
	RowReadError,
	{ name: 'InvalidRow' | 'InvalidUtf8' }
>;

/** A row file's table as a session source. */
export function rowSource<TFields>(
	table: FileTable<TFields>,
): EditSource<Row<TFields>, RowSaveErrorOf<TFields>, RowProblem> {
	return {
		autosave: (file, options) => table.autosave(file, options),
		async reread(path) {
			const stem = rowStemOf(table.name, path);
			if (stem === undefined)
				return Err({ name: 'InvalidPath', message: `${path} is not a row` });
			const { data: stored, error } = await table.get(stem);
			if (error?.name === 'InvalidRow' || error?.name === 'InvalidUtf8')
				return Ok({ kind: 'other', file: captureOf(error), detail: error });
			if (error !== null) return Err(error);
			if (stored === undefined) return Ok({ kind: 'gone' });
			return Ok({ kind: 'value', file: captureOf(stored), value: stored.row });
		},
		merge: (path, versions) => table.merge(path, versions),
	};
}

/** A session over one valid row. */
export function createRowSession<TFields>(
	table: FileTable<TFields>,
	stored: FileCapture & { readonly row: Row<TFields> },
	options?: { locked?: () => boolean },
) {
	return createEditSession(
		rowSource(table),
		{ file: stored, value: stored.row },
		options,
	);
}

export type RowSession<TFields> = ReturnType<typeof createRowSession<TFields>>;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text files as a session source. A file that is not UTF-8 text is `other`. */
export function textSource(
	files: FolderFiles,
): EditSource<string, FileError | AutosaveError, 'binary'> {
	return {
		autosave: (file, options) => files.autosave(file, options),
		async reread(path) {
			const { data: read, error } = await files.read(path);
			if (error?.name === 'NotFound') return Ok({ kind: 'gone' });
			if (error !== null) return Err(error);
			const file = captureOf(read);
			try {
				return Ok({ kind: 'value', file, value: utf8.decode(read.bytes) });
			} catch {
				return Ok({ kind: 'other', file, detail: 'binary' });
			}
		},
		merge: (path, versions) => files.merge(path, versions),
	};
}

/** A session over one text file. Input is kept well formed. */
export function createTextSession(
	files: FolderFiles,
	opened: FileCapture & { readonly text: string },
	options?: { locked?: () => boolean },
) {
	const session = createEditSession(
		textSource(files),
		{ file: opened, value: opened.text },
		options,
	);
	return Object.assign(session, {
		/** Replace the text and save it. */
		input(text: string) {
			session.edit(() => wellFormed(text));
		},
	});
}

export type TextSession = ReturnType<typeof createTextSession>;
