/**
 * The protocol between devices and the server: one batch per request, one
 * outcome per batch, and broadcasts of what the server sequence changed.
 * Everything here is plain JSON so any transport can carry it.
 */

/**
 * A span both sides changed. `start` and `end` are offsets in the merged text,
 * which holds `current` there; `base` and `incoming` are the competing spans.
 */
export type Overlap = {
	base: string;
	current: string;
	incoming: string;
	start: number;
	end: number;
};

/** A frontmatter key both sides set: `current` was kept, `incoming` dropped. */
export type Dropped = { key: string; current: unknown; incoming: unknown };

/**
 * What a write was based on: the hash the device held for the file. `text` is
 * that base's text, sent only when the server answers `need-base`.
 */
export type Base = { hash: string; text?: string };

export type Change =
	/** Create (base null), edit, or, with `text` null, delete. */
	| { kind: 'write'; path: string; base: Base | null; text: string | null }
	/** Refused when `to` is taken. */
	| { kind: 'move'; from: string; to: string }
	/** Needs no base; stale after a delete or an untraceable move. */
	| { kind: 'append'; path: string; text: string };

/**
 * `seq` is the device's repository position when the batch was made: the
 * server traces each path's moves and deletes after it.
 */
export type Batch = { device: string; n: number; seq: number; changes: Change[] };

/** What one change did, in an applied batch. */
export type ChangeOutcome = {
	/** The path the change addressed (a move's `from`). */
	path: string;
	/** Where the file is now, or null when it no longer exists. */
	at: string | null;
	/** The server's hash for the file at `at`, or null. */
	hash: string | null;
	/** The file's text when it differs from a write's text; always for a move or append. */
	text?: string | null;
	overlaps: Overlap[];
	dropped: Dropped[];
	/** A delete lost to an edit it had not seen. */
	editKept: boolean;
	/** The path followed a move made after the batch's position. */
	movedTo: string | null;
	/** The change found nothing to apply to (an append or move after a delete). */
	stale: boolean;
};

export type BatchOutcome =
	| { kind: 'applied'; seq: number; changes: ChangeOutcome[] }
	/** The server lacks these bases' texts; resend the batch with them. */
	| { kind: 'need-base'; paths: string[] }
	/** These bases are older than the server's history window. */
	| { kind: 'expired'; paths: string[] }
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
 * then, or, when the server no longer holds that history, every file.
 */
export type Welcome = {
	kind: 'changes' | 'snapshot';
	seq: number;
	files: FileState[];
};
