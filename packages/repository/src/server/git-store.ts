/**
 * What the server needs from Git: read trees and blobs, write blobs, trees and
 * commits, and move a ref by compare-and-swap. Implementations throw on I/O
 * failure (an unexpected condition); expected outcomes are values: a missing
 * object is null and a lost compare-and-swap is false.
 */

export type TreeEntry = { mode: string; oid: string };
/** A flat tree: every blob's full path to its entry. */
export type Tree = Map<string, TreeEntry>;

export type CommitInfo = { tree: string; parents: string[]; message: string };

export type Signature = { name: string; email: string };

export type GitStore = {
	readRef(name: string): Promise<string | null>;
	readCommit(oid: string): Promise<CommitInfo | null>;
	readTree(oid: string): Promise<Tree>;
	readBlob(oid: string): Promise<Uint8Array | null>;
	writeBlob(bytes: Uint8Array): Promise<string>;
	writeTree(tree: Tree): Promise<string>;
	writeCommit(commit: {
		tree: string;
		parents: string[];
		message: string;
		author: Signature;
		at: Date;
	}): Promise<string>;
	/** Move `name` to `next` only if it is still `expected` (null: absent). */
	updateRef(name: string, next: string, expected: string | null): Promise<boolean>;
	mergeBase(a: string, b: string): Promise<string | null>;
};

export const MAIN = 'refs/heads/main';

/** The `Epicenter-Seq` trailer of a commit message, or null. */
export function sequenceOf(message: string): number | null {
	const found = /^Epicenter-Seq: (\d+)$/m.exec(message);
	return found === null ? null : Number(found[1]);
}
