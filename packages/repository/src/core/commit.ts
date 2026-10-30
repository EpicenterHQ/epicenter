/**
 * What a writer sends, and what the server keeps until it flushes into Git.
 *
 * A write is one file saying what it saw: its `path`, its `base` (the Git
 * blob hash of the version its writer last saw there, null for none) and
 * what it is now (`next`). A push carries a device's writes, numbered: its
 * `device`, an `epoch` the device's database chose, and `seq`, stored on
 * the device before it is sent, so a resend is recognized exactly and a
 * device that went back in time (a restored database) is told so.
 *
 * Pointer text exists only at the Git edges: a blob travels as its LFS
 * object's oid and size, and the server stores the canonical pointer, whose
 * Git blob hash is the blob's version. One hash space names every version.
 *
 * A live commit is the server's own record of what landed on `main`: a
 * snapshot of the files it changed on top of its parent, its id the Git
 * blob id of its canonical form.
 */
import { isNote } from './door.js';
import { gitBlobHash } from './hash.js';
import { type LfsPointer, parsePointer, writePointer } from './markdown.js';

export type Author = { user: string; device: string };

/** A blob's bytes: its LFS object id (SHA-256) and size. */
export type BlobRef = LfsPointer;

/** What a file is: a note's text, or a blob's bytes. */
export type Content = { text: string } | { blob: BlobRef };

/** What a write makes a file: a note's text, a blob's bytes, or nothing. */
export type Next = Content | { deleted: true };

/** One file's write: what its writer saw (`base`, a Git blob hash) and what it is now. */
export type FileWrite = { path: string; base: string | null; next: Next };

/**
 * A device's numbered push. `seq` grows with each push of an `epoch`;
 * `from` is the position the device stands on, so the answer brings what
 * changed since; `time` is the device's claim, a label, never an order.
 */
export type Push = {
	user: string;
	device: string;
	epoch: string;
	seq: number;
	time: string;
	from: string | null;
	files: FileWrite[];
};

/** The hash a push is recognized by: the Git blob id of its canonical form. */
export const pushHash = (push: Push) =>
	gitBlobHash(
		JSON.stringify([
			push.user,
			push.device,
			push.epoch,
			push.seq,
			push.time,
			push.from,
			push.files.map((f) => [f.path, f.base, f.next]),
		]),
	);

/** RULE: the kind comes from the path: a note (`.md`) is text, every other file is bytes. Null when `next` agrees, or why not. */
export function kindRefusal(path: string, next: Next): string | null {
	if ('deleted' in next) return null;
	if (isNote(path))
		return 'text' in next ? null : 'a note is text, never bytes';
	return 'blob' in next ? null : 'a file that is not a note holds bytes';
}

/** A file's content as stored (a note's text, a blob's canonical pointer): the Git edge, written. */
export const textOf = (content: Content) =>
	'text' in content ? content.text : writePointer(content.blob);

/** What the server stores for `next`, or null to delete. */
export const storedText = (next: Next): string | null =>
	'deleted' in next ? null : textOf(next);

/** A file as stored, as content: the Git edge, read back. A canonical pointer is a blob's (the door never lets a note be one); any other text is a note's. */
export function contentOf(text: string): Content {
	const blob = parsePointer(text);
	return blob === null ? { text } : { blob };
}

/** The Git blob hash of a version: a note's text, or a blob's pointer (null: no file). */
export const versionOf = (content: Content | null) =>
	content === null ? null : gitBlobHash(textOf(content));

/** One file a live commit changes: its new text (a blob's pointer), or null to delete it. */
export type CommitFile = { path: string; text: string | null };

/** Everything a live commit id hashes. */
export type CommitBody = {
	/** The state the commit is based on: a commit id, or two joined by a space for a merge. */
	parent: string;
	author: Author;
	time: string;
	files: CommitFile[];
};

/** The canonical form a commit id hashes: a JSON array in a fixed order. */
export function canonicalCommit({ parent, author, time, files }: CommitBody) {
	return JSON.stringify([
		parent,
		author.user,
		author.device,
		time,
		files.map((f) => [f.path, f.text]),
	]);
}

/** A live commit's id: the Git blob id of its canonical form. */
export const commitId = (commit: CommitBody) =>
	gitBlobHash(canonicalCommit(commit));
