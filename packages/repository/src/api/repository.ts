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
import { bodyOf, parseMarkdown, withBody, writeMarkdown } from '../core/markdown.js';
import { buildPath, type Params, type TemplateError } from '../core/templates.js';
import type { SqlValue } from '../sql.js';

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

/** A note as a page reads it. Fields that do not fit the schema are as written, with issues. */
export type Note<TPath extends string = string, TNoteSchema extends TSchema = TSchema> = {
	path: string;
	params: Params<TPath>;
	/** The exact text. */
	text: string;
	body: string;
	state: FileStatus;
} & ({ valid: true; fields: Static<TNoteSchema> } | { valid: false; fields: Record<string, unknown>; issues: string[] });

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
	commit(build: (batch: { [K in NoteName<TDefs>]: BatchCollection<TDefs[K]> }) => void): Promise<Result<Changed, WriteError>>;
	/** Stop: every open editor reports what it has not saved, and the host lets the replica go. */
	close(): void;
};

// ============================================================================
// The repository
// ============================================================================

type NoteLens = Extract<Lens, { kind: 'note' }>;
const SENDING: FileStatus = { status: 'sending' };
const sameState = (a: FileStatus, b: FileStatus) => a.status === b.status && a.reason === b.reason;

/** A change as it shows before its answer: over a note's text, what the page shows. */
function project(text: string | null, change: Change): string | null {
	switch (change.kind) {
		case 'create':
		case 'write':
			return change.text;
		case 'delete':
			return null;
		case 'patch':
			return text === null ? null : (writeMarkdown(text, { fields: change.fields }).data ?? text);
		case 'edit-body':
			return text === null ? null : withBody(text, change.to);
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
	/** Writes sent and not yet answered, by path, in the order sent: shown over the stored note. */
	const pending = new Map<string, { id: number; change: Change }[]>();
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

	/** Show `path` as stored, its pending writes and its editor's draft over it; true when what shows changed. */
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
		const before = notes.get(path);
		if (text === null) {
			if (before === undefined) return;
			notes.delete(path);
		} else {
			const state = writes.length > 0 || row === undefined ? SENDING : row.state;
			if (before !== undefined && before.text === text && sameState(before.state, state)) return;
			notes.set(path, toNote(lens, path, params, text, row?.text === text ? row.fields : undefined, state));
		}
		lists.delete(lens.name);
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
			if (row === null) stored.delete(path);
			else stored.set(path, row);
			refresh(path);
		}
		heard(delta.paths);
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
		revision = snapshot.revision;
		for (const path of new Set([...previous.keys(), ...stored.keys()])) refresh(path);
		hydrated = true;
		for (const delta of early) if (delta.revision > snapshot.revision) applyDelta(delta);
		// Every collection may have changed while no session was open.
		for (const lens of lenses) touched.add(lens.name);
		setStatus({ status: 'open' });
		emit();
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
		emit();
	});

	/** Send changes: shown at once over the notes kept in memory, cleared when answered, dropped when they fail. */
	async function send(changes: Change[]): Promise<Result<Changed, WriteError>> {
		const current = status.status === 'open' ? session : null;
		if (current === null) return RepositoryError.Unavailable({ status: status.status });
		const sent = changes.map((change) => ({ id: nextId++, change }));
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
		return result;
	}

	const one = async (path: string, change: Change): Promise<Result<Written, WriteError>> => {
		const result = await send([change]);
		if (result.error !== null) return result;
		return Ok({ text: result.data.texts[path] ?? null, revision: result.data.revision });
	};

	/** The changes one collection's verbs make, for a path built from its parameters. */
	function changesOf(lens: NoteLens) {
		const pathOf = (params: Record<string, unknown>) => buildPath(lens.template, params);
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
					return Ok(row === null ? null : toNote(lens, path.data, params as Record<string, string>, row.text, row.fields, row.state));
				},
			};
		const notes = notesOf.get(lens.name) ?? new Map<string, Note>();
		return {
			...writes,
			all() {
				let list = lists.get(lens.name);
				if (list === undefined) {
					list = [...notes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
			return send(batch);
		},
		close() {
			if (status.status === 'closed') return;
			setStatus({ status: 'closed' });
			session = null;
			stopWatching?.();
			stopHost();
			host.close();
			emit();
			listeners.clear();
		},
	};
	for (const lens of lenses) repository[lens.name] = collection(lens);
	return repository as Repository<TDefs>;
}
