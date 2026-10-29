/**
 * The editor of one note: the one owner of what a person types into it,
 * shared by every view of the note (opened once per view, closed once per
 * view). It holds the draft and its base, the last text the worker
 * confirmed that the draft was made over.
 *
 * - One write is in flight at a time; keystrokes made meanwhile change only
 *   the draft, and go together in the next write.
 * - Each write is the exact text over its base (`write(text, { over })`),
 *   so the worker merges whatever reached it meanwhile, once: a field set
 *   elsewhere merges by key, and a delete made elsewhere loses to the edit.
 * - The worker answers with its resulting text. Where that differs from
 *   what was sent, the typing since is carried onto it by position, never
 *   merged again, so a conflict block the merge wrote is not written twice.
 *   Where typing and the worker's change touch the same characters,
 *   autosave pauses with both kept (`paused`: the draft is yours, `theirs`
 *   is the worker's), until `resolve`.
 * - A clean editor follows changes from elsewhere in place, in revision
 *   order. A dirty one keeps its draft and lets its next write merge them:
 *   typing the worker has not seen is carried by position only onto a text
 *   the worker made of it, since positions alone would blend the letters
 *   two people typed at one point. The worker merges it once, and where its
 *   base had a conflict block the write continues that block (one clash is
 *   one block, `core/merge`).
 * - A failed write keeps the draft and its base (`failed`, with `retry`);
 *   nothing the repository rolls back reaches the draft. A write lost with
 *   its session goes again when the next session opens.
 * - `close` flushes. What it cannot save it reports, and the draft stays
 *   (shown in lists, and saved when a session allows) until `discard`.
 *
 * One editor per path, over the exact text: a view of the body is a view of
 * the same draft (`bodyOf`, `withBody`), so a note's body and source views
 * share it and can switch freely.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Delta, Row } from '../client/page.js';
import { type Change, type Changed, ChangeError, REQUEST_TIMEOUT } from '../client/replica.js';
import { applyChanges, composeChanges, diffText, rebase, type TextChange } from '../core/diff.js';
import { type Parties, settle } from '../core/settle.js';
import type { RepositoryStatus, Session, WriteError } from './repository.js';

export type EditorState =
	/** Everything typed is stored. */
	| { status: 'saved' }
	/** Typing is being saved, or waits for a session to save it. */
	| { status: 'saving' }
	/** Typing touches what the worker changed in the same place: autosave waits for `resolve`. The draft is yours; `theirs` is the worker's. */
	| { status: 'paused'; theirs: string }
	/** The last write failed; the draft is kept. `retry` sends it again. */
	| { status: 'failed'; error: WriteError }
	/** The repository closed: the draft is kept for reading, and nothing more is saved. */
	| { status: 'closed' };

export const EditorError = defineErrors({
	/** The repository is not open (or its session ended while the editor opened), so the note cannot be edited now; it opens once the repository is open again. */
	Unavailable: ({ path, status }: { path: string; status: Exclude<RepositoryStatus['status'], 'open'> }) => ({ message: `${path} cannot be edited while the repository is ${status}`, path, status }),
	/** A write to the note was sent and not answered within the replica's timeout, so no editor opened over it; the write still goes, and nothing was lost. */
	Unanswered: ({ path }: { path: string }) => ({ message: `${path} has a change that has not been saved yet, so it cannot be edited now; try again`, path }),
	/** The editor was closed with typing it could not save: `draft` holds it, and the editor keeps it until discarded. */
	Unsaved: ({ path, draft, reason }: { path: string; draft: string; reason: string }) => ({ message: `${path} has typing that is not saved: ${reason}`, path, draft, reason }),
});
export type EditorError = InferErrors<typeof EditorError>;
/** Why a close could not save: the only way it fails. */
export type UnsavedError = Extract<EditorError, { name: 'Unsaved' }>;

/** A draft an editor held unsaved when its repository closed. */
export type Unsaved = { path: string; draft: string };

/**
 * What a view is told. `replaced`: the draft was replaced from outside (a
 * rebase, a change followed). `typed`: the person typed, in this view or
 * another. Either holds the changes that turn the draft before into the
 * draft now; a view applies those it did not make itself.
 */
export type EditorChange = { replaced: TextChange[] | null; typed: TextChange[] | null };

export type Editor = {
	path: string;
	/** The note's exact text as the person has it. A view of the body shows `bodyOf(draft)` and types through `withBody(draft, body)`. */
	draft(): string;
	state(): EditorState;
	/** The person typed: `draft` is the new text, and `changes` (a view's own change set, when it has one) turn the draft before into it. */
	update(draft: string, changes?: TextChange[]): void;
	/** Be told when the draft or the state changes (`replaced`: the draft was replaced from outside); returns the function that stops it. */
	subscribe(listener: (change: EditorChange) => void): () => void;
	/** Send the draft again after a failure. */
	retry(): void;
	/** Settle a paused editor with the text the person made of both: it is saved over `theirs`. */
	resolve(text: string): void;
	/** This view is done: once the last view closes, the draft is saved, or why it was not is reported. */
	close(): Promise<Result<undefined, UnsavedError>>;
	/** Drop the draft, unsaved or not. */
	discard(): void;
};

/** What the editors need of their repository. */
type Deps = {
	session(): Session | null;
	status(): RepositoryStatus;
	revision(): number;
	/** A kept note's text as the worker last said, or undefined when the path is not kept in memory. */
	stored(path: string): string | null | undefined;
	row(path: string): Promise<Row | null>;
	/** Settles once every write to any spelling of `path` sent so far is answered. */
	answered(path: string): Promise<void>;
	/** `path` as this device spells it, when a note kept in memory is stored under another spelling of it. */
	spelled(path: string): string;
	send(changes: Change[]): Promise<Result<Changed, WriteError>>;
	/** Show `path` again: its draft changed. */
	refresh(path: string): void;
};

type Entry = Editor & {
	views: number;
	dirty(): boolean;
	/** The text the unsent typing was made over: the write in flight's, or the base. */
	typedOver(): string;
	heard(revision: number, text: string | null): void;
	reopened(text: string | null): void;
	lost(): void;
	end(options?: { dropped?: boolean }): void;
};

/** Who wrote each side of a conflict block shown before its answer: the worker labels the one it writes. */
const SHOWN: Parties = { current: { author: 'elsewhere', time: '-' }, incoming: { author: 'you', time: '-' } };

/** `text`, made over `over`, as the worker will apply it over `current`: merged where `current` moved since. */
export const mergedOver = (over: string | null, current: string | null, text: string | null) => settle(over, current, text, { parties: SHOWN }).text;

/** Why an editor did not open: a session that ended mid-open reads as opening again. */
const notOpen = (status: RepositoryStatus['status']) => (status === 'open' ? 'opening' : status);

/** Whether `promise` settles within `ms`. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	return Promise.race([promise.then(() => true as const), late]).finally(() => clearTimeout(timer));
}

/** A write lost with its session goes again in the next one. */
const lostWithSession = (error: WriteError) => error.name === 'Closed' || error.name === 'Unavailable';

/** The editors of one repository, by path. */
export function createEditors(deps: Deps) {
	const editors = new Map<string, Entry>();
	const unavailable = (path: string) => EditorError.Unavailable({ path, status: notOpen(deps.status().status) });
	const opening = new Map<string, Promise<Result<Entry | { spelled: string }, WriteError | EditorError>>>();

	function make(path: string, text: string, revision: number): Entry {
		let base = text;
		let draft = base;
		let seen = revision;
		let flight: { sent: string } | null = null;
		/** The typing since the text it was made over (the write in flight's, or the base), as the views made it; null when a view did not say, and a diff finds it. */
		let typing: TextChange[] | null = [];
		let state: EditorState = { status: 'saved' };
		let queued = false;
		/** Changes from elsewhere heard while a write was in flight, applied in order after its answer. */
		let heardInFlight: { revision: number; text: string | null }[] = [];
		const listeners = new Set<(change: EditorChange) => void>();
		const closers: ((result: Result<undefined, UnsavedError>) => void)[] = [];
		let ended = false;

		const tell = (replaced: TextChange[] | null, typed: TextChange[] | null = null) => {
			for (const listener of listeners) listener({ replaced, typed });
		};
		const setState = (next: EditorState) => {
			state = next;
		};
		const dirty = () => draft !== base || flight !== null;

		/**
		 * With no view left: once nothing is unsaved, the editor leaves its
		 * repository (a close that reported unsaved typing included, once that
		 * typing is saved later); until then, the views waiting to close are
		 * answered once the draft cannot be saved now.
		 */
		function settleClosing() {
			if (entry.views > 0) return;
			if (!dirty()) {
				if (editors.get(path) === entry) editors.delete(path);
				setState({ status: 'saved' });
				deps.refresh(path);
				for (const close of closers.splice(0)) close(Ok(undefined));
				return;
			}
			if (closers.length === 0) return;
			const reason =
				state.status === 'failed'
					? state.error.message
					: state.status === 'paused'
						? 'it touches a change made elsewhere in the same place'
						: state.status === 'closed'
							? 'the repository closed'
							: deps.session() === null
								? `the repository is ${deps.status().status}`
								: null;
			if (reason === null) return;
			for (const close of closers.splice(0)) close(EditorError.Unsaved({ path, draft, reason }));
		}

		function schedule() {
			if (queued) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				void flush();
			});
		}

		async function flush() {
			if (ended || flight !== null || state.status === 'paused' || state.status === 'failed' || state.status === 'closed') return settleClosing();
			if (draft === base) {
				setState({ status: 'saved' });
				tell(null);
				return settleClosing();
			}
			if (deps.session() === null) {
				setState({ status: 'saving' });
				tell(null);
				return settleClosing();
			}
			const sent = draft;
			flight = { sent };
			typing = [];
			setState({ status: 'saving' });
			tell(null);
			answered(sent, await deps.send([{ kind: 'write', path, text: sent, over: base }]));
		}

		function answered(sent: string, result: Result<Changed, WriteError>) {
			flight = null;
			const later = heardInFlight;
			heardInFlight = [];
			if (ended) return;
			const text = result.error === null ? result.data.texts[path] : undefined;
			if (result.error !== null || text === undefined || text === null) {
				// The draft and its base stay: nothing the repository rolls back reaches them.
				typing = null;
				setState({ status: 'failed', error: result.error ?? ChangeError.NotFound({ path }).error });
				deps.refresh(path);
				tell(null);
				return settleClosing();
			}
			seen = Math.max(seen, result.data.revision);
			carry(sent, text);
			for (const { revision, text: heardText } of later) take(revision, heardText);
			deps.refresh(path);
			if (state.status === 'paused') {
				tell(null);
				return settleClosing();
			}
			if (draft !== base) return void flush();
			setState({ status: 'saved' });
			tell(null);
			settleClosing();
		}

		/**
		 * The worker confirmed `next`, made of `over` (what was sent, or the
		 * base): the typing over `over` is carried onto it by position, and
		 * `next` becomes the base, so the next write goes over a text the
		 * worker holds and a block its merge wrote is not written again. Where
		 * the typing touches what changed, autosave pauses with both kept.
		 */
		function carry(over: string, next: string) {
			if (next === over) {
				base = next;
				return;
			}
			const carried = rebase(over, draft, next, typing ?? undefined);
			base = next;
			typing = carried?.typed ?? null;
			if (carried === null) {
				setState({ status: 'paused', theirs: next });
				return;
			}
			if (state.status === 'paused') setState({ status: 'paused', theirs: next });
			if (carried.text === draft) return;
			draft = carried.text;
			tell(carried.changes);
		}

		/**
		 * Take a change from elsewhere, in revision order. A clean editor is
		 * carried onto it in place. Typing the worker has not seen is never
		 * carried onto a change the worker did not make of it, since positions
		 * alone would blend letters two people typed at one point: that typing
		 * goes to the worker over the base it was typed on, the worker merges
		 * the two once (one clash, one block), and the answer brings both.
		 */
		function take(revision: number, text: string | null) {
			if (revision <= seen) return;
			seen = revision;
			// A delete is no text to carry onto: the draft and its base stay, and a write over that base brings the note back.
			if (text === null || draft !== base) return;
			carry(base, text);
		}

		/** A change from elsewhere, taken after the answer to a write in flight. */
		function heard(revision: number, text: string | null) {
			if (ended || revision <= seen) return;
			if (flight !== null) {
				heardInFlight.push({ revision, text });
				return;
			}
			const before = draft;
			take(revision, text);
			if (draft !== before) deps.refresh(path);
		}

		const entry: Entry = {
			path,
			views: 1,
			draft: () => draft,
			state: () => state,
			update(next, changes) {
				if (ended || next === draft) return;
				const given = changes !== undefined && applyChanges(draft, changes) === next;
				const typed = given ? changes : diffText(draft, next);
				typing = given && typing !== null ? composeChanges(typing, typed, (flight?.sent ?? base).length) : null;
				draft = next;
				if (state.status === 'saved') setState({ status: 'saving' });
				deps.refresh(path);
				tell(null, typed);
				schedule();
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			retry() {
				if (ended || state.status !== 'failed') return;
				setState({ status: 'saving' });
				tell(null);
				schedule();
			},
			resolve(text) {
				if (ended || state.status !== 'paused') return;
				const replaced = diffText(draft, text);
				draft = text;
				typing = null;
				setState({ status: 'saving' });
				deps.refresh(path);
				tell(replaced);
				schedule();
			},
			close() {
				if (entry.views > 0) entry.views--;
				if (entry.views > 0) return Promise.resolve(Ok(undefined));
				const closed = new Promise<Result<undefined, UnsavedError>>((resolve) => closers.push(resolve));
				if (flight === null) void flush();
				else settleClosing();
				return closed;
			},
			discard() {
				entry.end({ dropped: true });
				if (editors.get(path) === entry) editors.delete(path);
				deps.refresh(path);
			},
			dirty,
			typedOver: () => flight?.sent ?? base,
			heard,
			/** A new session: a clean editor follows the note as it is there; a dirty one, or one whose write was lost with the last session, saves again. */
			reopened(text) {
				if (ended) return;
				if (state.status === 'failed' && lostWithSession(state.error)) setState({ status: 'saving' });
				// The last write's outcome may be unknown, so a dirty editor saves over its base and the worker merges it once.
				seen = deps.revision();
				if (draft !== base || state.status !== 'saved') return schedule();
				if (text !== null) carry(base, text);
				deps.refresh(path);
				settleClosing();
			},
			lost() {
				if (!ended) settleClosing();
			},
			/** Stop for good. `dropped`: the person let the draft go (a discard, or a delete made here), so nothing is reported unsaved. */
			end({ dropped = false }: { dropped?: boolean } = {}) {
				if (ended) return;
				ended = true;
				if (dropped) {
					draft = base;
					flight = null;
				}
				const unsaved = draft !== (flight?.sent ?? base);
				setState({ status: 'closed' });
				tell(null);
				for (const close of closers.splice(0)) close(unsaved ? EditorError.Unsaved({ path, draft, reason: 'the repository closed' }) : Ok(undefined));
			},
		};
		return entry;
	}

	async function open(path: string): Promise<Result<Editor, WriteError | EditorError>> {
		const existing = editors.get(path);
		if (existing !== undefined) {
			existing.views++;
			return Ok(existing);
		}
		const already = opening.get(path);
		if (already !== undefined) {
			const opened = await already;
			if (opened.error !== null) return opened;
			return open(path);
		}
		/** The editor, or the spelling of the path this device has when the note is stored under another one. */
		const starting = (async (): Promise<Result<Entry | { spelled: string }, WriteError | EditorError>> => {
			// A write to this path still unanswered (a create just made) is what the editor opens over, within the replica's bound on an answer.
			if (!(await within(deps.answered(path), REQUEST_TIMEOUT))) return EditorError.Unanswered({ path });
			// What was just stored may keep another spelling of the path (a create over a deleted note's), as the replica does.
			if (deps.spelled(path) !== path) return Ok({ spelled: deps.spelled(path) });
			if (deps.session() === null) return unavailable(path);
			const revision = deps.revision();
			let text = deps.stored(path);
			if (text === undefined) {
				let row: Row | null;
				try {
					row = await deps.row(path);
				} catch {
					return unavailable(path);
				}
				if (row !== null && row.path !== path) return Ok({ spelled: row.path });
				text = row?.text ?? null;
			}
			if (text === null) return ChangeError.NotFound({ path });
			const entry = make(path, text, revision);
			editors.set(path, entry);
			return Ok(entry);
		})();
		opening.set(path, starting);
		const opened = await starting;
		opening.delete(path);
		if (opened.error !== null) return opened;
		// One note, one editor: found under another spelling, it opens under the spelling this device has.
		if ('spelled' in opened.data) return open(opened.data.spelled);
		return Ok(opened.data);
	}

	return {
		open,
		/** What a list shows for `path` over `text`: the typing an editor holds unsent, merged over it as the worker will merge it. */
		draftOver(path: string, text: string | null) {
			const editor = editors.get(path);
			return editor?.dirty() ? mergedOver(editor.typedOver(), text, editor.draft()) : text;
		},
		/** Whether an editor of `path` holds typing not yet stored. */
		unsaved: (path: string) => editors.get(path)?.dirty() ?? false,
		/** Why an editor of `path` holds typing it is not saving now (a failed save, or a pause on a clash), or null. */
		stuck(path: string): string | null {
			const state = editors.get(path)?.state();
			if (state?.status === 'failed') return state.error.message;
			if (state?.status === 'paused') return 'waiting for you to choose between your typing and a change made elsewhere';
			return null;
		},
		/** A stored change, in revision order. */
		heard(delta: Delta) {
			for (const [path, editor] of editors) {
				if (path in delta.rows) editor.heard(delta.revision, delta.rows[path]?.text ?? null);
				else if (delta.paths.includes(path))
					// Not kept in memory: its text is read, at this revision or later.
					void deps.row(path).then(
						(row) => editor.heard(delta.revision, row?.text ?? null),
						() => {},
					);
			}
		},
		/** A new session opened and its snapshot is in. */
		reopened() {
			for (const [path, editor] of editors) {
				const kept = deps.stored(path);
				if (kept !== undefined) editor.reopened(kept);
				else
					void deps.row(path).then(
						(row) => editor.reopened(row?.text ?? null),
						() => {},
					);
			}
		},
		/** The note was deleted here: its editor ends, and its draft goes with it. */
		deleted(path: string) {
			editors.get(path)?.discard();
		},
		/** The session ended. */
		lost() {
			for (const editor of editors.values()) editor.lost();
		},
		/** The repository closed: every editor stops, and the typing no write carried is returned. */
		closeAll(): Unsaved[] {
			// A write already handed to the worker is stored: a session that ends finishes the calls it was sent. Only typing no write carried is unsaved.
			const unsaved = [...editors.values()].filter((editor) => editor.draft() !== editor.typedOver()).map(({ path, draft }) => ({ path, draft: draft() }));
			for (const editor of editors.values()) editor.end();
			return unsaved;
		},
	};
}
