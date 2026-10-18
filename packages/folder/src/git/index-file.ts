/**
 * Git's version 2 index file, read and written whole.
 *
 * isomorphic-git's status walk sees only one stage of an unmerged path, so the
 * entries themselves are read here: to find unmerged stages and to tell
 * whether two indexes differ in more than cached file stats. A browser
 * folder's index is written here too, from a tree in one pass
 * (`treeIndex`): isomorphic-git resets one path per call, reading and
 * writing the whole index each time. Only version 2, the version
 * isomorphic-git writes, is understood; other bytes read as `undefined`.
 */

type IndexEntry = {
	readonly mode: number;
	readonly oid: string;
	/** 0 for a merged entry; 1, 2, 3 for an unmerged path's base, ours, and theirs. */
	readonly stage: 0 | 1 | 2 | 3;
	readonly path: string;
};

const decoder = new TextDecoder();
/** Byte offset of the mode word in an entry, after the cached ctime, mtime, dev, and ino. */
const MODE_OFFSET = 24;

/** Every entry, in file order, or `undefined` for anything but a version 2 index. */
export function parseIndex(bytes: Uint8Array): IndexEntry[] | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < 12 || decoder.decode(bytes.subarray(0, 4)) !== 'DIRC')
		return undefined;
	if (view.getUint32(4) !== 2) return undefined;
	const entries: IndexEntry[] = [];
	let offset = 12;
	for (let count = view.getUint32(8); count > 0; count--) {
		if (offset + 62 > bytes.byteLength) return undefined;
		const oid = [...bytes.subarray(offset + 40, offset + 60)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		const flags = view.getUint16(offset + 60);
		const start = offset + 62;
		const end = bytes.indexOf(0, start);
		if (end < 0) return undefined;
		entries.push({
			mode: view.getUint32(offset + MODE_OFFSET),
			oid,
			stage: ((flags >> 12) & 0b11) as IndexEntry['stage'],
			path: decoder.decode(bytes.subarray(start, end)),
		});
		// An entry is padded with NULs to a multiple of eight bytes.
		offset += Math.ceil((end - offset + 1) / 8) * 8;
	}
	return entries;
}

/** What an entry says apart from cached stats: mode, object, stage, and path. */
export const entryKey = (entry: IndexEntry) =>
	`${entry.mode.toString(8)} ${entry.oid} ${entry.stage} ${entry.path}`;

/**
 * Why a whole-folder commit refuses unmerged index stages, which only
 * another Git program leaves here. Such a commit would reset the stages to
 * the head and record whatever the files hold, conflict markers included,
 * as one-parent content. The stages stay for whoever repairs it with Git.
 */
export function orphanStagesProblem(
	paths: readonly string[],
): string | undefined {
	if (paths.length === 0) return undefined;
	return `${paths.join(', ')} ${paths.length === 1 ? 'has' : 'have'} unmerged index stages from a merge begun outside this folder; finish or abandon that merge with Git, then Sync`;
}

const encoder = new TextEncoder();

/** Git orders index entries by the bytes of their paths. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const length = Math.min(a.byteLength, b.byteLength);
	for (let index = 0; index < length; index++)
		if (a[index] !== b[index]) return a[index]! - b[index]!;
	return a.byteLength - b.byteLength;
}

/**
 * A version 2 index whose merged entries are exactly `files`, a tree's
 * leaves by path, with no cached stats: every stat is zero, which no file
 * matches, so whoever reads it hashes the file rather than trusting it. A
 * browser folder's stats are never trusted anyway (`statsFor` in
 * `opfs-git.ts`).
 */
export async function treeIndex(
	files: ReadonlyMap<string, { readonly oid: string; readonly mode: string }>,
): Promise<Uint8Array> {
	const entries = [...files]
		.map(([path, file]) => ({ name: encoder.encode(path), ...file }))
		.sort((a, b) => compareBytes(a.name, b.name));
	const sizes = entries.map(
		({ name }) => Math.ceil((62 + name.byteLength + 1) / 8) * 8,
	);
	const length = 12 + sizes.reduce((sum, size) => sum + size, 0);
	const bytes = new Uint8Array(length + 20);
	const view = new DataView(bytes.buffer);
	bytes.set(encoder.encode('DIRC'), 0);
	view.setUint32(4, 2);
	view.setUint32(8, entries.length);
	let offset = 12;
	entries.forEach(({ name, oid, mode }, index) => {
		view.setUint32(offset + MODE_OFFSET, Number.parseInt(mode, 8));
		for (let byte = 0; byte < 20; byte++)
			bytes[offset + 40 + byte] = Number.parseInt(
				oid.slice(byte * 2, byte * 2 + 2),
				16,
			);
		view.setUint16(offset + 60, Math.min(name.byteLength, 0xfff));
		bytes.set(name, offset + 62);
		offset += sizes[index]!;
	});
	const checksum = await crypto.subtle.digest(
		'SHA-1',
		bytes.subarray(0, length) as Uint8Array<ArrayBuffer>,
	);
	bytes.set(new Uint8Array(checksum), length);
	return bytes;
}
