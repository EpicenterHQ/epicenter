/**
 * Git object codec for the browser data engine.
 *
 * Objects are held inflated and keyed by SHA-1 oid, the same bytes native Git
 * stores before compression. Everything here is a pure byte transformation;
 * malformed input throws a precise `Error` and the store decides how to
 * present it.
 */

export type GitObject = {
	type: 'blob' | 'tree' | 'commit' | 'tag';
	bytes: Uint8Array;
};

/** `mode` is Git's octal spelling (`100644`, `100755`, `120000`, `160000`, `40000`). `name` stays raw bytes. */
export type TreeEntry = { mode: string; name: Uint8Array; oid: string };

const textEncoder = new TextEncoder();
const headerDecoder = new TextDecoder('utf-8');
const oidPattern = /^[0-9a-f]{40}$/;
const modePattern = /^[0-7]+$/;
const SPACE = 0x20;
const NEWLINE = 0x0a;
const SLASH = 0x2f;

function assertOid(oid: string, label: string) {
	if (!oidPattern.test(oid)) {
		throw new Error(
			`${label} must be 40 lowercase hex characters, got "${oid}"`,
		);
	}
}

function concat(parts: readonly Uint8Array[]) {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function toHex(bytes: Uint8Array) {
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

function fromHex(hex: string) {
	const out = new Uint8Array(20);
	for (let i = 0; i < 20; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/** SHA-1 of `<type> <length>\0<bytes>`, the oid native Git assigns the object. */
export async function hashObject({ type, bytes }: GitObject): Promise<string> {
	const header = textEncoder.encode(`${type} ${bytes.length}\0`);
	const digest = await crypto.subtle.digest('SHA-1', concat([header, bytes]));
	return toHex(new Uint8Array(digest));
}

/** Parses `<mode> <name>\0<20-byte oid>` records. Names are copied, never decoded. */
export function readTree(bytes: Uint8Array): TreeEntry[] {
	const entries: TreeEntry[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const space = bytes.indexOf(SPACE, offset);
		if (space === -1)
			throw new Error(`tree entry at byte ${offset} has no mode terminator`);
		const nul = bytes.indexOf(0, space + 1);
		if (nul === -1)
			throw new Error(`tree entry at byte ${offset} has no name terminator`);
		if (nul + 21 > bytes.length) {
			throw new Error(
				`tree entry at byte ${offset} is cut off before its 20-byte oid`,
			);
		}
		const mode = headerDecoder.decode(bytes.subarray(offset, space));
		if (!modePattern.test(mode)) {
			throw new Error(
				`tree entry at byte ${offset} has invalid mode "${mode}"`,
			);
		}
		entries.push({
			mode,
			name: bytes.slice(space + 1, nul),
			oid: toHex(bytes.subarray(nul + 1, nul + 21)),
		});
		offset = nul + 21;
	}
	return entries;
}

function isDirectoryMode(mode: string) {
	return mode === '40000' || mode === '040000';
}

/** Native Git order: bytewise, with a directory name compared as if it ended in `/`. */
function compareEntries(a: TreeEntry, b: TreeEntry) {
	const common = Math.min(a.name.length, b.name.length);
	for (let i = 0; i < common; i++) {
		const difference = a.name[i]! - b.name[i]!;
		if (difference !== 0) return difference;
	}
	const next = (entry: TreeEntry) =>
		entry.name.length > common
			? entry.name[common]!
			: isDirectoryMode(entry.mode)
				? SLASH
				: 0;
	return next(a) - next(b);
}

/** Serializes entries in native Git order. The caller's array and names are left untouched. */
export function writeTree(entries: readonly TreeEntry[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const entry of [...entries].sort(compareEntries)) {
		if (!modePattern.test(entry.mode)) {
			throw new Error(
				`tree entry mode must be octal digits, got "${entry.mode}"`,
			);
		}
		if (entry.name.length === 0 || entry.name.includes(0)) {
			throw new Error(
				'tree entry name must be non-empty and contain no NUL byte',
			);
		}
		assertOid(entry.oid, 'tree entry oid');
		parts.push(
			textEncoder.encode(`${entry.mode} `),
			entry.name,
			new Uint8Array(1),
			fromHex(entry.oid),
		);
	}
	return concat(parts);
}

/**
 * Reads `tree` and every `parent` from the header block. Other headers
 * (`author`, `gpgsig`, `mergetag`, ...) and their space-led continuation lines
 * are skipped, and the message body is never scanned.
 */
export function readCommit(bytes: Uint8Array): {
	tree: string;
	parents: string[];
} {
	let tree: string | undefined;
	const parents: string[] = [];
	let offset = 0;
	while (offset < bytes.length && bytes[offset] !== NEWLINE) {
		let end = bytes.indexOf(NEWLINE, offset);
		if (end === -1) end = bytes.length;
		// Continuation lines start with a space and belong to the previous header.
		if (bytes[offset] !== SPACE) {
			const line = headerDecoder.decode(bytes.subarray(offset, end));
			if (line.startsWith('tree ')) {
				tree = line.slice(5);
				assertOid(tree, 'commit tree');
			} else if (line.startsWith('parent ')) {
				const parent = line.slice(7);
				assertOid(parent, 'commit parent');
				parents.push(parent);
			}
		}
		offset = end + 1;
	}
	if (tree === undefined) throw new Error('commit has no tree header');
	return { tree, parents };
}

function formatTimezone(minutesEast: number) {
	if (!Number.isInteger(minutesEast) || Math.abs(minutesEast) >= 24 * 60) {
		throw new Error(
			`timezoneOffset must be whole minutes within a day, got ${minutesEast}`,
		);
	}
	const sign = minutesEast < 0 ? '-' : '+';
	const absolute = Math.abs(minutesEast);
	const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
	const minutes = String(absolute % 60).padStart(2, '0');
	return `${sign}${hours}${minutes}`;
}

function formatIdentity({
	name,
	email,
	timestamp,
	timezoneOffset = 0,
}: {
	name: string;
	email: string;
	timestamp: number;
	timezoneOffset?: number;
}) {
	if (/[\n<>]/.test(name) || /[\n<>]/.test(email)) {
		throw new Error(
			'author name and email must not contain newline, "<" or ">"',
		);
	}
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new Error(
			`timestamp must be non-negative whole seconds, got ${timestamp}`,
		);
	}
	return `${name} <${email}> ${timestamp} ${formatTimezone(timezoneOffset)}`;
}

/**
 * Serializes a commit whose committer is the author. `timezoneOffset` is
 * minutes east of UTC (`+0530` is `330`), the reverse of `Date#getTimezoneOffset`.
 * The message is written exactly as given.
 */
export function writeCommit({
	tree,
	parents,
	author,
	message,
}: {
	tree: string;
	parents: readonly string[];
	author: {
		name: string;
		email: string;
		timestamp: number;
		timezoneOffset?: number;
	};
	message: string;
}): Uint8Array {
	assertOid(tree, 'commit tree');
	for (const parent of parents) assertOid(parent, 'commit parent');
	const identity = formatIdentity(author);
	const lines = [
		`tree ${tree}`,
		...parents.map((parent) => `parent ${parent}`),
		`author ${identity}`,
		`committer ${identity}`,
	];
	return textEncoder.encode(`${lines.join('\n')}\n\n${message}`);
}
