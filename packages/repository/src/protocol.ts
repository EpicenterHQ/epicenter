/**
 * The protocol between devices and the server: one batch per request, one
 * outcome per batch, and broadcasts of what the server sequence changed.
 * Everything here is plain JSON so any transport can carry it.
 */

import type { ContentOverlap } from './core/merge.js';

/**
 * Something both sides changed, and how the merge left it: what the merge
 * reports (`ContentOverlap`), or a broken parse or a path clash, which the
 * server finds. Every kind of clash is one of these, so one policy
 * (`settle` in policy.ts) decides them all.
 */
export type Overlap =
	| ContentOverlap
	/**
	 * The change would turn a note whose frontmatter parses into one whose
	 * frontmatter does not, which no write may do (`breaksParsing`).
	 */
	| { unit: 'file'; clash: 'unparseable' }
	/**
	 * The path a change named no longer holds its note: it was deleted and
	 * `reused` by another, a
	 * move's destination is `taken` by another note, or a
	 * move's note is `gone`. `relocatedTo` is the sibling note the server put
	 * the change in instead, or null when nothing was put anywhere.
	 */
	| { unit: 'path'; clash: 'reused' | 'taken' | 'gone'; relocatedTo: string | null };

/** How an overlap was settled when the change landed, so the record says what happened. */
export type SettledOverlap = Overlap & {
	settled: 'marked' | 'current-kept' | 'edit-kept' | 'joined' | 'relocated' | 'dropped';
};

/**
 * What a change was based on: the hash of the text the device showed for the
 * file. `text` is that base's text, sent only when the server answers
 * `need-base`.
 */
export type Base = { hash: string; text?: string };

export type Change =
	/** Create (base null), edit, or, with `text` null, delete. */
	| { kind: 'write'; path: string; base: Base | null; text: string | null }
	/**
	 * A rename: the path is one of the note's fields. When the note was
	 * renamed since, or `to` holds another note, the current path wins.
	 */
	| { kind: 'move'; from: string; to: string }
	/**
	 * Adds to whatever the file holds. The base is needed only when the note
	 * is gone: the append is then an edit of its base.
	 */
	| { kind: 'append'; path: string; text: string; base: Base };

/**
 * `seq` is the device's repository position when the batch was made: the
 * server traces each path's moves and deletes after it. `policy` settles its
 * overlaps: `'mark'` for a person's write, which always lands, `'refuse'`
 * for a caller that waits for the verdict (see `settle`).
 */
export type Batch = { device: string; n: number; seq: number; policy: 'mark' | 'refuse'; changes: Change[] };

/** What one change did, in an applied batch. */
export type ChangeOutcome = {
	/** The path the change addressed (a move's `from`). */
	path: string;
	/** Where the file is now (a relocated change's sibling), or null when it no longer exists. */
	at: string | null;
	/** The server's hash for the file at `at`, or null. */
	hash: string | null;
	/** The file's text when it differs from a write's text; always for a move or append. */
	text?: string | null;
	/** The path followed a move made after the batch's position. */
	movedTo: string | null;
	overlaps: SettledOverlap[];
};

export type BatchOutcome =
	/**
	 * `seq` is null and `changes` empty for a retry of a batch whose receipt
	 * left with its commit: it landed, but its details are gone.
	 */
	| { kind: 'applied'; seq: number | null; changes: ChangeOutcome[] }
	/** The server lacks these bases' texts; resend the batch with them. */
	| { kind: 'need-base'; paths: string[] }
	| { kind: 'refused'; path: string; reason: string; overlaps: Overlap[] };

/** A file's state at the server: text null means no file. */
export type FileState = { path: string; text: string | null; hash: string | null };

export type Move = { from: string; to: string };

/** One applied batch, sent to every other connected device. */
export type Broadcast = {
	seq: number;
	device: string;
	files: FileState[];
	moves: Move[];
};

/**
 * The answer to a device saying hello from `seq`: either what changed since
 * then, or, when the server no longer holds that history, every file; and
 * `through`, the number of the device's last batch the server applied (0
 * for none), so the device knows which of its unanswered batches the files
 * already hold, after a reply was lost.
 */
export type Welcome = {
	kind: 'changes' | 'snapshot';
	seq: number;
	files: FileState[];
	through: number;
};
