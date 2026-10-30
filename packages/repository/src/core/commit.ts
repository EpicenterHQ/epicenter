/**
 * A live commit: what a device or an agent sends, and what the server keeps
 * until it flushes into Git. Its id is the Git blob id of its canonical form,
 * which hashes its parent and its content, so an id never repeats and
 * resending the same commit is recognizable.
 */
import { gitBlobHash } from './hash.js';

export type Author = { user: string; device: string };

export type CommitFile = {
	path: string;
	/** The file's new text, or null to delete it. */
	text: string | null;
	/**
	 * A blob's only: the text its writer made this write over (null: no
	 * file), when that is not what the commit's parent holds there. The
	 * server judges the write over it, so a write its writer knew had lost
	 * lands beside the other one (at a sibling) instead of over it.
	 */
	over?: string | null;
};

/** Everything a commit id hashes. */
export type CommitBody = {
	/** The state the commit is based on: a commit id, or two joined by a space for a merge. */
	parent: string;
	author: Author;
	time: string;
	files: CommitFile[];
};

/** A live commit on the wire. `id` is `commitId` of the rest. */
export type LiveCommit = CommitBody & { id: string };

/** The canonical form a commit id hashes: a JSON array in a fixed order. */
export function canonicalCommit({ parent, author, time, files }: CommitBody) {
	return JSON.stringify([
		parent,
		author.user,
		author.device,
		time,
		files.map((f) => [
			f.path,
			f.text,
			...(f.over === undefined ? [] : [f.over]),
		]),
	]);
}

/** A commit's id: the Git blob id of its canonical form. */
export const commitId = (commit: CommitBody) =>
	gitBlobHash(canonicalCommit(commit));
