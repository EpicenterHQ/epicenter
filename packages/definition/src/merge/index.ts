/**
 * `@epicenter/definition/merge`: the note merge as pure functions, which a
 * folder runs when a note changed between showing it and writing it, and
 * Git's hashing and Git LFS pointers. The server never merges (ADR-0773).
 *
 * `settle(base, current, incoming, { parties })` is the entry point:
 * `current` is what `main` holds and `incoming` the write arriving after it,
 * the later arrival (decision 28). Front matter merges by key, the later
 * arrival winning a key both sides set, with no block; the body merges by
 * line, one conflict block per clash; an edit beats a delete (decision 15).
 * A binary file never merges: `settlePointer` lands the later write, and
 * the one that lost stays in history (ADR-0771).
 *
 * Ported from spike 7's `core/` (identical to `claude/repository-v2`
 * `core/{merge,settle,conflict,hash}.ts` at `c32dd466`).
 */
export {
	type Conflict,
	findConflicts,
	type Labels,
	type Party,
	type Side,
	versionOf,
} from './conflict.js';
export {
	type GitCommit,
	type GitObject,
	type GitSignature,
	gitBlobHash,
	gitCommitHash,
	gitCommitObject,
	gitObjectId,
	gitTreeHash,
	gitTreeObject,
	lfsOid,
	type TreeEntry,
} from './hash.js';
export {
	type ContentOverlap,
	type MergeResult,
	merge,
	withBlocks,
} from './merge.js';
export {
	type Parties,
	type Settled,
	settle,
	settlePointer,
} from './settle.js';
