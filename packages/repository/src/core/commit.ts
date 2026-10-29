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
};

/** Everything a commit id hashes. */
export type CommitBody = {
	/** The state the commit is based on: a commit id, or two joined by a space for a merge. */
	parent: string;
	/** `fast-forward` is refused if `main` moved; `merge` is merged where histories meet. */
	mode: 'fast-forward' | 'merge';
	author: Author;
	time: string;
	files: CommitFile[];
};

/** A live commit on the wire. `id` is `commitId` of the rest. */
export type LiveCommit = CommitBody & { id: string };

/** The canonical form a commit id hashes: a JSON array in a fixed order. */
export function canonicalCommit({ parent, mode, author, time, files }: CommitBody) {
	return JSON.stringify([parent, mode, author.user, author.device, time, files.map((f) => [f.path, f.text])]);
}

/** A commit's id: the Git blob id of its canonical form. */
export const commitId = (commit: CommitBody) => gitBlobHash(canonicalCommit(commit));
