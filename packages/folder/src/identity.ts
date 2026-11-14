/**
 * A directory's identity on this computer (ADR-0822): its inode and its
 * birth time, never its device, whose number changes when a drive mounts
 * again. Node's `stat` and the desktop shell (`identity_of` in the folder
 * core) read the same two numbers: `inode` is `st_ino` in decimal, and
 * `birthtime` the birth time in nanoseconds since the epoch, in decimal, or
 * null where the file system records none (or reports zero).
 *
 * An identity proves a directory is the one a record names only when the
 * inodes match and both sides have a real birth time (`proves`): a file
 * system without birth times can give a new directory a deleted one's
 * inode.
 */

/** A directory's identity: its inode and birth time. */
export type FolderIdentity = {
	inode: string;
	/** Nanoseconds since the epoch; null where the file system has no birth time. */
	birthtime: string | null;
};

/** What `stat(path, { bigint: true })` answers, as far as an identity reads it. */
export type IdentityStats = { ino: bigint; birthtimeNs: bigint };

/** The identity `stats` describe: a birth time of zero (none recorded) is null. */
export const identityOf = ({
	ino,
	birthtimeNs,
}: IdentityStats): FolderIdentity => ({
	inode: ino.toString(),
	birthtime: birthtimeNs > 0n ? birthtimeNs.toString() : null,
});

/**
 * Whether `a` and `b` are one directory: the same inode, and the same real
 * birth time on both sides. Never true when either has no birth time.
 */
export const proves = (a: FolderIdentity, b: FolderIdentity) =>
	a.inode === b.inode && a.birthtime !== null && a.birthtime === b.birthtime;

/**
 * The name a directory's caches go under (`hashes/<key>.json`):
 * `<inode>-<birthtime>`, or `<inode>` without a birth time. The shell's
 * `identity_key` spells it the same way.
 */
export const identityKey = ({ inode, birthtime }: FolderIdentity) =>
	birthtime === null ? inode : `${inode}-${birthtime}`;

/** Whether `a` and `b` name one identity, a missing birth time included. */
export const sameIdentity = (
	a: FolderIdentity | null,
	b: FolderIdentity | null,
) => a?.inode === b?.inode && a?.birthtime === b?.birthtime;
