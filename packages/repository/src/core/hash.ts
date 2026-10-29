/**
 * Content hashes, in two families that never mix:
 *
 * - Git object ids are SHA-1 over a Git object (`blob`, `tree`, `commit`), so a hash a
 *   device holds names the same bytes in the server, in Git and in a clone.
 *   They are computed synchronously in plain JavaScript because a server
 *   applies a commit inside one synchronous transaction and the browser has
 *   no synchronous SHA-1.
 * - LFS object ids (`lfsOid`) are SHA-256 over a blob's raw bytes, as Git
 *   LFS names them in a pointer.
 */

const encoder = new TextEncoder();

/** A Git object: its kind and its content, as a pack or a loose object carries it. */
export type GitObject = { kind: 'blob' | 'tree' | 'commit'; bytes: Uint8Array };

/** A Git object's id: SHA-1 over `<kind> <length>\0<bytes>`. */
export function gitObjectId({ kind, bytes }: GitObject): string {
	const header = encoder.encode(`${kind} ${bytes.length}\0`);
	const all = new Uint8Array(header.length + bytes.length);
	all.set(header);
	all.set(bytes, header.length);
	return sha1(all);
}

/** The Git blob id (`git hash-object`) of `content`. */
export function gitBlobHash(content: string | Uint8Array): string {
	return gitObjectId({ kind: 'blob', bytes: typeof content === 'string' ? encoder.encode(content) : content });
}

/**
 * What a Git tree entry names: a file (its blob id) or a subtree (its tree
 * id). `mode` defaults to a regular file (`100644`) or a tree (`40000`).
 */
export type TreeEntry = { kind: 'blob' | 'tree'; hash: string; mode?: string };

/**
 * The Git tree object of `entries`: each entry is `<mode> <name>\0<20-byte
 * id>`, sorted by name with a subtree compared as if its name ended in `/`.
 */
export function gitTreeObject(entries: [name: string, entry: TreeEntry][]): GitObject {
	const key = ([name, entry]: [string, TreeEntry]) => (entry.kind === 'tree' ? `${name}/` : name);
	const sorted = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
	const parts = sorted.map(([name, entry]) => {
		const head = encoder.encode(`${entry.mode ?? (entry.kind === 'tree' ? '40000' : '100644')} ${name}\0`);
		const part = new Uint8Array(head.length + 20);
		part.set(head);
		for (let i = 0; i < 20; i++) part[head.length + i] = Number.parseInt(entry.hash.slice(i * 2, i * 2 + 2), 16);
		return part;
	});
	const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.length;
	}
	return { kind: 'tree', bytes: body };
}

/** The Git tree id (`git write-tree`) of `entries`. */
export const gitTreeHash = (entries: [name: string, entry: TreeEntry][]): string => gitObjectId(gitTreeObject(entries));

/** Who made a Git commit, and when (seconds since the epoch, UTC). */
export type GitSignature = { name: string; email: string; at: number };

/** What a Git commit holds. */
export type GitCommit = { tree: string; parents: string[]; author: GitSignature; committer: GitSignature; message: string };

/**
 * The Git commit object of a commit: its tree, its parents, author and
 * committer lines with times in UTC, a blank line, and the message as given.
 */
export function gitCommitObject({
	tree,
	parents,
	author,
	committer,
	message,
}: GitCommit): GitObject {
	const sign = ({ name, email, at }: GitSignature) => `${name} <${email}> ${at} +0000`;
	const header = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${sign(author)}`, `committer ${sign(committer)}`];
	return { kind: 'commit', bytes: encoder.encode(`${header.join('\n')}\n\n${message}`) };
}

/** The Git commit id (`git commit-tree`) of a commit. */
export const gitCommitHash = (commit: GitCommit): string => gitObjectId(gitCommitObject(commit));

/** The LFS object id of a blob's bytes: lowercase hex SHA-256. */
export async function lfsOid(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array) {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** SHA-1 of `message`, as hex. */
export function sha1(message: Uint8Array): string {
	const length = message.length;
	const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
	padded.set(message);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
	view.setUint32(padded.length - 4, (length * 8) >>> 0);
	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;
	const w = new Uint32Array(80);
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 80; i++) {
			const x = (w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0);
			w[i] = (x << 1) | (x >>> 31);
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		for (let i = 0; i < 80; i++) {
			let f: number;
			let k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const t = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] ?? 0)) >>> 0;
			e = d;
			d = c;
			c = (b << 30) | (b >>> 2);
			b = a;
			a = t;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}
	return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}
