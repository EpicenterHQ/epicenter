/**
 * The names a folder's log uses (ADR-0824): a file's version is the SHA-256
 * of its bytes, for every path; bytes up to `INLINE_MAX` are kept in the
 * `blob` row and larger ones in the blob store; and a cursor names a point
 * in one folder's log as `<epoch>.<seq>`.
 */
import { sql } from 'drizzle-orm';

/** A version: the SHA-256 of a file's bytes, 64 lowercase hex digits. */
export const VERSION = /^[0-9a-f]{64}$/;

/** `values` as one SQL `text[]` parameter, for `= any(...)`. */
export const texts = (values: readonly string[]) =>
	sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

/** The most bytes kept inline in Postgres; larger ones live in the blob store. */
export const INLINE_MAX = 16 * 1024;

/** The SHA-256 of `bytes`, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
	);
	let out = '';
	for (const byte of digest) out += byte.toString(16).padStart(2, '0');
	return out;
}

/**
 * A path as a disk that ignores case compares it (a Mac's or a Windows
 * computer's default): `Todo.md` and `todo.md`, or a composed and a
 * decomposed `é`, are one file there, so a folder never holds both.
 */
export const foldPath = (path: string) => path.normalize('NFC').toLowerCase();

/** A point in a folder's log. */
export type Cursor = { epoch: string; seq: number };

export const writeCursor = ({ epoch, seq }: Cursor) => `${epoch}.${seq}`;

/** The cursor `text` spells, or null when it spells none. */
export function readCursor(text: string): Cursor | null {
	const match = /^([a-z0-9]{1,32})\.(\d{1,15})$/.exec(text);
	if (match === null) return null;
	return { epoch: match[1] as string, seq: Number(match[2]) };
}

/** Why `path` is not a path a folder may hold, or null. */
export function pathProblem(path: unknown): string | null {
	if (
		typeof path !== 'string' ||
		path === '' ||
		path.length > 1024 ||
		path.startsWith('/') ||
		path.endsWith('/') ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
		/[\0-\x1f\\]/.test(path) ||
		path
			.split('/')
			.some(
				(s) =>
					s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git',
			)
	)
		return 'not a folder path';
	return null;
}
