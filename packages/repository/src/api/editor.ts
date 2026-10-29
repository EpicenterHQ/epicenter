/**
 * The editor of one note: what a person types into it, shared by every view
 * of the note (opened once per view, closed once per view). Typing has one
 * home, the worker's database: the editor holds only what the views show.
 *
 * - Every change the person makes is written at once, as the exact text over
 *   the text it was typed on (`write(text, { over })`). The worker applies
 *   writes in the order they are sent and merges each with whatever reached
 *   it meanwhile, once: a field set elsewhere merges by key, a delete made
 *   elsewhere loses to the edit, and a same-line clash is one conflict block
 *   however many keystrokes follow it (`core/settle`: an edit of what a
 *   block offers as a side continues that side). Nothing waits for the
 *   person to choose: a clash is text, resolved by editing it.
 * - While writes are in flight the views keep showing the typing. Once the
 *   last is answered they show what the worker holds, through the changes
 *   from the draft, so the cursor maps through them. A clean editor follows
 *   changes from elsewhere in place, in revision order.
 * - Typing is safe once it reaches the worker. What the page holds that the
 *   worker does not is typing made while no session is open, or after a
 *   failed write (`failed`, with `retry`): it is shown, and written over the
 *   text it was typed on once a session opens or `retry` asks. A write lost
 *   with its session goes again in the next one, over the text the worker
 *   holds when it is one this editor sent, so it is never merged with
 *   itself.
 * - `close` reports what it cannot save, and the draft stays (shown in
 *   lists, and saved when a session allows) until `discard`.
 *
 * One editor per path, over the exact text: a view of the body is a view of
 * the same draft (`bodyOf`, `withBody`), so a note's body and source views
 * share it and can switch freely.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Delta, Row } from '../client/page.js';
import { type Change, type Changed, ChangeError, REQUEST_TIMEOUT } from '../client/replica.js';
import { applyChanges, diffText, type TextChange } from '../core/diff.js';
import { type Parties, settle } from '../core/settle.js';
import type { Session, WriteError } from './repository.js';
import { RepositoryError, type RepositoryStatus } from './status.js';

export type EditorState =
	/** Everything typed is stored. */
	| { status: 'saved' }
	/** Typing is being saved, or waits for a session to save it. */
	| { status: 'saving' }
	/** The last write failed; the draft is kept. `retry` sends it again. */
	| { status: 'failed'; error: WriteError }
	/** The repository closed: the draft is kept for reading, and nothing more is saved. */
	| { status: 'closed' };

export const EditorError = defineErrors({
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
	/** The text the next write goes over: the last one sent, or the base. */
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
	/** The repository is not open (or its session ended while the editor opened): the note opens once it is open again. */
	const unavailable = () => RepositoryError.Unavailable({ status: notOpen(deps.status().status) });
	const opening = new Map<string, Promise<Result<Entry | { spelled: string }, WriteError | EditorError>>>();

	function make(path: string, text: string, revision: number): Entry {
		/** The last text the worker said it holds: an answer, or a change heard while nothing was in flight. */
		let base = text;
		/** What the views show. While a session is open it is the text last sent; only typing made with no session is ahead of that. */
		let draft = base;
		let seen = revision;
		/** The texts sent and not answered yet, in order: each was written over the one before it, the first over `base`. */
		const sent: string[] = [];
		/** Texts sent whose answers were lost with their session: the worker may hold any of them. */
		let unknown: string[] = [];
		let state: EditorState = { status: 'saved' };
		/** Changes heard while writes were in flight, taken once they are answered. */
		let heardInFlight: { revision: number; text: string | null }[] = [];
		const listeners = new Set<(change: EditorChange) => void>();
		const closers: ((result: Result<undefined, UnsavedError>) => void)[] = [];
		let ended = false;

		const tell = (replaced: TextChange[] | null, typed: TextChange[] | null = null) => {
			for (const listener of listeners) listener({ replaced, typed });
		};
		/** The text the next write goes over: the last one sent, or the base. */
		const lastSent = () => sent.at(-1) ?? base;
		const dirty = () => draft !== base || sent.length > 0;

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
				state = { status: 'saved' };
				deps.refresh(path);
				for (const close of closers.splice(0)) close(Ok(undefined));
				return;
			}
			if (closers.length === 0 || sent.length > 0) return;
			const reason =
				state.status === 'failed'
					? state.error.message
					: state.status === 'closed'
						? 'the repository closed'
						: deps.session() === null
							? `the repository is ${deps.status().status}`
							: null;
			if (reason === null) return;
			for (const close of closers.splice(0)) close(EditorError.Unsaved({ path, draft, reason }));
		}

		/** Write the draft over `over`, now: the worker merges it with whatever reached it since. */
		function send(over: string) {
			if (ended || state.status === 'failed' || state.status === 'closed' || draft === over) return;
			state = { status: 'saving' };
			if (deps.session() === null) return;
			const text = draft;
			sent.push(text);
			void deps.send([{ kind: 'write', path, text, over }]).then((result) => answered(text, result));
		}

		function answered(text: string, result: Result<Changed, WriteError>) {
			if (sent[0] === text) sent.shift();
			if (ended) return;
			if (result.error !== null) {
				// A write lost with its session goes again when the next one opens; the worker may hold it already.
				if (lostWithSession(result.error)) unknown.push(text);
				else state = { status: 'failed', error: result.error };
				tell(null);
				deps.refresh(path);
				return settleClosing();
			}
			const stored = result.data.texts[path];
			if (stored === undefined || stored === null) {
				state = { status: 'failed', error: ChangeError.NotFound({ path }).error };
				tell(null);
				deps.refresh(path);
				return settleClosing();
			}
			base = stored;
			seen = Math.max(seen, result.data.revision);
			if (sent.length > 0) return;
			// Nothing in flight: the views show what the worker holds, which every write and every change before them made. After a failure the draft stays, for `retry`.
			if (draft === text && state.status !== 'failed') show(stored);
			for (const { revision, text: heardText } of heardInFlight.splice(0)) take(revision, heardText);
			if (state.status === 'saving' && draft === base) state = { status: 'saved' };
			tell(null);
			deps.refresh(path);
			settleClosing();
		}

		/** Show `next`: the views apply the changes from the draft, so the cursor maps through them. */
		function show(next: string) {
			if (next === draft) return;
			const changes = diffText(draft, next);
			draft = next;
			tell(changes);
		}

		/** A change from elsewhere, in revision order, with nothing in flight: a clean editor follows it; typing made with no session goes over its base, and the worker merges the two. */
		function take(revision: number, text: string | null) {
			if (revision <= seen) return;
			seen = revision;
			// A delete is no text to show: the draft and its base stay, and a write over that base brings the note back.
			if (text === null || draft !== base) return;
			base = text;
			show(text);
		}

		function heard(revision: number, text: string | null) {
			if (ended || revision <= seen) return;
			if (sent.length > 0) {
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
				const over = draft;
				const typed = changes !== undefined && applyChanges(draft, changes) === next ? changes : diffText(draft, next);
				draft = next;
				deps.refresh(path);
				tell(null, typed);
				// Typing made with no session, or after a failed write, waits for a session or a retry, shown.
				if (state.status === 'failed' || deps.session() === null || over !== lastSent()) {
					if (state.status === 'saved') state = { status: 'saving' };
					return;
				}
				send(over);
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			retry() {
				if (ended || state.status !== 'failed') return;
				state = { status: 'saving' };
				tell(null);
				send(lastSent());
			},
			close() {
				if (entry.views > 0) entry.views--;
				if (entry.views > 0) return Promise.resolve(Ok(undefined));
				const closed = new Promise<Result<undefined, UnsavedError>>((resolve) => closers.push(resolve));
				settleClosing();
				return closed;
			},
			discard() {
				entry.end({ dropped: true });
				if (editors.get(path) === entry) editors.delete(path);
				deps.refresh(path);
			},
			dirty,
			typedOver: lastSent,
			heard,
			/**
			 * A new session, with `text` what its worker holds. Typing the last
			 * session did not answer (or never got) goes over the text the
			 * worker holds when that is one this editor sent, so a write the
			 * worker stored is not merged with itself; otherwise over the base,
			 * and the worker merges it once. A clean editor follows the note.
			 */
			reopened(text) {
				if (ended) return;
				if (state.status === 'failed' && lostWithSession(state.error)) state = { status: 'saving' };
				seen = deps.revision();
				const candidates = [...unknown, base];
				unknown = [];
				if (draft === base && sent.length === 0) {
					if (text !== null) {
						base = text;
						show(text);
					}
					state = { status: 'saved' };
					deps.refresh(path);
					return settleClosing();
				}
				if (sent.length > 0) return;
				const over = text !== null && candidates.includes(text) ? text : base;
				if (draft === over) {
					base = over;
					state = { status: 'saved' };
					tell(null);
					deps.refresh(path);
					return settleClosing();
				}
				send(over);
			},
			lost() {
				if (!ended) settleClosing();
			},
			/** Stop for good. `dropped`: the person let the draft go (a discard, or a delete made here), so nothing is reported unsaved. */
			end({ dropped = false }: { dropped?: boolean } = {}) {
				if (ended) return;
				ended = true;
				if (dropped) draft = lastSent();
				const unsaved = draft !== lastSent();
				state = { status: 'closed' };
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
			if (deps.session() === null) return unavailable();
			const revision = deps.revision();
			let text = deps.stored(path);
			if (text === undefined) {
				let row: Row | null;
				try {
					row = await deps.row(path);
				} catch {
					return unavailable();
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
		/** Why an editor of `path` holds typing it is not saving now (a failed save), or null. */
		stuck(path: string): string | null {
			const state = editors.get(path)?.state();
			if (state?.status === 'failed') return state.error.message;
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
