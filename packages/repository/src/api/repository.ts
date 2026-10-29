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
 * transaction each (`commit` for several at once). On a collection kept in
 * memory they show at once: the change is projected over the stored note
 * until its answer, and dropped if it fails. `subscribe` is the one way to
 * hear that anything changed.
 */
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Delta, Row, SaveError, Snapshot } from '../client/page.js';
import { SaveError as SaveErrors } from '../client/page.js';
import type { Change, Changed, ChangeError, FileStatus } from '../client/replica.js';
import { type App, type Definitions, type Lens, type NoteName, schemaIssues } from '../core/lens.js';
import { bodyOf, parseMarkdown, splitMarkdown, writeMarkdown } from '../core/markdown.js';
import { fold } from '../core/door.js';
import { buildPath, type Params, type TemplateError } from '../core/templates.js';
import type { SqlValue } from '../sql.js';
import { createEditors, type Editor, type EditorError, mergedOver, type Unsaved } from './editor.js';

// ============================================================================
// The host: where the replica runs, and its sessions
// ============================================================================

/** What a page asks of one worker session. Every call may reject once the session ends. */
export type Session = {
	snapshot(): Promise<Snapshot>;
	row(path: string): Promise<Row | null>;
	query<TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<TRow[]>;
	change(changes: Change[]): Promise<Result<Changed, ChangeError | SaveError>>;
	/** Hear each stored change in revision order; returns the function that stops it. */
	watch(listener: (delta: Delta) => void): () => void;
};

/** Where the repository stands in this page. `open`: its notes are here and it saves. */
export type RepositoryStatus =
	| { status: 'opening' }
	/** This page owns the replica, but another page's worker has not let go of it yet. */
	| { status: 'waiting'; reason: string }
	| { status: 'open' }
	/** Another tab owns the replica; `useHere` takes it. */
	| { status: 'elsewhere'; useHere(): void }
	/** Another tab took the replica from this one. */
	| { status: 'moved'; useHere(): void }
	| { status: 'unavailable'; reason: string; retry(): void }
	| { status: 'closed' };

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

export const RepositoryError = defineErrors({
	/** The repository cannot save now (it is opening, elsewhere, or closed): nothing was saved. */
	Unavailable: ({ status }: { status: RepositoryStatus['status'] }) => ({ message: `The repository is ${status}, so nothing was saved`, status }),
});
export type RepositoryError = InferErrors<typeof RepositoryError>;

/** Why a write was not stored. */
export type WriteError = RepositoryError | ChangeError | SaveError | TemplateError;

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

/** What changed, for a subscriber: the collections whose notes changed, and whether the status did. */
export type RepositoryChange = { collections: string[]; status: boolean };

export type Repository<TDefs extends Definitions> = { [K in NoteName<TDefs>]: CollectionOf<TDefs[K]> } & {
	status(): RepositoryStatus;
	/** The revision of the last change heard: every SQL result older than it may be stale. */
	revision(): number;
	/** Be told after anything changes; returns the function that stops it. */
	subscribe(listener: (change: RepositoryChange) => void): () => void;
	/** One read-only SQL statement over the app's views. */
	query<TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<Result<TRow[], RepositoryError>>;
	/** Several writes as one transaction and one save. */
	commit(build: (batch: { [K in NoteName<TDefs>]: BatchCollection<TDefs[K]> }) => void): Promise<Result<Committed, WriteError>>;
	/** Stop: every editor stops and the host lets the replica go. Returns the drafts that could not be saved, for the caller to keep or drop (an account change). */
	close(): Unsaved[];
};

// ============================================================================
// The repository
// ============================================================================

type NoteLens = Extract<Lens, { kind: 'note' }>;
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
	/** Writes sent and not yet answered, by path, in the order sent: shown over the stored note. `done` settles once its answer is in. */
	const pending = new Map<string, { id: number; change: Change; done: Promise<void> }[]>();
	let nextId = 1;
	const listeners = new Set<(change: RepositoryChange) => void>();
	const touched = new Set<string>();
	let statusChanged = false;

	function emit() {
		if (touched.size === 0 && !statusChanged) return;
		const change = { collections: [...touched].sort(), status: statusChanged };
		touched.clear();
		statusChanged = false;
		for (const listener of listeners) listener(change);
	}
	const setStatus = (next: RepositoryStatus) => {
		status = next;
		statusChanged = true;
	};

	/** The lens a path belongs to, with its parameters, if it is a note. */
	function classify(path: string): { lens: NoteLens; params: Record<string, string> } | null {
		const found = app.classify(path);
		return found?.lens.kind === 'note' ? { lens: found.lens, params: found.params } : null;
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
		stored: (path) => (classify(path)?.lens.memory === true ? (stored.get(path)?.text ?? null) : undefined),
		row: (path) => (session === null ? Promise.reject(new Error('No session is open')) : session.row(path)),
		answered: async (path) => {
			await Promise.all((pending.get(path) ?? []).map((write) => write.done));
		},
		send: (changes) => send(changes),
		refresh: (path) => {
			refresh(path);
			emit();
		},
		unavailable: () => RepositoryError.Unavailable({ status: status.status }).error,
	});

	/**
	 * Show `path` as stored, with each write not yet answered and the
	 * editor's unsent typing applied over it as the worker will apply them,
	 * so a field set a moment ago still shows while the body is typed.
	 */
	function refresh(path: string) {
		const classified = classify(path);
		if (classified === null || !classified.lens.memory) return;
		const { lens, params } = classified;
		const notes = notesOf.get(lens.name);
		if (notes === undefined) return;
		const row = stored.get(path);
		let text = row?.text ?? null;
		const writes = pending.get(path) ?? [];
		for (const { change } of writes) text = project(text, change);
		text = editors.draftOver(path, text);
		const before = notes.get(path);
		if (text === null) {
			if (before === undefined) return;
			notes.delete(path);
			lists.delete(lens.name);
		} else {
			const state = writes.length > 0 || editors.unsaved(path) || row === undefined ? SENDING : row.state;
			if (before !== undefined && before.text === text && sameState(before.state, state)) return;
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

	/** Every collection a changed path belongs to is told, kept in memory or not. */
	function heard(paths: string[]) {
		for (const path of paths) {
			const classified = classify(path);
			if (classified !== null) touched.add(classified.lens.name);
		}
	}

	function applyDelta(delta: Delta) {
		if (delta.revision <= revision) return;
		revision = delta.revision;
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

	/** Send changes: shown at once over the notes kept in memory, cleared when answered, dropped when they fail. */
	async function send(changes: Change[]): Promise<Result<Changed, WriteError>> {
		const current = status.status === 'open' ? session : null;
		if (current === null) return RepositoryError.Unavailable({ status: status.status });
		// A note deleted here takes its editor with it: one owner of the path, so no draft keeps it listed or brings it back.
		for (const change of changes) if (change.kind === 'delete' || (change.kind === 'write' && change.text === null)) editors.deleted(change.path);
		let finish = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const sent = changes.map((change) => ({ id: nextId++, change, done }));
		for (const write of sent) pending.set(write.change.path, [...(pending.get(write.change.path) ?? []), write]);
		for (const write of sent) refresh(write.change.path);
		emit();
		let result: Result<Changed, WriteError>;
		try {
			result = await current.change(changes);
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
					return Ok(row === null ? null : toNote(lens, row.path, classify(row.path)?.params ?? (params as Record<string, string>), row.text, row.fields, row.state));
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

	const repository: Record<string, unknown> = {
		status: () => status,
		revision: () => revision,
		subscribe(listener: (change: RepositoryChange) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async query<TRow>(sql: string, params?: SqlValue[]): Promise<Result<TRow[], RepositoryError>> {
			const current = status.status === 'open' ? session : null;
			if (current === null) return RepositoryError.Unavailable({ status: status.status });
			try {
				return Ok(await current.query<TRow>(sql, params));
			} catch {
				return RepositoryError.Unavailable({ status: status.status === 'open' ? 'opening' : status.status });
			}
		},
		commit(build: (batch: Record<string, unknown>) => void) {
			const batch: Change[] = [];
			const handles: Record<string, unknown> = {};
			let invalid: TemplateError | null = null;
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
			build(handles);
			if (invalid !== null) return Promise.resolve({ data: null, error: invalid });
			return send(batch).then((result): Result<Committed, WriteError> => (result.error === null ? Ok({ revision: result.data.revision }) : result));
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
	return repository as Repository<TDefs>;
}
