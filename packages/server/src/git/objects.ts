/**
 * The Git object port (`GitObjects`) that the write translator and the
 * push receiver share, and the object formats both read and write.
 *
 * A backend only stores: it lists refs, reads an object by id and kind, answers
 * whether one commit is an ancestor of another, and applies ref updates
 * together with a pack, atomically and only where every ref still holds the
 * value the caller read (compare-and-swap). Every rule (fast-forward, LFS
 * pointers, merges, receipts) lives above it, so the disk store here and
 * Cloudflare Artifacts later (phase 7) run the same routes.
 */
import { createHash } from 'node:crypto';

/** The one branch a hosted repository has. */
export const MAIN = 'refs/heads/main';

/** The id Git writes for "no object": a ref that does not exist. */
export const ZERO_OID = '0'.repeat(40);
export const OID = /^[0-9a-f]{40}$/;

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag';

/** An object as stored: its kind and its content. */
export type RawObject = { kind: ObjectKind; bytes: Uint8Array };

/** One ref move: `old` is what the ref must hold now (`ZERO_OID`: absent), `next` what it becomes. */
export type RefUpdate = { ref: string; old: string; next: string };

export type ApplyOutcome =
	/** Every ref moved, together. */
	| { ok: true }
	/** A ref no longer held its `old` value; nothing moved. */
	| { ok: false; stale: true; reason: string }
	/** The pack or its objects were refused; nothing moved. */
	| { ok: false; stale: false; reason: string };

export type GitObjects = {
	/** Every ref and the object it names, hidden refs included. */
	refs(): Promise<Map<string, string>>;
	/**
	 * The `kind` object `oid`, or null when it is absent or of another kind.
	 * Callers always know the kind they follow (a commit's tree, a tree's
	 * entry), and a store that reads by kind (Artifacts) needs it. When the
	 * content is longer than `maxBytes`, only its size comes back.
	 *
	 * A commit's bytes are enough to parse (`parseCommit`): a store may
	 * rebuild them from parsed fields, so they need not hash to `oid`.
	 */
	read(
		oid: string,
		kind: ObjectKind,
		options?: { maxBytes?: number },
	): Promise<{ size: number; bytes: Uint8Array | null } | null>;
	/** Whether `ancestor` is `descendant` or reachable from it. */
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	/**
	 * Store `pack` (when given), check that every `next` names a complete
	 * history, then move every ref in one transaction, or none.
	 */
	apply(updates: RefUpdate[], pack: Uint8Array | null): Promise<ApplyOutcome>;
	/** Release whatever this handle holds open. */
	close(): void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A Git object's id: SHA-1 over `<kind> <length>\0<bytes>`. */
export function objectId(kind: ObjectKind, bytes: Uint8Array): string {
	return createHash('sha1')
		.update(`${kind} ${bytes.length}\0`)
		.update(bytes)
		.digest('hex');
}

/** An object ready to pack: its id, kind and content. */
export type PackObject = { oid: string; kind: ObjectKind; bytes: Uint8Array };

export function makeObject(
	kind: ObjectKind,
	content: string | Uint8Array,
): PackObject {
	const bytes = typeof content === 'string' ? encoder.encode(content) : content;
	return { oid: objectId(kind, bytes), kind, bytes };
}

/** A tree entry as stored: `40000` is a tree, `100644` and `100755` files, `120000` a symlink, `160000` a submodule. */
export type TreeEntry = { mode: string; name: string; oid: string };

export const TREE_MODE = '40000';

export function parseTree(bytes: Uint8Array): TreeEntry[] {
	const entries: TreeEntry[] = [];
	let at = 0;
	while (at < bytes.length) {
		const space = bytes.indexOf(0x20, at);
		const nul = bytes.indexOf(0, space);
		if (space < 0 || nul < 0 || nul + 21 > bytes.length)
			throw new Error('malformed tree');
		entries.push({
			mode: decoder.decode(bytes.subarray(at, space)),
			name: decoder.decode(bytes.subarray(space + 1, nul)),
			oid: Buffer.from(bytes.subarray(nul + 1, nul + 21)).toString('hex'),
		});
		at = nul + 21;
	}
	return entries;
}

/** The tree object of `entries`, sorted as Git sorts them (a tree as if its name ended in `/`). */
export function treeObject(entries: Iterable<TreeEntry>): PackObject {
	const key = (e: TreeEntry) => (e.mode === TREE_MODE ? `${e.name}/` : e.name);
	const sorted = [...entries].sort((a, b) =>
		key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
	);
	const parts = sorted.flatMap((e) => [
		encoder.encode(`${e.mode} ${e.name}\0`),
		Buffer.from(e.oid, 'hex'),
	]);
	return makeObject('tree', Buffer.concat(parts));
}

export type Commit = { tree: string; parents: string[]; message: string };

export function parseCommit(bytes: Uint8Array): Commit {
	const text = decoder.decode(bytes);
	const cut = text.indexOf('\n\n');
	const head = cut < 0 ? text : text.slice(0, cut);
	const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1];
	if (tree === undefined) throw new Error('malformed commit');
	const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(
		(m) => m[1] as string,
	);
	return { tree, parents, message: cut < 0 ? '' : text.slice(cut + 2) };
}

export type Signature = { name: string; email: string; at: Date };

export function commitObject({
	tree,
	parents,
	author,
	message,
}: {
	tree: string;
	parents: string[];
	author: Signature;
	message: string;
}): PackObject {
	const sign = `${author.name} <${author.email}> ${Math.floor(author.at.getTime() / 1000)} +0000`;
	return makeObject(
		'commit',
		[
			`tree ${tree}`,
			...parents.map((p) => `parent ${p}`),
			`author ${sign}`,
			`committer ${sign}`,
			'',
			message,
		].join('\n'),
	);
}

/** Read a commit through `objects`, or null when it is absent or not a commit. */
export async function readCommit(
	objects: GitObjects,
	oid: string,
): Promise<Commit | null> {
	const found = await objects.read(oid, 'commit');
	return found?.bytes ? parseCommit(found.bytes) : null;
}

/** Read a tree through `objects`, or null when it is absent or not a tree. */
export async function readTree(
	objects: GitObjects,
	oid: string,
): Promise<TreeEntry[] | null> {
	const found = await objects.read(oid, 'tree');
	return found?.bytes ? parseTree(found.bytes) : null;
}
