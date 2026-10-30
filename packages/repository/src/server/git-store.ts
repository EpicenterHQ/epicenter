/**
 * What the server needs from Git: read commits, trees and blobs, write
 * objects as one pack with a ref update, and move a ref by
 * compare-and-swap. Implementations throw on I/O failure (an unexpected
 * condition); expected outcomes are values: a missing object is null and a
 * lost compare-and-swap is false.
 */
import type { GitObject } from '../core/hash.js';

export type TreeEntry = { mode: string; oid: string };
/** A flat tree: every blob's full path to its entry. */
export type Tree = Map<string, TreeEntry>;

export type CommitInfo = { tree: string; parents: string[]; message: string };

/** A commit and its object id, as a log lists it. */
export type LoggedCommit = CommitInfo & { oid: string };

export type Signature = { name: string; email: string };

/** Git's objects and refs: what the server reads and writes. */
export type GitObjects = {
	readRef(name: string): Promise<string | null>;
	readCommit(oid: string): Promise<CommitInfo | null>;
	readTree(oid: string): Promise<Tree>;
	readBlob(oid: string): Promise<Uint8Array | null>;
	/**
	 * Write `objects` and move `ref` from `expected` (null: absent) to `next`,
	 * in one request (Git's receive-pack: the objects as one pack, and the
	 * ref update); false when the ref was not `expected`. `next` must be one
	 * of `objects` or already in Git, with everything it names.
	 */
	writePack(
		objects: GitObject[],
		ref: { name: string; next: string; expected: string | null },
	): Promise<boolean>;
	/** Move `name` to `next` only if it is still `expected` (null: absent). */
	updateRef(
		name: string,
		next: string,
		expected: string | null,
	): Promise<boolean>;
	/** Delete `name` only if it is still `expected`; true when it is gone. */
	deleteRef(name: string, expected: string): Promise<boolean>;
};

/**
 * Writing one object at a time: how a test or a script makes the commits a
 * transport would push. The server writes only packs.
 */
export type GitObjectWrites = {
	writeBlob(bytes: Uint8Array): Promise<string>;
	writeTree(tree: Tree): Promise<string>;
	/** Write a commit; the committer is the author unless named. */
	writeCommit(commit: {
		tree: string;
		parents: string[];
		message: string;
		author: Signature;
		committer?: Signature;
		at: Date;
	}): Promise<string>;
};

/** What today's (legacy) server also needs: history walks. */
export type GitStore = GitObjects &
	GitObjectWrites & {
		mergeBase(a: string, b: string): Promise<string | null>;
		/**
		 * The first-parent commits from `head` back to, not including, the newest
		 * one whose `Epicenter-Seq` is at or below `seq`, oldest first: the commits
		 * a device at `seq` has not seen. A commit with no sequence does not stop
		 * the walk.
		 */
		commitsAfter(head: string, seq: number): Promise<LoggedCommit[]>;
	};

export const MAIN = 'refs/heads/main';

/** The `Epicenter-Seq` trailer of a commit message, or null. */
export function sequenceOf(message: string): number | null {
	const found = /^Epicenter-Seq: (\d+)$/m.exec(message);
	return found === null ? null : Number(found[1]);
}
