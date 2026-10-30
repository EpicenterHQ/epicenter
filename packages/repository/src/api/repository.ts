/**
 * An app's repository as a page uses it: one handle, made before the
 * replica opens and kept until the page closes it, over however many worker
 * sessions come and go beneath it (another tab taking the replica, the page
 * hiding and showing again). Its `status()` says whether it can save now;
 * while it cannot, every write is refused at once and nothing is projected.
 *
 * A collection kept in memory (the default) holds every note whole: its
 * exact text, its fields checked against the schema (a note that does not
 * fit is listed with its issues), its body and its state. `all()` and
 * `get()` read it synchronously. Each session starts with an ordered
 * snapshot and then hears every change in revision order; a note whose
 * text and state did not change keeps its object, so a list keyed by
 * identity does not redraw it. A collection declared `memory: false` keeps
 * nothing here: `read()` fetches one note, and `query()` runs SQL.
 *
 * Writes are changes the worker applies over the text it holds, one
 * transaction each (`commit` for several at once, blobs included: one
 * group, which lands in one commit or not at all). On a collection kept in
 * memory they show at once: the change is projected over the stored note
 * until its answer, and dropped if it fails. `subscribe` is the one way to
 * hear that anything changed.
 */
import type { Static, TSchema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import type { Delta, FileEntry, Row, SaveError, Snapshot } from '../client/page.js';
import { SaveError as SaveErrors } from '../client/page.js';
import type { BlobStoreError, Sealed } from '../client/blobs.js';
import { BlobError, type BlobPut, type Put, type PutError } from '../client/bytes.js';
import type { Change, Changed, ChangeError, FileStatus } from '../client/replica.js';
import { type App, type BlobName, type Definitions, type Lens, type NoteName, schemaIssues } from '../core/lens.js';
import { bodyOf, parseMarkdown, parsePointer, splitMarkdown, writeMarkdown } from '../core/markdown.js';
import { fold, isNote } from '../core/door.js';
import { buildPath, type Params, type TemplateError } from '../core/templates.js';
import type { SqlValue } from '../sql.js';
import { createEditors, type Editor, type EditorError, mergedOver, type Unsaved } from './editor.js';
import { RepositoryError, type RepositoryStatus } from './status.js';

export { RepositoryError, type RepositoryStatus } from './status.js';

// ============================================================================
// The host: where the replica runs, and its sessions
// ============================================================================

/** What a page asks of one worker session. Every call may reject once the session ends. */
export type Session = {
	snapshot(): Promise<Snapshot>;
	row(path: string): Promise<Row | null>;
	/** Every file the replica shows, with its state. */
	files(): Promise<FileEntry[]>;
	/** Every file not yet synced, with its state. */
	waiting(): Promise<FileEntry[]>;
	query<TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<TRow[]>;
	/** Apply `changes` in one transaction; the change it makes is heard with `token`. */
	change(changes: Change[], token: number): Promise<Result<Changed, ChangeError | SaveError>>;
	/** Hear each stored change in revision order; returns the function that stops it. */
	watch(listener: (delta: Delta) => void): () => void;
	/** Seal each blob, then store a pointer to it at its path together with `changes`, in one transaction; the change it makes is heard with `token`. */
	put(blobs: BlobPut[], changes: Change[], token: number): Promise<Result<Put, PutError>>;
	/** A blob's bytes as a File: from this device, or fetched and verified first. */
	open(path: string): Promise<Result<File, BlobError>>;
};

/** A host's state: a repository status, with the session while one is open. */
export type HostState = Exclude<RepositoryStatus, { status: 'open' }> | { status: 'open'; session: Session };

/** Where a replica runs for a page: it moves through states, opening a session each time it can. */
export type Host = {
	subscribe(onState: (state: HostState) => void): () => void;
	close(): void;
};

// ============================================================================
// What a page reads and writes
// ============================================================================


/** Why a write was not stored. */
export type WriteError = RepositoryError | ChangeError | SaveError | TemplateError;
/** Why the plain file API's text write was not stored: a write's reasons, or text at a path that is not a note. */
export type FileWriteError = WriteError | Extract<BlobError, { name: 'NotPointer' }>;

/** A stored write: the note's text after it (null: no note) and the revision it made. */
export type Written = { text: string | null; revision: number };

/** A stored batch: the revision it made. */
export type Committed = { revision: number };

type NoteParts<TPath extends string> = {
	path: string;
	params: Params<TPath>;
	/** The exact text. */
	text: string;
	body: string;
	state: FileStatus;
};
/** A note whose fields fit its schema. */
export type ValidNote<TPath extends string = string, TNoteSchema extends TSchema = TSchema> = NoteParts<TPath> & { valid: true; fields: Static<TNoteSchema> };
/** A note whose frontmatter does not parse or does not fit its schema: its fields as written, and why. */
export type InvalidNote<TPath extends string = string> = NoteParts<TPath> & { valid: false; fields: Record<string, unknown>; issues: string[] };
/** A note as a page reads it: narrow on `valid` once. */
export type Note<TPath extends string = string, TNoteSchema extends TSchema = TSchema> = ValidNote<TPath, TNoteSchema> | InvalidNote<TPath>;

export type NoteInput<TNoteSchema extends TSchema> = { fields?: Partial<Static<TNoteSchema>>; body?: string };

/** Field changes: a key set to undefined is removed. */
export type FieldPatch<TNoteSchema extends TSchema> = { [K in keyof Static<TNoteSchema>]?: Static<TNoteSchema>[K] | undefined };

/** What any collection writes. */
export type Writes<TPath extends string, TNoteSchema extends TSchema> = {
	/** A new note. Where one is already, it stays, and this one is added to it as one conflict block. */
	create(params: Params<TPath>, input?: NoteInput<TNoteSchema>): Promise<Result<Written, WriteError>>;
	/** Set fields on the note as the worker holds it; its other keys, their formatting and its body stay. */
	patch(params: Params<TPath>, fields: FieldPatch<TNoteSchema>): Promise<Result<Written, WriteError>>;
	delete(params: Params<TPath>): Promise<Result<Written, WriteError>>;
	/** Exact source: `text`, made from `over` (merged where the note moved since); without `over`, over what the worker holds. */
	write(params: Params<TPath>, text: string | null, options?: { over?: string | null }): Promise<Result<Written, WriteError>>;
	/** The editor of one note, shared by every view of it: each view closes it when done. */
	openEditor(params: Params<TPath>): Promise<Result<Editor, WriteError | EditorError>>;
};

/** A stored blob write: the pointer's text and the revision it made, and the bytes' oid and size. */
export type BlobWritten = Written & Sealed;

/** Why a blob write, or a batch holding one, was not stored. */
export type BlobWriteError = WriteError | BlobError | BlobStoreError;

/** Why a blob could not be opened. */
export type OpenBlobError = BlobError | RepositoryError | TemplateError;

/**
 * A collection of blobs, named by the app (`recordings/{stem}.webm`). A
 * write is compare-and-swap (core/settle, `settlePointer`): it lands only
 * over the blob this device saw at the path, or none for a create; one
 * that does not land is held with why, and a delete that does not land
 * leaves the file. The bytes are sealed on this device before the pointer
 * is stored, and uploaded beside the commit flow.
 */
export type BlobCollection<TPath extends string> = {
	/** New bytes at a path this device shows no file at; refused at once where it shows one. */
	create(params: Params<TPath>, blob: Blob): Promise<Result<BlobWritten, BlobWriteError>>;
	/** Other bytes at a path this device shows a file at; refused at once where it shows none. */
	replace(params: Params<TPath>, blob: Blob): Promise<Result<BlobWritten, BlobWriteError>>;
	delete(params: Params<TPath>): Promise<Result<Written, WriteError>>;
	/** The bytes as a File typed by the path's extension: from this device, or fetched and verified first. */
	open(params: Params<TPath>): Promise<Result<File, OpenBlobError>>;
};

/** A collection kept in memory: every note, synchronously. */
export type MemoryCollection<TPath extends string, TNoteSchema extends TSchema> = Writes<TPath, TNoteSchema> & {
	/** Every note, ordered by path. The same array until one of them changes. */
	all(): Note<TPath, TNoteSchema>[];
	get(params: Params<TPath>): Note<TPath, TNoteSchema> | undefined;
};

/** A collection not kept in memory: one note at a time, and SQL. */
export type StoredCollection<TPath extends string, TNoteSchema extends TSchema> = Writes<TPath, TNoteSchema> & {
	read(params: Params<TPath>): Promise<Result<Note<TPath, TNoteSchema> | null, RepositoryError | TemplateError>>;
};

type BlobCollectionOf<TDef> = TDef extends { path: infer TPath extends string; blob: true } ? BlobCollection<TPath> : never;

type CollectionOf<TDef> = TDef extends { path: infer TPath extends string; schema: infer TNoteSchema extends TSchema }
	? TDef extends { memory: false }
		? StoredCollection<TPath, TNoteSchema>
		: MemoryCollection<TPath, TNoteSchema>
	: never;

/** The write verbs of a collection inside `commit`: each adds one change to the batch. */
type BatchCollection<TDef> = TDef extends { path: infer TPath extends string; schema: infer TNoteSchema extends TSchema }
	? {
			create(params: Params<TPath>, input?: NoteInput<TNoteSchema>): void;
			patch(params: Params<TPath>, fields: FieldPatch<TNoteSchema>): void;
			delete(params: Params<TPath>): void;
			write(params: Params<TPath>, text: string | null, options?: { over?: string | null }): void;
		}
	: never;

/** A blob collection's writes inside `commit`: its bytes are sealed before the batch is stored, and the batch waits for them to upload. */
type BatchBlobCollection<TDef> = TDef extends { path: infer TPath extends string; blob: true }
	? {
			create(params: Params<TPath>, blob: Blob): void;
			replace(params: Params<TPath>, blob: Blob): void;
			delete(params: Params<TPath>): void;
		}
	: never;

/** What changed, for a subscriber: the collections whose notes changed, whether any file did (in a collection or none), and whether the status did. */
export type RepositoryChange = { collections: string[]; files: boolean; status: boolean };

export type { FileEntry };

/** A file's exact text as the plain file API reads it, with its state. */
export type FileText = { path: string; text: string; state: FileStatus };

/**
 * The plain file API: every file of the repository by its path, in a
 * collection or none, as Git has it. Every app has it; collections are typed
 * views over the same files, not permissions (ADR-0694). A write to a path
 * a collection kept in memory claims shows there at once, as that
 * collection's own write would.
 */
export type Files = {
	/** Every file this device shows, ordered by path, with its state. */
	list(): Promise<Result<FileEntry[], RepositoryError>>;
	/** Every file not yet synced (sending, or held with why), deletes included: as many as wait, never the whole repository, so a status can count them on every change. */
	waiting(): Promise<Result<FileEntry[], RepositoryError>>;
	/** One file's exact text, found by any spelling of its path, or null for none. */
	read(path: string): Promise<Result<FileText | null, RepositoryError>>;
	/**
	 * A new file. A note (`.md`) is text, merged with one already there; any
	 * other file is bytes, a blob collection's create: refused at once where
	 * this device shows a file.
	 */
	create(path: string, text: string): Promise<Result<Written, FileWriteError>>;
	create(path: string, blob: Blob): Promise<Result<BlobWritten, BlobWriteError>>;
	/** Other bytes at a path this device shows a file that is not a note at. */
	replace(path: string, blob: Blob): Promise<Result<BlobWritten, BlobWriteError>>;
	/** A file's bytes as a File typed by its extension: from this device, or fetched and verified first. */
	open(path: string): Promise<Result<File, OpenBlobError>>;
	/** Exact text (null deletes), merged where the file moved since `over`. */
	write(path: string, text: string | null, options?: { over?: string | null }): Promise<Result<Written, FileWriteError>>;
	delete(path: string): Promise<Result<Written, WriteError>>;
	/** The one editor of the file's exact text, shared by every view of it. */
	openEditor(path: string): Promise<Result<Editor, WriteError | EditorError>>;
};

/** The plain file API's writes, inside `commit`. */
export type BatchFiles = {
	/** A note is text; any other file is bytes, a blob collection's create. */
	create(path: string, content: string | Blob): void;
	replace(path: string, blob: Blob): void;
	write(path: string, text: string | null, options?: { over?: string | null }): void;
	delete(path: string): void;
};

export type Repository<TDefs extends Definitions> = { [K in NoteName<TDefs>]: CollectionOf<TDefs[K]> } & { [K in BlobName<TDefs>]: BlobCollectionOf<TDefs[K]> } & {
	status(): RepositoryStatus;
	/** The revision of the last change heard: every SQL result older than it may be stale. */
	revision(): number;
	/** Be told after anything changes; returns the function that stops it. */
	subscribe(listener: (change: RepositoryChange) => void): () => void;
	/** The plain file API. */
	files: Files;
	/** One read-only SQL statement over the app's views, or `"epicenter/files"`. */
	query<TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<Result<TRow[], RepositoryError>>;
	/**
	 * Several writes, blobs included, stored on this device as one
	 * transaction: every path is checked and every blob sealed first, so
	 * either all of it is stored or none is, and the page hears it as one
	 * change. From there each file goes to the server on its own, like any
	 * save: one that cannot go yet (held, or owed its bytes) waits alone.
	 */
	commit(
		build: (batch: { [K in NoteName<TDefs>]: BatchCollection<TDefs[K]> } & { [K in BlobName<TDefs>]: BatchBlobCollection<TDefs[K]> } & { files: BatchFiles }) => void,
	): Promise<Result<Committed, BlobWriteError>>;
	/** Stop: every editor stops and the host lets the replica go. Returns the drafts that could not be saved, for the caller to keep or drop (an account change). */
	close(): Unsaved[];
};

// ============================================================================
// The repository
// ============================================================================

type NoteLens = Extract<Lens, { kind: 'note' }>;
type BlobLens = Extract<Lens, { kind: 'blob' }>;
const headerOf = (text: string) => text.slice(0, splitMarkdown(text).bodyStart);
const byPath = (a: Note, b: Note) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
/** Where `path` is in a list ordered by path, or -1. */
function indexOf(list: Note[], path: string) {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((list[mid]?.path ?? '') < path) lo = mid + 1;
		else hi = mid;
	}
	return list[lo]?.path === path ? lo : -1;
}
const SENDING: FileStatus = { status: 'sending' };
const sameState = (a: FileStatus, b: FileStatus) => a.status === b.status && a.reason === b.reason;

/** A change as it shows before its answer, over a note's text, applied as the worker will apply it. */
function project(text: string | null, change: Change): string | null {
	switch (change.kind) {
		case 'create':
			return text === null ? change.text : mergedOver(null, text, change.text);
		case 'write':
			return change.over === undefined ? change.text : mergedOver(change.over, text, change.text);
		case 'delete':
			return null;
		case 'patch':
			return text === null ? null : (writeMarkdown(text, { fields: change.fields }).data ?? text);
	}
}

/** Open `app`'s repository over `host`. */
export function openRepository<TDefs extends Definitions>({ app, host }: { app: App<TDefs>; host: Host }): Repository<TDefs> {
	const notesOf = new Map<string, Map<string, Note>>();
	const lists = new Map<string, Note[]>();
	const lenses = app.lenses.filter((lens): lens is NoteLens => lens.kind === 'note');
	for (const lens of lenses) if (lens.memory) notesOf.set(lens.name, new Map());

	let status: RepositoryStatus = { status: 'opening' };
	let session: Session | null = null;
	let stopWatching: (() => void) | null = null;
	let revision = 0;
	/** Each note kept in memory as the worker last said, by path. */
	let stored = new Map<string, Row>();
	/** The spelling of each kept note's path, by its fold: paths equal after NFC and case folding are one path. */
	let spellings = new Map<string, string>();
	/** `path` as this device spells it, when a note kept in memory is stored under another spelling of it. */
	const spelled = (path: string) => spellings.get(fold(path)) ?? path;
	function store(path: string, row: Row | null) {
		if (row !== null) {
			stored.set(path, row);
			spellings.set(fold(path), path);
			return;
		}
		stored.delete(path);
		if (spellings.get(fold(path)) === path) spellings.delete(fold(path));
	}
	/**
	 * Writes sent and not yet stored, by path, in the order sent: shown over
	 * the stored note until the change they made is heard (its `token`), so
	 * the rows that hold them are never shown with them applied again.
	 * `done` settles once their answer is in.
	 */
	const pending = new Map<string, { id: number; token: number; change: Change; done: Promise<void> }[]>();
	let nextId = 1;
	let nextToken = 1;
	/** Stop showing the writes sent with `token`: what is stored holds them now. */
	function storedWith(token: number) {
		for (const [path, writes] of pending) {
			const left = writes.filter((write) => write.token !== token);
			if (left.length === writes.length) continue;
			if (left.length === 0) pending.delete(path);
			else pending.set(path, left);
		}
	}
	const listeners = new Set<(change: RepositoryChange) => void>();
	const touched = new Set<string>();
	let filesChanged = false;
	let statusChanged = false;

	function emit() {
		if (touched.size === 0 && !filesChanged && !statusChanged) return;
		const change = { collections: [...touched].sort(), files: filesChanged, status: statusChanged };
		touched.clear();
		filesChanged = false;
		statusChanged = false;
		for (const listener of listeners) listener(change);
	}
	const setStatus = (next: RepositoryStatus) => {
		status = next;
		statusChanged = true;
	};

	/** The note collections that claim a path, with its parameters: apps combined may share one. */
	function claims(path: string): { lens: NoteLens; params: Record<string, string> }[] {
		return app.claims(path).flatMap((claim) => (claim.lens.kind === 'note' ? [{ lens: claim.lens, params: claim.params }] : []));
	}

	function toNote(lens: NoteLens, path: string, params: Record<string, string>, text: string, fields: string | null | undefined, state: FileStatus): Note {
		const base = { path, params, text, body: bodyOf(text), state };
		let read: Record<string, unknown> | null;
		if (fields !== undefined && fields !== null) read = JSON.parse(fields) as Record<string, unknown>;
		else {
			const parsed = parseMarkdown(text);
			if (parsed.error !== null) return { ...base, valid: false, fields: {}, issues: [parsed.error.message] } as Note;
			read = parsed.data.fields;
		}
		const issues = schemaIssues(lens.schema, read);
		return (issues.length === 0 ? { ...base, valid: true, fields: read } : { ...base, valid: false, fields: read, issues }) as Note;
	}

	const editors = createEditors({
		session: () => (status.status === 'open' ? session : null),
		status: () => status,
		revision: () => revision,
		stored: (path) => (claims(path).some(({ lens }) => lens.memory) ? (stored.get(path)?.text ?? null) : undefined),
		row: (path) => (session === null ? Promise.reject(new Error('No session is open')) : session.row(path)),
		// Paths equal after NFC and case folding are one path: a write to any spelling of it counts.
		answered: async (path) => {
			const writes = [...pending].filter(([other]) => fold(other) === fold(path)).flatMap(([, each]) => each);
			await Promise.all(writes.map((write) => write.done));
		},
		spelled: (path) => spelled(path),
		send: (changes) => send(changes),
		refresh: (path) => {
			refresh(path);
			emit();
		},
	});

	/**
	 * Show `path` as stored, with each write not yet answered and the
	 * editor's unsent typing applied over it as the worker will apply them,
	 * so a field set a moment ago still shows while the body is typed.
	 */
	function refresh(path: string) {
		const kept = claims(path).filter(({ lens }) => lens.memory);
		if (kept.length === 0) return;
		const row = stored.get(path);
		let text = row?.text ?? null;
		const writes = pending.get(path) ?? [];
		for (const { change } of writes) text = project(text, change);
		text = editors.draftOver(path, text);
		// Held wins: typing an editor is not saving now, or text the replica holds back, is never shown as on its way.
		const stuck = editors.stuck(path);
		const state: FileStatus =
			stuck !== null ? { status: 'held', reason: stuck } : row?.state.status === 'held' ? row.state : writes.length > 0 || editors.unsaved(path) || row === undefined ? SENDING : row.state;
		for (const { lens, params } of kept) {
			const notes = notesOf.get(lens.name);
			if (notes === undefined) continue;
			const before = notes.get(path);
			if (text === null) {
				if (before === undefined) continue;
				notes.delete(path);
				lists.delete(lens.name);
			} else {
				if (before !== undefined && before.text === text && sameState(before.state, state)) continue;
				// Typing in the body leaves the frontmatter as it was: its fields are read again only when it changes.
				const note =
					before !== undefined && headerOf(before.text) === headerOf(text)
						? ({ ...before, text, body: bodyOf(text), state } as Note)
						: toNote(lens, path, params, text, row?.text === text ? row.fields : undefined, state);
				notes.set(path, note);
				const list = lists.get(lens.name);
				const at = before === undefined || list === undefined ? -1 : indexOf(list, path);
				if (list !== undefined && at >= 0) lists.set(lens.name, list.with(at, note));
				else lists.delete(lens.name);
			}
			touched.add(lens.name);
		}
	}

	/** Every collection a changed path belongs to is told, kept in memory or not. */
	function heard(paths: string[]) {
		if (paths.length > 0) filesChanged = true;
		for (const path of paths) for (const { lens } of claims(path)) touched.add(lens.name);
	}

	function applyDelta(delta: Delta) {
		if (delta.revision <= revision) return;
		revision = delta.revision;
		if (delta.token !== undefined) storedWith(delta.token);
		for (const [path, row] of Object.entries(delta.rows)) {
			store(path, row);
			refresh(path);
		}
		heard(delta.paths);
		editors.heard(delta);
	}

	/** A new session: its snapshot replaces what is stored, keeping every note that did not change, then the changes heard since. */
	async function hydrate(next: Session) {
		const early: Delta[] = [];
		let hydrated = false;
		stopWatching?.();
		stopWatching = next.watch((delta) => {
			if (session !== next) return;
			if (!hydrated) early.push(delta);
			else {
				applyDelta(delta);
				emit();
			}
		});
		let snapshot: Snapshot;
		try {
			snapshot = await next.snapshot();
		} catch {
			// The session ended before its snapshot came: the host says what next.
			return;
		}
		if (session !== next) return;
		const previous = stored;
		stored = new Map(snapshot.rows.map((row) => [row.path, row]));
		spellings = new Map(snapshot.rows.map((row) => [fold(row.path), row.path]));
		revision = snapshot.revision;
		for (const path of new Set([...previous.keys(), ...stored.keys()])) refresh(path);
		hydrated = true;
		for (const delta of early) if (delta.revision > snapshot.revision) applyDelta(delta);
		// Every collection may have changed while no session was open.
		for (const lens of lenses) touched.add(lens.name);
		filesChanged = true;
		setStatus({ status: 'open' });
		emit();
		editors.reopened();
	}

	const stopHost = host.subscribe((state) => {
		if (status.status === 'closed') return;
		if (state.status === 'open') {
			if (session === state.session) return;
			session = state.session;
			void hydrate(state.session);
			return;
		}
		session = null;
		stopWatching?.();
		stopWatching = null;
		setStatus(state);
		editors.lost();
		emit();
	});

	/**
	 * Store `changes` through `ask` (the session's change, or its put with
	 * blobs): shown at once over the notes kept in memory, cleared when
	 * answered, dropped when they fail.
	 */
	async function saveVia<T, E>(changes: Change[], ask: (current: Session, token: number) => Promise<Result<T, E>>): Promise<Result<T, E | RepositoryError | SaveError>> {
		const current = status.status === 'open' ? session : null;
		if (current === null) return RepositoryError.Unavailable({ status: status.status });
		// A note deleted here takes its editor with it: one owner of the path, so no draft keeps it listed or brings it back.
		for (const change of changes) if (change.kind === 'delete' || (change.kind === 'write' && change.text === null)) editors.deleted(change.path);
		let finish = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const token = nextToken++;
		const sent = changes.map((change) => ({ id: nextId++, token, change, done }));
		for (const write of sent) pending.set(write.change.path, [...(pending.get(write.change.path) ?? []), write]);
		for (const write of sent) refresh(write.change.path);
		emit();
		let result: Result<T, E | SaveError>;
		try {
			result = await ask(current, token);
		} catch {
			result = SaveErrors.Closed();
		}
		for (const write of sent) {
			const left = (pending.get(write.change.path) ?? []).filter((other) => other.id !== write.id);
			if (left.length === 0) pending.delete(write.change.path);
			else pending.set(write.change.path, left);
		}
		for (const write of sent) refresh(write.change.path);
		emit();
		finish();
		return result;
	}

	/** Send changes, in one transaction and one save. */
	const send = (changes: Change[]): Promise<Result<Changed, WriteError>> => saveVia(changes, (current, token) => current.change(changes, token));
	/** Seal each blob, then send its pointer with `changes`, in one transaction. */
	const put = (blobs: BlobPut[], changes: Change[] = []): Promise<Result<Put, BlobWriteError>> => saveVia(changes, (current, token) => current.put(blobs, changes, token));

	const one = async (path: string, change: Change): Promise<Result<Written, WriteError>> => {
		const result = await send([change]);
		if (result.error !== null) return result;
		return Ok({ text: result.data.texts[path] ?? null, revision: result.data.revision });
	};

	/** The changes one collection's verbs make, for a path built from its parameters. */
	function changesOf(lens: NoteLens) {
		/** The path the parameters name, as this device spells it. */
		const pathOf = (params: Record<string, unknown>): Result<string, TemplateError> => {
			const built = buildPath(lens.template, params);
			return built.error === null ? Ok(spelled(built.data)) : built;
		};
		return {
			pathOf,
			create: (path: string, input: NoteInput<TSchema> = {}): Change => ({ kind: 'create', path, text: writeMarkdown(null, input as { fields?: Record<string, unknown>; body?: string }).data ?? input.body ?? '' }),
			patch: (path: string, fields: Record<string, unknown>): Change => ({ kind: 'patch', path, fields }),
			delete: (path: string): Change => ({ kind: 'delete', path }),
			write: (path: string, text: string | null, { over }: { over?: string | null } = {}): Change => (over === undefined ? { kind: 'write', path, text } : { kind: 'write', path, text, over }),
		};
	}

	function collection(lens: NoteLens) {
		const changes = changesOf(lens);
		const at =
			<TArgs extends unknown[]>(make: (path: string, ...args: TArgs) => Change) =>
			async (params: Record<string, unknown>, ...args: TArgs): Promise<Result<Written, WriteError>> => {
				const path = changes.pathOf(params);
				if (path.error !== null) return path;
				return one(path.data, make(path.data, ...args));
			};
		const writes = {
			create: at(changes.create),
			patch: at(changes.patch),
			delete: at(changes.delete),
			write: at(changes.write),
			async openEditor(params: Record<string, unknown>): Promise<Result<Editor, WriteError | EditorError>> {
				const path = changes.pathOf(params);
				if (path.error !== null) return path;
				return editors.open(path.data);
			},
		};
		if (!lens.memory)
			return {
				...writes,
				async read(params: Record<string, unknown>): Promise<Result<Note | null, RepositoryError | TemplateError>> {
					const path = changes.pathOf(params);
					if (path.error !== null) return path;
					const current = status.status === 'open' ? session : null;
					if (current === null) return RepositoryError.Unavailable({ status: status.status });
					let row: Row | null;
					try {
						row = await current.row(path.data);
					} catch {
						return RepositoryError.Unavailable({ status: status.status === 'open' ? 'opening' : status.status });
					}
					// Found by any spelling of its path, it reads under the spelling this device has.
					return Ok(row === null ? null : toNote(lens, row.path, claims(row.path).find((claim) => claim.lens === lens)?.params ?? (params as Record<string, string>), row.text, row.fields, row.state));
				},
			};
		const notes = notesOf.get(lens.name) ?? new Map<string, Note>();
		return {
			...writes,
			all() {
				let list = lists.get(lens.name);
				if (list === undefined) {
					list = [...notes.values()].sort(byPath);
					lists.set(lens.name, list);
				}
				return list;
			},
			get(params: Record<string, unknown>) {
				const path = changes.pathOf(params);
				return path.error === null ? notes.get(path.data) : undefined;
			},
		};
	}

	/** Seal `blob` and store a pointer to it at `path`, through the open session. */
	async function putBlob(path: string, blob: Blob, replace: boolean): Promise<Result<BlobWritten, BlobWriteError>> {
		const at = spelled(path);
		const result = await put([{ path: at, blob, replace }]);
		if (result.error !== null) return result;
		const sealed = result.data.sealed[at] as Sealed;
		return Ok({ text: result.data.texts[at] ?? null, revision: result.data.revision, oid: sealed.oid, size: sealed.size });
	}
	async function openBlob(path: string): Promise<Result<File, OpenBlobError>> {
		const opened = await asked((current) => current.open(spelled(path)));
		return opened.error !== null ? opened : opened.data;
	}

	function blobCollection(lens: BlobLens): BlobCollection<string> {
		const pathOf = (params: Record<string, unknown>): Result<string, TemplateError> => {
			const built = buildPath(lens.template, params);
			return built.error === null ? Ok(spelled(built.data)) : built;
		};
		const at =
			<TArgs extends unknown[], TResult>(run: (path: string, ...args: TArgs) => Promise<Result<TResult, BlobWriteError | OpenBlobError | WriteError>>) =>
			async (params: Record<string, unknown>, ...args: TArgs) => {
				const path = pathOf(params);
				return path.error !== null ? path : run(path.data, ...args);
			};
		return {
			create: at((path, blob: Blob) => putBlob(path, blob, false)),
			replace: at((path, blob: Blob) => putBlob(path, blob, true)),
			delete: at((path) => one(path, { kind: 'delete', path })),
			open: at(openBlob),
		} as BlobCollection<string>;
	}

	/** The changes the plain file API makes, at `path` as this device spells it. */
	/** RULE: a file that is not a note holds bytes: text there is the pointer to them (a blob moved by writing its pointer), or it is refused at once, never stored to be held. */
	const notPointer = (path: string, text: string | null) => (text === null || isNote(path) || parsePointer(text) !== null ? null : BlobError.NotPointer({ path }));
	const fileChanges = {
		create: (path: string, text: string): Change => ({ kind: 'create', path: spelled(path), text }),
		write: (path: string, text: string | null, { over }: { over?: string | null } = {}): Change =>
			over === undefined ? { kind: 'write', path: spelled(path), text } : { kind: 'write', path: spelled(path), text, over },
		delete: (path: string): Change => ({ kind: 'delete', path: spelled(path) }),
	};
	/** Ask the open session, or say why there is none. */
	async function asked<T>(ask: (session: Session) => Promise<T>): Promise<Result<T, RepositoryError>> {
		const current = status.status === 'open' ? session : null;
		if (current === null) return RepositoryError.Unavailable({ status: status.status });
		try {
			return Ok(await ask(current));
		} catch {
			return RepositoryError.Unavailable({ status: status.status === 'open' ? 'opening' : status.status });
		}
	}
	const files: Files = {
		list: () => asked((current) => current.files()),
		waiting: () => asked((current) => current.waiting()),
		read: (path) => asked(async (current) => {
			const row = await current.row(path);
			return row === null ? null : { path: row.path, text: row.text, state: row.state };
		}),
		create: ((path: string, content: string | Blob) => {
			if (content instanceof Blob) return putBlob(path, content, false);
			const refused = notPointer(path, content);
			if (refused !== null) return Promise.resolve(refused);
			const change = fileChanges.create(path, content);
			return one(change.path, change);
		}) as Files['create'],
		replace: (path, blob) => putBlob(path, blob, true),
		open: openBlob,
		write: (path, text, options) => {
			const refused = notPointer(path, text);
			if (refused !== null) return Promise.resolve(refused);
			const change = fileChanges.write(path, text, options);
			return one(change.path, change);
		},
		delete: (path) => {
			const change = fileChanges.delete(path);
			return one(change.path, change);
		},
		openEditor: (path) => editors.open(spelled(path)),
	};

	const repository: Record<string, unknown> = {
		files,
		status: () => status,
		revision: () => revision,
		subscribe(listener: (change: RepositoryChange) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		query: <TRow>(sql: string, params?: SqlValue[]): Promise<Result<TRow[], RepositoryError>> => asked((current) => current.query<TRow>(sql, params)),
		commit(build: (batch: Record<string, unknown>) => void): Promise<Result<Committed, BlobWriteError>> {
			const batch: Change[] = [];
			const blobs: BlobPut[] = [];
			const handles: Record<string, unknown> = {};
			let invalid: TemplateError | BlobError | null = null;
			for (const lens of lenses) {
				const changes = changesOf(lens);
				const add =
					<TArgs extends unknown[]>(make: (path: string, ...args: TArgs) => Change) =>
					(params: Record<string, unknown>, ...args: TArgs) => {
						const path = changes.pathOf(params);
						if (path.error !== null) invalid ??= path.error;
						else batch.push(make(path.data, ...args));
					};
				handles[lens.name] = { create: add(changes.create), patch: add(changes.patch), delete: add(changes.delete), write: add(changes.write) };
			}
			for (const lens of app.lenses) {
				if (lens.kind !== 'blob') continue;
				const add =
					<TArgs extends unknown[]>(make: (path: string, ...args: TArgs) => void) =>
					(params: Record<string, unknown>, ...args: TArgs) => {
						const path = buildPath(lens.template, params);
						if (path.error !== null) invalid ??= path.error;
						else make(spelled(path.data), ...args);
					};
				handles[lens.name] = {
					create: add((path, blob: Blob) => blobs.push({ path, blob, replace: false })),
					replace: add((path, blob: Blob) => blobs.push({ path, blob, replace: true })),
					delete: add((path) => batch.push({ kind: 'delete', path })),
				};
			}
			handles.files = {
				create: (path: string, content: string | Blob) => {
					if (content instanceof Blob) return void blobs.push({ path: spelled(path), blob: content, replace: false });
					invalid ??= notPointer(path, content)?.error ?? null;
					batch.push(fileChanges.create(path, content));
				},
				replace: (path: string, blob: Blob) => blobs.push({ path: spelled(path), blob, replace: true }),
				write: (path: string, text: string | null, options?: { over?: string | null }) => {
					invalid ??= notPointer(path, text)?.error ?? null;
					batch.push(fileChanges.write(path, text, options));
				},
				delete: (path: string) => batch.push(fileChanges.delete(path)),
			} satisfies Record<keyof BatchFiles, unknown>;
			build(handles);
			if (invalid !== null) return Promise.resolve({ data: null, error: invalid });
			const saved = blobs.length === 0 ? send(batch) : put(blobs, batch);
			return saved.then((result): Result<Committed, BlobWriteError> => (result.error === null ? Ok({ revision: result.data.revision }) : result));
		},
		close(): Unsaved[] {
			if (status.status === 'closed') return [];
			const unsaved = editors.closeAll();
			setStatus({ status: 'closed' });
			session = null;
			stopWatching?.();
			stopHost();
			host.close();
			emit();
			listeners.clear();
			return unsaved;
		},
	};
	for (const lens of lenses) repository[lens.name] = collection(lens);
	for (const lens of app.lenses) if (lens.kind === 'blob') repository[lens.name] = blobCollection(lens);
	return repository as Repository<TDefs>;
}
