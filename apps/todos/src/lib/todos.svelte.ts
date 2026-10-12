/**
 * The Todos product state over one opened folder.
 *
 * Two listings refresh together: the todo rows in `todos/*.md`, and the
 * folder listing the file browser shows. They are read when the page opens,
 * after each of the app's own actions and terminal commands, and when the
 * person returns to the window. The latest refresh wins. The list offers the
 * rows that read as todos and names the rest, with why, for repair as text.
 *
 * One item is open at a time, kept by the shared open-item slot
 * (`@epicenter/svelte/open-item`) under its path and the workspace that
 * opened it. A todo opened from the list is a row session over its fields
 * and notes; a file opened from Files, or a todo whose text is not a valid
 * row, is a text session over its exact text
 * (`@epicenter/svelte/edit-session`). Leaving an item waits for its saves,
 * then releases its session and lists again. A save that failed or
 * conflicted keeps the item open until the person discards the draft
 * (`open` answers `unsaved` with that session, and the view asks). Opening
 * the item already shown does nothing; `reload` reads it again.
 *
 * Returning to the window takes a newer version of the open item when its
 * session holds nothing unsaved. Otherwise the next save reports the change
 * as a conflict, and the person keeps theirs or reloads.
 *
 * Sync (`folder.sync`) waits for the open item's saves, then commits, fetches,
 * merges, and pushes. Conflicts come back as one attempt whose review is
 * modal: the open item takes no input from the start of a sync until its
 * attempt is applied or cancelled, and nothing about it is remembered. Afterward the
 * listings and the open item are read again as on return.
 */
import type { DepartureParticipant } from '@epicenter/epicenter/departure/page';
import type {
	AutosaveError,
	CommitAndPushResult,
	FileCapture,
	FileError,
	FileListing,
	MergeOutcome,
	MoveError,
	PullError,
	PullOutcome,
	RecoverOutcome,
	RowReadError,
	StoredRow,
	SyncAttempt,
	SyncChoices,
	SyncOutcome,
	TableError,
} from '@epicenter/folder';
import {
	GitError,
	type MergeError,
	rowPath,
	rowStemOf,
	SyncError,
} from '@epicenter/folder';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
} from '@epicenter/folder/file-browser';
import { createAdmissions } from '@epicenter/svelte/admissions';
import {
	createRowSession,
	createTextSession,
	type RowSession,
	type TextSession,
} from '@epicenter/svelte/edit-session';
import { createOpenItem, type Opening } from '@epicenter/svelte/open-item';
import { createSyncController } from '@epicenter/svelte/sync';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import { nameProblem, readTextFile } from './files.js';
import type { TodosFolder } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

const log = createLogger('todos');

export type Todos = ReturnType<typeof createTodos>;

/** A todo row as the table last listed it. */
export type TodoEntry = StoredRow<TodoFields> & { readonly stem: string };

/** A row file the list cannot edit, and why, for the person to repair as text. */
type Repair = { readonly path: string; readonly reason: string };

/** The surface a path was opened from, which decides how it is edited. */
export type Workspace = 'files' | 'todos';

/** The edit session of an open todo or text file. */
export type Session = RowSession<TodoFields> | TextSession;

/**
 * Where an item is: its path, and how it is edited. A todo whose text is not
 * a valid row is shown under `repair`, so opening it as a todo once it reads
 * as one is a different key; `repair` loads the way `todos` does.
 */
type Key = { readonly path: string; readonly workspace: Workspace | 'repair' };

/** What the loader builds for a key. */
type Item =
	| { readonly kind: 'todo'; readonly session: RowSession<TodoFields> }
	| {
			readonly kind: 'text';
			readonly workspace: Workspace;
			readonly session: TextSession;
	  }
	| {
			readonly kind: 'failed';
			readonly path: string;
			readonly workspace: Workspace;
			readonly message: string;
	  }
	| {
			readonly kind: 'binary' | 'tooLarge';
			readonly path: string;
			readonly size: number;
	  };

/** The open item, or the one loading: what the detail shows. */
export type Opened =
	| {
			readonly kind: 'loading';
			readonly path: string;
			readonly workspace: Workspace;
	  }
	| Item;

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| (FileCapture & { readonly kind: 'todo'; readonly title: string })
	| (FileCapture & { readonly kind: 'file' })
	| { readonly kind: 'folder'; readonly path: string };

/** What one explicit request to recover the pending incoming update did. */
export type RecoveryAttempt =
	/** The open item holds a draft it could not save; nothing ran. */
	| { readonly kind: 'unsettled'; readonly paths: readonly string[] }
	/** Another change to the folder was in progress; nothing ran. */
	| { readonly kind: 'busy' }
	| {
			readonly kind: 'ran';
			readonly result: Result<RecoverOutcome, PullError | GitError>;
	  };

/** What the terminal close left unsaved. */
export type CloseOutcome = { readonly unsettled: readonly string[] };

/** Why input or a command was refused while Epicenter asks to quit or restart. */
export const DEPARTING =
	'Epicenter is asking to quit or restart, so nothing is changed now. Your edits are kept.';
/** Why a pull or merge stopped after its fetch: Epicenter asked to leave meanwhile. */
const WITHDRAWN =
	'Epicenter asked to quit or restart after the fetch, so nothing was applied. Try again after it finishes or is cancelled.';
const CLOSING = 'Todos is closing, so nothing was changed.';
const BUSY = 'Another change is still in progress. Try again when it finishes.';
/** Why a new file did not open: the open one holds changes it could not save. */
const UNSAVED_STAYS =
	'It was added, but the open file has changes that are not saved, so it stays open.';

/** The path an open item is at. */
export function pathOf(item: Opened): string {
	return item.kind === 'todo' || item.kind === 'text'
		? item.session.path
		: item.path;
}

/** The workspace an open item was opened from. */
export function workspaceOf(item: Opened): Workspace {
	if (item.kind === 'todo') return 'todos';
	return 'workspace' in item ? item.workspace : 'files';
}

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, a move that kept its source left both
 * files, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error:
		| FileError
		| MoveError
		| TableError
		| AutosaveError
		| { readonly name: string; readonly message: string }
		| string,
): string {
	if (typeof error === 'string') return error;
	// A session's own refusals are named failures with a message of their own.
	const known = error as FileError | MoveError | TableError;
	switch (known.name) {
		case 'Exists':
			return `"${basename(known.path)}" already exists here.`;
		case 'Conflict':
			return known.actualSha256 === undefined
				? 'The file is no longer here, so nothing was changed.'
				: 'The file changed elsewhere, so nothing was changed. Check it and try again.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'SourceNotRemoved':
			return `The file was copied to ${known.to}, but ${known.from} could not be removed, so the folder now has both. Delete whichever you do not want.`;
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${known.message}`;
		case 'InvalidValues':
			return known.issues.map((issue) => issue.message).join(' ');
		default:
			return known.message;
	}
}

/** Why a listed row file is not a todo the list can edit. */
function repairOf(path: string, error: RowReadError): Repair {
	if (error.name === 'InvalidRow')
		return {
			path,
			reason: error.issues.map((issue) => issue.message).join(' '),
		};
	return { path, reason: `It could not be read as text: ${error.message}` };
}

function byPath(a: { path: string }, b: { path: string }) {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** A failure `describeError` can state. */
type Problem = Parameters<typeof describeError>[0];

function sameKey(a: Key, b: Key) {
	return a.path === b.path && a.workspace === b.workspace;
}

function sessionOf(item: Item): Session | undefined {
	return item.kind === 'todo' || item.kind === 'text'
		? item.session
		: undefined;
}

/** The key `item` is shown under now: at its session's path, which follows a rename. */
function keyOf(item: Item, asked: Key): Key {
	if (item.kind === 'todo')
		return { path: item.session.path, workspace: 'todos' };
	if (item.kind === 'text')
		return {
			path: item.session.path,
			workspace: item.workspace === 'todos' ? 'repair' : 'files',
		};
	return asked;
}

export function createTodos(folder: TodosFolder) {
	const table = folder.tables.todos;
	/** Rows that read as todos: what the list offers to edit. */
	let entries = $state.raw<TodoEntry[]>([]);
	/** Row files the list does not offer, each with why. */
	let repairs = $state.raw<Repair[]>([]);
	/** Every row file in the last listing, todo or not. */
	let rowPaths = $state.raw<ReadonlySet<string>>(new Set());
	let listError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>(['todos']);
	let refreshSequence = 0;
	let closing: Promise<CloseOutcome> | undefined;
	/** Aborted when `close` starts: the app's own Git network waits stop. */
	const leaving = new AbortController();
	/**
	 * Work started and not finished: Git commands, recoveries, file actions,
	 * conflict commands, and terminal commands. A departure's drain and
	 * `close` wait for it.
	 */
	const admissions = createAdmissions();
	let recovering = $state(false);
	let lastRecovery = $state.raw<
		(RecoveryAttempt & { readonly at: number }) | undefined
	>();
	/**
	 * Epicenter asks to quit or restart. From `departure.fence` until
	 * `departure.resume`, no action starts and the open item takes no input;
	 * saves already requested go on.
	 */
	let departing = $state(false);
	/** The title typed for a new todo and not yet added. */
	let newTitle = $state('');
	/**
	 * Sync's state: the run or Apply in flight, and the attempt the review
	 * answers. The open item's saves land first, so the checkpoint holds
	 * them; afterwards everything is read again, as on return.
	 */
	const syncs = createSyncController({
		folder,
		beforeSync: async () => slot.session?.settled(),
		afterSync: () => check(),
		// Its own state is the controller's to check: an Apply runs while
		// the review locks everything else.
		refused: () =>
			closing !== undefined
				? CLOSING
				: departing
					? DEPARTING
					: recovering
						? BUSY
						: undefined,
	});

	/** Whether the open item refuses input now. */
	const locked = () =>
		departing || recovering || syncs.locked || closing !== undefined;

	/** Why no action starts now, if one does not. */
	function refused(): string | undefined {
		if (closing !== undefined) return CLOSING;
		if (departing) return DEPARTING;
		if (recovering || syncs.locked) return BUSY;
		return undefined;
	}

	function openRow(stored: StoredRow<TodoFields>): Item {
		return {
			kind: 'todo',
			session: createRowSession(table, stored, { locked }),
		};
	}

	function openText(
		file: FileCapture & { text: string },
		workspace: Workspace,
	): Item {
		return {
			kind: 'text',
			workspace,
			session: createTextSession(folder.files, file, { locked }),
		};
	}

	/** Read `path` the way `workspace` opens it. */
	async function load({ path, workspace }: Key): Promise<Item> {
		const stem = rowStemOf(table.name, path);
		if (workspace !== 'files' && stem !== undefined) {
			const { data: stored, error } = await table.get(stem);
			if (error?.name === 'InvalidRow') return openText(error, 'todos');
			if (error !== null)
				return {
					kind: 'failed',
					path,
					workspace: 'todos',
					message: error.message,
				};
			if (stored === undefined)
				return {
					kind: 'failed',
					path,
					workspace: 'todos',
					message: 'This todo is no longer in the folder.',
				};
			return openRow(stored);
		}
		const { data: read, error } = await readTextFile(folder.files, path);
		const as = workspace === 'files' ? 'files' : 'todos';
		if (error !== null)
			return { kind: 'failed', path, workspace: as, message: error.message };
		if (read.kind !== 'text') return { ...read, path };
		return openText(read.file, as);
	}

	const slot = createOpenItem<Key, Item, Session>({
		load,
		sessionOf,
		keyOf,
		sameKey,
		closed: () => closing !== undefined,
	});

	/** What the detail shows: the open item, or the one loading. */
	const opened = $derived.by((): Opened | undefined => {
		const shown = slot.shown;
		if (shown === undefined) return undefined;
		if (shown.status === 'open') return shown.item;
		const { path, workspace } = shown.key;
		return {
			kind: 'loading',
			path,
			workspace: workspace === 'files' ? 'files' : 'todos',
		};
	});

	const shell = folder.terminal();
	const terminal = createTerminalSession(
		{
			get cwd() {
				return shell.cwd;
			},
			exec: (command, options) =>
				closing !== undefined
					? Promise.resolve({
							stdout: '',
							stderr: 'The folder is closed\n',
							exitCode: 1,
						})
					: departing
						? Promise.resolve({
								stdout: '',
								stderr: `${DEPARTING}\n`,
								exitCode: 1,
							})
						: admissions.admit(() => shell.exec(command, options)),
		},
		() => check(),
		() => departing,
	);

	/** One listing pass. A pass that a newer one overtook, or that answers after close began, changes nothing. */
	async function refresh() {
		if (closing !== undefined) return;
		const sequence = ++refreshSequence;
		const [
			{ data: rows, error: rowsError },
			{ data: files, error: filesError },
		] = await Promise.all([table.list(), folder.files.list()]);
		if (closing !== undefined || sequence !== refreshSequence) return;
		if (rowsError) {
			// Keep the previous listing visible; never show an empty list for a failed read.
			listError = rowsError.message;
		} else {
			const valid: TodoEntry[] = [];
			const repair: Repair[] = [];
			for (const { stem, result } of rows) {
				if (result.error === null) valid.push({ ...result.data, stem });
				else repair.push(repairOf(rowPath(table.name, stem), result.error));
			}
			listError = undefined;
			entries = valid.sort((a, b) => {
				const doneA = a.row.fields.done ? 1 : 0;
				const doneB = b.row.fields.done ? 1 : 0;
				return doneA - doneB || byPath(a, b);
			});
			repairs = repair.sort(byPath);
			rowPaths = new Set(rows.map(({ stem }) => rowPath(table.name, stem)));
		}
		if (filesError) listingError = filesError.message;
		else {
			listingError = undefined;
			listing = files;
		}
	}

	/** The listings, Git status, and a newer version of the open item when it holds nothing unsaved. */
	async function check() {
		if (closing !== undefined) return;
		await Promise.all([refresh(), folder.git.status(), slot.adopt()]);
	}

	/**
	 * Show `path` as `workspace` edits it: Files as the file's text, the todo
	 * list as a todo. The open item's saves land first, and the listings are
	 * read again. Opening the item already shown does nothing. Answers
	 * `unsaved` with the open session, opening nothing, when it holds a draft
	 * it could not save; the view asks the person, and opens again with
	 * `discard` naming that session.
	 */
	async function open(
		path: string,
		workspace: Workspace,
		{ discard }: { discard?: Session } = {},
	): Promise<Opening<Session>> {
		const opening = await slot.open({ path, workspace }, { discard });
		if (opening.kind !== 'done') return opening;
		if (workspace === 'files')
			for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		if (opening.left) void refresh();
		return opening;
	}

	/** Read the shown item again as it is now: Try again for one that failed to load. */
	async function reload() {
		if (await slot.reload()) void refresh();
	}

	/** The capture a deletion or rename of a closed file acts on: the file as it is now. */
	async function captureNow(
		path: string,
	): Promise<Result<FileCapture, FileError>> {
		const { data: read, error } = await folder.files.read(path);
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
	}

	/** The fields the list shows for `entry`: the open draft's when it is open. */
	function fieldsOf(entry: TodoEntry): TodoFields {
		return opened?.kind === 'todo' && opened.session.path === entry.path
			? opened.session.draft.fields
			: entry.row.fields;
	}

	/** Move a captured file: a todo row through its table, any other file as bytes. */
	function move(file: FileCapture, to: string) {
		const stem = rowStemOf(table.name, file.path);
		const nextStem = rowStemOf(table.name, to);
		return stem !== undefined && nextStem !== undefined
			? table.rename(file, nextStem)
			: folder.files.move(file, to);
	}

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		terminal,
		/** Rows that read as todos, as last listed. */
		get entries() {
			return entries;
		},
		/** Row files the list does not offer, with why; each opens as text for repair. */
		get repairs() {
			return repairs;
		},
		get listError() {
			return listError;
		},
		get listing() {
			return listing;
		},
		get listingError() {
			return listingError;
		},
		expanded,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/** The open item, the one loading, or `undefined`. */
		get opened() {
			return opened;
		},
		/** The open item's path and the workspace that opened it. */
		get current() {
			return opened && { path: pathOf(opened), workspace: workspaceOf(opened) };
		},
		fieldsOf,
		/** Whether `path` is a todo row file, whether or not its text reads as a todo. */
		isTodo(path: string) {
			return rowPaths.has(path);
		},
		/** Whether the open item has a save running or a draft it could not save. */
		get unsaved() {
			return slot.unsaved;
		},
		get saving() {
			return slot.session?.state.status === 'saving';
		},
		get saveProblems() {
			return slot.session?.state.status === 'error' ? 1 : 0;
		},
		get newTitle() {
			return newTitle;
		},
		set newTitle(title: string) {
			if (locked()) return;
			newTitle = title;
		},
		get departing() {
			return departing;
		},
		/** The open item's path while its draft holds a save that failed. */
		get failedSavePath() {
			const state = slot.session?.state;
			return state?.status === 'error' ? state.file.path : undefined;
		},
		/**
		 * The page's part in leaving Epicenter
		 * (`@epicenter/epicenter/departure/page`). `fence` runs before anything
		 * is awaited; `settle` lets running work and saves finish and answers
		 * how many things would be lost: a draft it could not save, and a typed
		 * title; `resume` gives everything back.
		 */
		departure: {
			/** Whether leaving would lose anything: an unsaved draft, a typed title, or running work. */
			get holdsUnsaved() {
				return slot.unsaved || newTitle.trim() !== '' || admissions.busy;
			},
			fence() {
				departing = true;
			},
			async settle(): Promise<number> {
				await admissions.quiet();
				const state = await slot.session?.settled();
				return (
					(state?.status === 'error' ? 1 : 0) + (newTitle.trim() === '' ? 0 : 1)
				);
			},
			resume() {
				departing = false;
			},
		} satisfies DepartureParticipant,
		refresh,
		/** The person's "Check again", and returning to the window. */
		check,
		open,
		reload,
		/**
		 * Answer `session`'s review, the open item's, with `choices`. A file
		 * left deleted closes; one that can no longer be shown as the session's
		 * value (a todo whose text is not a valid row, a file that is no longer
		 * text) opens again as it is now. Answers what the person is told, if
		 * anything.
		 */
		resolve: admissions.command(
			async (
				session: Session,
				choices: SyncChoices,
			): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const resolved = await slot.resolve(session, choices);
				if (resolved === undefined) return undefined;
				await refresh();
				return resolved.error === null
					? undefined
					: describeError(resolved.error);
			},
		),
		/** Add a todo and open it. */
		create: admissions.command(
			async (title: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const { data: created, error } = await table.create(
					{ fields: { title, done: false }, body: '' },
					{ stem: crypto.randomUUID() },
				);
				if (error !== null) return describeError(error);
				if (newTitle.trim() === title) newTitle = '';
				await refresh();
				const opening = await open(created.path, 'todos');
				return opening.kind === 'unsaved' ? UNSAVED_STAYS : undefined;
			},
		),
		/**
		 * Toggle completion to the opposite of what the list showed. The open
		 * todo takes it as an edit to its draft. A closed todo is replaced,
		 * guarded by the version the list read: one that changed since is
		 * refused, and the list reads it again.
		 */
		toggle: admissions.command(
			async (entry: TodoEntry): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const done = !fieldsOf(entry).done;
				if (opened?.kind === 'todo' && opened.session.path === entry.path) {
					opened.session.edit((row) => {
						row.fields.done = done;
					});
					return undefined;
				}
				if (opened?.kind === 'text' && opened.session.path === entry.path)
					return 'This todo is open as text, so change done there.';
				const { error } = await table.replace(entry, {
					fields: { ...entry.row.fields, done },
					body: entry.row.body,
				});
				await refresh();
				return error === null ? undefined : describeError(error);
			},
		),
		/**
		 * Rename a file within its folder. A todo row renames through its table;
		 * any other file moves as exact bytes. The open item waits for its saves
		 * and moves from what its last save confirmed; a closed file moves from
		 * what it holds now. No other file moves with either.
		 */
		rename: admissions.command(
			async (path: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const directory = dirname(path);
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const to = joinPath(directory, name);
				if (to === path) return undefined;
				const toRow = rowStemOf(table.name, to) !== undefined;
				const session = slot.session;
				const isOpen = session?.path === path;
				if (
					!toRow &&
					(rowPaths.has(path) || (isOpen && opened?.kind === 'todo'))
				)
					return 'A todo file keeps its .md extension.';
				let moved: Result<unknown, Problem>;
				if (isOpen) moved = await session.rename((file) => move(file, to));
				else {
					const { data: file, error } = await captureNow(path);
					moved = error !== null ? Err(error) : await move(file, to);
				}
				await refresh();
				return moved.error === null ? undefined : describeError(moved.error);
			},
		),
		/** A new empty text file, opened; it never replaces an existing one. */
		createFile: admissions.command(
			async (directory: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				const { error } = await folder.files.create(path, '');
				if (error !== null) return describeError(error);
				await refresh();
				const opening = await open(path, 'files');
				return opening.kind === 'unsaved' ? UNSAVED_STAYS : undefined;
			},
		),
		createFolder: admissions.command(
			async (directory: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				if (
					listing?.directories.includes(path) ||
					listing?.files.some((file) => file.path === path)
				)
					return `"${name}" already exists here.`;
				const { error } = await folder.files.mkdir(path);
				if (error !== null) return describeError(error);
				if (directory !== '') expanded.add(directory);
				await refresh();
				return undefined;
			},
		),
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * An open item's saves land first. Only empty folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const why = refused();
			if (why !== undefined) return Err(why);
			if (listing?.directories.includes(path)) {
				const prefix = `${path}/`;
				const occupied =
					listing.files.some((file) => file.path.startsWith(prefix)) ||
					listing.directories.some((directory) => directory.startsWith(prefix));
				if (occupied)
					return Err(
						'Only empty folders can be deleted here. Delete or move what is inside first.',
					);
				return Ok({ kind: 'folder', path });
			}
			let file: FileCapture;
			const session = slot.session;
			if (session?.path === path) file = (await session.settled()).file;
			else {
				const { data, error } = await captureNow(path);
				if (error !== null) return Err(describeError(error));
				file = data;
			}
			const stem = rowStemOf(table.name, path);
			if (stem === undefined || !rowPaths.has(path))
				return Ok({ kind: 'file', ...file });
			const title =
				opened?.kind === 'todo' && opened.session.path === path
					? opened.session.draft.fields.title
					: entries.find((entry) => entry.path === path)?.row.fields.title;
			return Ok({
				kind: 'todo',
				...file,
				title: title?.trim() ? title : basename(path),
			});
		},
		/**
		 * Delete what was confirmed. The open item's session is released first
		 * and its last saves land, so the delete removes what this app saved
		 * last; a file another program changed since is refused, and the open
		 * item opens again as it is now.
		 */
		remove: admissions.command(
			async (deletion: Deletion): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				let removed: Result<undefined, Problem>;
				if (deletion.kind === 'folder')
					removed = await folder.files.rmdir(deletion.path);
				else {
					const removeFile = (
						file: FileCapture,
					): Promise<Result<undefined, Problem>> =>
						deletion.kind === 'todo'
							? table.delete(file)
							: folder.files.remove(file);
					const session = slot.session;
					const fromOpen =
						session?.path === deletion.path
							? await slot.removeOpen(session, removeFile)
							: undefined;
					if (fromOpen !== undefined) removed = fromOpen;
					else {
						removed = await removeFile(deletion);
						// A file shown without a session (binary, too large, failed) closes too.
						if (
							removed.error === null &&
							opened !== undefined &&
							pathOf(opened) === deletion.path
						)
							slot.forget();
					}
				}
				await refresh();
				return removed.error === null
					? undefined
					: describeError(removed.error);
			},
		),
		/** Commit current saved files and push. */
		commitAndPush: admissions.command(
			async (): Promise<CommitAndPushResult> => {
				if (closing !== undefined)
					return { commit: { status: 'closed' }, push: { status: 'closed' } };
				if (departing)
					return {
						commit: { status: 'blocked', reason: DEPARTING },
						push: { status: 'skipped', reason: DEPARTING },
					};
				return folder.git.commitAndPush({ signal: leaving.signal });
			},
		),
		/** Fetch the remote's branch; nothing local changes. */
		fetch: admissions.command(
			async (): ReturnType<TodosFolder['git']['fetch']> => {
				if (closing !== undefined) return GitError.Closed();
				if (departing)
					return GitError.Failed({ operation: 'fetch', cause: DEPARTING });
				return folder.git.fetch({ signal: leaving.signal });
			},
		),
		/**
		 * Fetch, then apply the remote only as a clean fast-forward. A quit or
		 * restart asked for after the fetch withdraws the rest and says so.
		 */
		pull: admissions.command(
			async (): Promise<Result<PullOutcome, PullError | GitError>> => {
				if (closing !== undefined) return GitError.Closed();
				if (departing)
					return GitError.Failed({ operation: 'pull', cause: DEPARTING });
				const { error: fetchedError } = await folder.git.fetch({
					signal: leaving.signal,
				});
				if (closing !== undefined) return GitError.Closed();
				if (fetchedError) return Err(fetchedError);
				if (departing)
					return GitError.Failed({ operation: 'pull', cause: WITHDRAWN });
				const pulled = await folder.git.pullFastForward();
				await check();
				return pulled;
			},
		),
		/**
		 * Fetch, then merge the remote into the saved, committed folder: a
		 * fast-forward when possible, otherwise one merge commit. Never pushes.
		 */
		merge: admissions.command(
			async (): Promise<
				Result<MergeOutcome, MergeError | PullError | GitError>
			> => {
				if (closing !== undefined) return GitError.Closed();
				if (departing)
					return GitError.Failed({ operation: 'merge', cause: DEPARTING });
				const { error: fetchedError } = await folder.git.fetch({
					signal: leaving.signal,
				});
				if (closing !== undefined) return GitError.Closed();
				if (fetchedError) return Err(fetchedError);
				if (departing)
					return GitError.Failed({ operation: 'merge', cause: WITHDRAWN });
				const merged = await folder.git.mergeIncoming();
				await check();
				return merged;
			},
		),
		get syncing() {
			return syncs.syncing;
		},
		/** The attempt waiting for choices, if a sync found conflicts. */
		get syncAttempt() {
			return syncs.attempt;
		},
		/** Discard the waiting attempt and its choices. */
		cancelSync() {
			syncs.cancel();
		},
		get syncProblems() {
			return syncs.problems;
		},
		/**
		 * Commit saved files, fetch, merge, and push. Conflicts become the
		 * attempt the review shows; a new sync replaces an earlier one.
		 */
		sync: admissions.command(
			async (): Promise<Result<SyncOutcome, SyncError>> =>
				closing !== undefined ? SyncError.Closed() : syncs.run(),
		),
		/**
		 * Apply the review's choices. Refused choices stay in the review with
		 * what to fix; any other result ends this attempt.
		 */
		resolveSync: admissions.command(
			async (
				attempt: SyncAttempt,
				choices: SyncChoices,
			): Promise<Result<SyncOutcome, SyncError>> =>
				closing !== undefined
					? SyncError.Closed()
					: syncs.apply(attempt, choices),
		),
		get recovering() {
			return recovering;
		},
		get lastRecovery() {
			return lastRecovery;
		},
		/**
		 * Recover the incoming update in `git.pendingIncoming`, only because the
		 * person asked. The open item's saves land first; a draft that could not
		 * save refuses, and nothing runs. While it runs the open item takes no
		 * input, and afterward it shows what the update left.
		 */
		recoverIncoming: admissions.command(async (): Promise<RecoveryAttempt> => {
			if (closing !== undefined)
				return { kind: 'ran', result: GitError.Closed() };
			if (departing || recovering) return { kind: 'busy' };
			recovering = true;
			let attempt: RecoveryAttempt;
			try {
				const state = await slot.session?.settled();
				attempt =
					state?.status === 'error'
						? { kind: 'unsettled', paths: [state.file.path] }
						: { kind: 'ran', result: await folder.git.recoverIncoming() };
			} finally {
				recovering = false;
			}
			lastRecovery = { ...attempt, at: Date.now() };
			await check();
			return attempt;
		}),
		/**
		 * Let running work and the open item's saves finish, then release the
		 * folder. A draft that could not save ends with the page; the
		 * completion names its path. Every call answers the same completion.
		 */
		close(): Promise<CloseOutcome> {
			if (closing !== undefined) return closing;
			const completion = Promise.withResolvers<CloseOutcome>();
			closing = completion.promise;
			leaving.abort();
			void (async (): Promise<CloseOutcome> => {
				await admissions.quiet();
				const path = await slot.close();
				const unsettled = path === undefined ? [] : [path];
				if (unsettled.length > 0)
					log.warn(
						new Error(
							`Closed with input that could not be saved, in ${unsettled.join(', ')}`,
						),
					);
				await folder.close();
				return Object.freeze({ unsettled: Object.freeze(unsettled) });
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	};
}
