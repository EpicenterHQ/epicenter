/**
 * One folder's routes (ADR-0824), at `<folders audience>/folders/<folder>/…`
 * (`folderUrl` in `@epicenter/definition/site`), over its log
 * (`../log/`):
 *
 * ```txt
 * GET  changes?since=<cursor>          read   the head, and each path changed since with its version
 * POST files { paths?, at?, bytes? }   read   the files now, or as of a change, a time, or a mark
 * GET  log?after|before|at&path&limit  read   changes, oldest first after a seq, else newest first
 * GET  marks                           read   every mark
 * PUT  marks/<name> { seq?, move? }    write  mark the last change (or `seq`)
 * POST blobs { versions }              read   what the folder holds of each version's bytes
 * POST blobs/missing { versions }      read   the versions it holds no bytes for
 * GET  blobs/<sha256>                  read   one version's bytes, private and immutable
 * PUT  blobs/<sha256>                  write  one version's bytes: idempotent, checked against the hash
 * POST commits { files }               write  one change, each path over the version its writer expects
 * POST import { changes } | { done }   write  an import's changes, with their own authors and times
 * ```
 *
 * A file's version is the SHA-256 of its bytes, for every path. A cursor
 * is `<epoch>.<seq>`. `at` names a change by its seq, a mark, or a time
 * (ISO 8601). `folders.ts` decides each request first.
 *
 * A commit is `{ files }`, each one of `{ path, expect, text }` or
 * `{ path, expect, base64 }` (bytes up to `INLINE_MAX`, which come with
 * it), `{ path, expect, version }` (a version the folder holds, uploaded
 * first or restored), or `{ path, expect, delete: true }`. `expect` is the
 * version the writer read at the path, null for nothing. The server never
 * merges: the change lands only where every path still holds its
 * `expect`, and otherwise nothing lands and it answers
 * `409 { error: 'moved', moved: [{ path, now }] }`, every path that moved.
 * A version it holds no bytes for is `409 missing`; a name differing only
 * in case from one it holds, a file where a folder is, or a file below a
 * file, `409 refused`. The reply is `{ cursor, versions }`: the head, and
 * the version now at each path, null where a delete landed. Writing what a
 * path holds makes no change.
 */
import { isMarkName } from '@epicenter/definition/site';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/create-db.js';
import type { BlobStore } from '../log/blob-store.js';
import { putBlob } from '../log/blobs.js';
import {
	type CommitAnswer,
	type CommitWrite,
	commitChange,
	type Imported,
} from '../log/commit.js';
import { listMarks, seqOfMark, setMark } from '../log/marks.js';
import {
	blobsOf,
	changesSince,
	filesAt,
	missingVersions,
	readLog,
	seqAtTime,
} from '../log/read.js';
import {
	INLINE_MAX,
	pathProblem,
	VERSION,
	writeCursor,
} from '../log/versions.js';

type Runner = Pick<Db, 'execute'>;

/** What a request under a folder asks for. */
export type FolderEndpoint =
	| { kind: 'changes' }
	| { kind: 'files' }
	| { kind: 'log' }
	| { kind: 'marks' }
	| { kind: 'mark'; name: string }
	| { kind: 'blobs' }
	| { kind: 'missing' }
	| { kind: 'blob'; version: string; upload: boolean }
	| { kind: 'commits' }
	| { kind: 'import' };

/** The endpoint `rest` (the path below `folders/<folder>/`) names for `method`, or undefined. */
export function readFolderEndpoint(
	method: string,
	rest: string,
): FolderEndpoint | undefined {
	const routes: Record<string, [string, FolderEndpoint]> = {
		changes: ['GET', { kind: 'changes' }],
		files: ['POST', { kind: 'files' }],
		log: ['GET', { kind: 'log' }],
		marks: ['GET', { kind: 'marks' }],
		blobs: ['POST', { kind: 'blobs' }],
		'blobs/missing': ['POST', { kind: 'missing' }],
		commits: ['POST', { kind: 'commits' }],
		import: ['POST', { kind: 'import' }],
	};
	const route = routes[rest];
	if (route !== undefined) return route[0] === method ? route[1] : undefined;
	const version = /^blobs\/([0-9a-f]{64})$/.exec(rest)?.[1];
	if (version !== undefined)
		return method === 'GET' || method === 'PUT'
			? { kind: 'blob', version, upload: method === 'PUT' }
			: undefined;
	if (rest.startsWith('marks/') && method === 'PUT') {
		let name: string;
		try {
			name = decodeURIComponent(rest.slice('marks/'.length));
		} catch {
			return undefined;
		}
		return { kind: 'mark', name };
	}
	return undefined;
}

/** What `endpoint` does to the folder: read it, or write it. */
export const folderOperation = (endpoint: FolderEndpoint): 'read' | 'push' =>
	endpoint.kind === 'commits' ||
	endpoint.kind === 'import' ||
	endpoint.kind === 'mark' ||
	(endpoint.kind === 'blob' && endpoint.upload)
		? 'push'
		: 'read';

/** The most paths or versions one request may name. */
export const MAX_NAMED = 10_000;
/** The largest commit or import body read; a larger one is refused (413) before it is read whole. */
export const MAX_COMMIT_BYTES = 16 * 1024 * 1024;
/** The most files one change writes. */
export const MAX_FILES = 1000;
/** The most files one imported change writes: a commit's first tree can be large. */
export const MAX_IMPORTED_FILES = 5000;
/** The most changes one import request brings. */
const MAX_IMPORTED = 200;
/** The most changes one log request answers. */
const MAX_LOG = 1000;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		},
	});

const invalid = (message: string, path?: string) =>
	json({ error: 'invalid_request', path, message }, 400);

const unknownFolder = () =>
	json({ error: 'not_found', message: 'no such folder' }, 404);

/**
 * The seq `at` names in `folder`: a whole number is a seq, a mark's name
 * its change, and anything else a time (ISO 8601). Null when it names
 * none.
 */
export async function resolveAt(
	db: Runner,
	folder: string,
	at: string,
): Promise<number | null> {
	if (/^\d{1,15}$/.test(at)) return Number(at);
	if (isMarkName(at)) {
		const marked = await seqOfMark(db, folder, at);
		if (marked !== null) return marked;
	}
	const time = Date.parse(at);
	if (Number.isNaN(time)) return null;
	return seqAtTime(db, folder, new Date(time));
}

/**
 * `GET changes?since=<cursor>`: the head, and each path whose version
 * changed since `since` with its version now, or `changes: null` ("compare
 * every path") without a cursor this log knows or past the gap it answers.
 * A poller asks this every few seconds.
 */
export async function folderChanges(
	db: Runner,
	folder: string,
	since: string | undefined,
): Promise<Response> {
	const answered = await changesSince(db, folder, since);
	if (answered === undefined) return unknownFolder();
	return json({
		cursor: writeCursor(answered.cursor),
		changes: answered.changes,
	});
}

/** `POST files { paths?, at?, bytes? }`: the files now, or as of `at`, with inline bytes when asked. */
export async function folderFiles(
	db: Runner,
	folder: string,
	body: unknown,
): Promise<Response> {
	const { paths, at, bytes } = (body ?? {}) as {
		paths?: unknown;
		at?: unknown;
		bytes?: unknown;
	};
	if (
		paths !== undefined &&
		(!Array.isArray(paths) ||
			paths.length > MAX_NAMED ||
			paths.some((path) => pathProblem(path) !== null))
	)
		return invalid(`paths is a list of at most ${MAX_NAMED} folder paths`);
	if (at !== undefined && typeof at !== 'string')
		return invalid('at is a seq, a mark, or a time');
	if (bytes !== undefined && typeof bytes !== 'boolean')
		return invalid('bytes is true or false');
	let seq: number | undefined;
	if (at !== undefined) {
		const found = await resolveAt(db, folder, at);
		if (found === null)
			return json(
				{ error: 'unknown_at', message: `${at} names no change` },
				404,
			);
		seq = found;
	}
	const listed = await filesAt(db, folder, {
		seq,
		paths: paths as string[] | undefined,
		bytes: bytes === true,
	});
	if (listed === undefined) return unknownFolder();
	return json({
		cursor: writeCursor(listed.cursor),
		seq: listed.seq,
		files: listed.files,
	});
}

/**
 * `GET log`: changes, at most `limit` (50 by default): after `after`
 * oldest first, else at or before `before` (or `at`) newest first. With
 * `path`, only the changes that wrote it: the file's history.
 */
export async function folderLog(
	db: Runner,
	folder: string,
	query: Record<string, string | undefined>,
): Promise<Response> {
	const whole = (value: string | undefined) =>
		value === undefined
			? undefined
			: /^\d{1,15}$/.test(value)
				? Number(value)
				: Number.NaN;
	const limit = whole(query.limit) ?? 50;
	const after = whole(query.after);
	let before = whole(query.before);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOG)
		return invalid(`limit is 1 to ${MAX_LOG}`);
	if (Number.isNaN(after) || Number.isNaN(before))
		return invalid('after and before are seqs');
	if (query.path !== undefined && pathProblem(query.path) !== null)
		return invalid('path is a folder path');
	if (query.at !== undefined) {
		const found = await resolveAt(db, folder, query.at);
		if (found === null)
			return json(
				{ error: 'unknown_at', message: `${query.at} names no change` },
				404,
			);
		before = found;
	}
	const changes = await readLog(db, folder, {
		after,
		before,
		path: query.path,
		limit,
	});
	return json({ changes });
}

/** `GET marks`: every mark of the folder, by name. */
export async function folderMarks(db: Runner, folder: string) {
	return json({ marks: await listMarks(db, folder) });
}

/** `PUT marks/<name> { seq?, move? }`: mark the folder's last change, or `seq`, as `name`. */
export async function putMark(
	db: Runner,
	{
		folder,
		name,
		account,
		body,
	}: { folder: string; name: string; account: string; body: unknown },
): Promise<Response> {
	if (!isMarkName(name))
		return invalid(
			'a mark is letters, digits, ., _ and -, in segments joined by /',
		);
	const { seq, move } = (body ?? {}) as { seq?: unknown; move?: unknown };
	if (seq !== undefined && !Number.isSafeInteger(seq))
		return invalid('seq is a whole number');
	if (move !== undefined && typeof move !== 'boolean')
		return invalid('move is true or false');
	const answer = await setMark(db, {
		folder,
		name,
		account,
		seq: seq as number | undefined,
		move: move === true,
	});
	if ('marked' in answer) return json({ mark: answer.marked });
	if ('taken' in answer)
		return json(
			{
				error: 'taken',
				mark: answer.taken,
				message: `${name} marks change ${answer.taken.seq}; move it to change it`,
			},
			409,
		);
	if ('empty' in answer)
		return json(
			{ error: 'empty', message: 'the folder has no change to mark' },
			409,
		);
	return json(
		{ error: 'unknown_at', message: `no change ${answer.unknown}` },
		404,
	);
}

const versionsOf = (body: unknown): string[] | null => {
	const { versions } = (body ?? {}) as { versions?: unknown };
	return Array.isArray(versions) &&
		versions.length <= MAX_NAMED &&
		versions.every(
			(version) => typeof version === 'string' && VERSION.test(version),
		)
		? (versions as string[])
		: null;
};

/**
 * `POST blobs { versions }`: what the folder holds of each version's
 * bytes, in order: `{ base64 }` kept inline, `{ size }` in the blob store
 * (`GET blobs/<sha256>`), or null for none (never held, or purged).
 */
export async function folderBlobs(
	db: Runner,
	folder: string,
	body: unknown,
): Promise<Response> {
	const versions = versionsOf(body);
	if (versions === null)
		return invalid(`versions is a list of at most ${MAX_NAMED} SHA-256s`);
	return json({ blobs: await blobsOf(db, folder, versions) });
}

/** `POST blobs/missing { versions }`: the versions the folder holds no bytes for, which an upload sends. */
export async function folderMissing(
	db: Runner,
	folder: string,
	body: unknown,
): Promise<Response> {
	const versions = versionsOf(body);
	if (versions === null)
		return invalid(`versions is a list of at most ${MAX_NAMED} SHA-256s`);
	return json({ missing: await missingVersions(db, folder, versions) });
}

/** `GET blobs/<sha256>`: one version's bytes, inline or streamed from the blob store; immutable. */
export async function getBlob(
	db: Runner,
	store: BlobStore | null,
	folder: string,
	version: string,
): Promise<Response> {
	const [held] = await blobsOf(db, folder, [version]);
	const headers = {
		'content-type': 'application/octet-stream',
		'cache-control': 'private, max-age=31536000, immutable',
	};
	if (held != null && 'base64' in held)
		return new Response(Buffer.from(held.base64, 'base64'), { headers });
	const found =
		held == null || store === null ? null : await store.get(folder, version);
	if (found === null)
		return json(
			{ error: 'not_found', message: `no bytes for ${version}` },
			404,
		);
	return new Response(found.body, {
		headers: { ...headers, 'content-length': String(found.size) },
	});
}

/** `PUT blobs/<sha256>`: store one version's bytes (`putBlob`). */
export async function putBlobRoute({
	db,
	store,
	folder,
	version,
	request,
}: {
	db: Runner;
	store: BlobStore | null;
	folder: string;
	version: string;
	request: Request;
}): Promise<Response> {
	if (request.body === null) return invalid('no body');
	const length = request.headers.get('content-length');
	const answer = await putBlob({
		db,
		store,
		folder,
		sha256: version,
		body: request.body,
		length:
			length !== null && /^\d+$/.test(length) ? Number(length) : undefined,
	});
	if ('size' in answer)
		return json({ version, size: answer.size }, answer.status);
	return json({ error: answer.error, message: answer.message }, answer.status);
}

/** The writes of a commit request's `files`, or why they are refused. */
export function readCommitFiles(
	files: unknown,
	most = MAX_FILES,
): CommitWrite[] | { message: string; path?: string } {
	if (!Array.isArray(files) || files.length === 0 || files.length > most)
		return { message: `files: 1 to ${most}` };
	const seen = new Set<string>();
	const out: CommitWrite[] = [];
	for (const file of files as Record<string, unknown>[]) {
		const path = file?.path;
		const problem = pathProblem(path);
		if (problem !== null) return { message: problem, path: String(path) };
		const p = path as string;
		if (seen.has(p)) return { message: 'a path appears twice', path: p };
		seen.add(p);
		const expect = file.expect;
		if (
			expect !== null &&
			(typeof expect !== 'string' || !VERSION.test(expect))
		)
			return {
				message:
					'expect is the version the writer read there, or null for nothing',
				path: p,
			};
		const kinds = ['text', 'base64', 'version', 'delete'].filter(
			(kind) => file[kind] !== undefined,
		);
		if (kinds.length !== 1)
			return {
				message: 'give exactly one of text, base64, version and delete',
				path: p,
			};
		if (file.delete !== undefined) {
			if (file.delete !== true) return { message: 'delete is true', path: p };
			out.push({ path: p, expect, delete: true });
			continue;
		}
		if (file.version !== undefined) {
			if (typeof file.version !== 'string' || !VERSION.test(file.version))
				return { message: 'version is a SHA-256', path: p };
			out.push({ path: p, expect, version: file.version });
			continue;
		}
		let bytes: Uint8Array;
		if (file.text !== undefined) {
			if (typeof file.text !== 'string')
				return { message: 'text is a string', path: p };
			bytes = new TextEncoder().encode(file.text);
		} else {
			if (typeof file.base64 !== 'string')
				return { message: 'base64 is a string', path: p };
			bytes = new Uint8Array(Buffer.from(file.base64, 'base64'));
		}
		if (bytes.byteLength > INLINE_MAX)
			return {
				message: `bytes over ${INLINE_MAX} are put at blobs/<sha256> first, then named by version`,
				path: p,
			};
		out.push({ path: p, expect, bytes });
	}
	return out;
}

/** A commit's answer, as sent. */
function sendCommit(answer: CommitAnswer): Response {
	if ('landed' in answer)
		return json({
			cursor: writeCursor(answer.cursor),
			versions: answer.versions,
		});
	if ('moved' in answer)
		return json(
			{
				error: 'moved',
				moved: answer.moved,
				message: answer.moved
					.map(({ path, now }) => `${path} holds ${now ?? 'nothing'}`)
					.join('; '),
			},
			409,
		);
	if ('missing' in answer)
		return json(
			{
				error: 'missing',
				missing: answer.missing,
				message: 'put these versions at blobs/<sha256>, then commit',
			},
			409,
		);
	if ('refused' in answer) {
		const { path, held, reason } = answer.refused;
		return json(
			{
				error: 'refused',
				path,
				held,
				reason,
				message:
					reason === 'case'
						? `${path} differs only in case from ${held}, which the folder holds: a disk that ignores case cannot keep them apart`
						: reason === 'folder'
							? `${path} is a folder here (it holds ${held})`
							: `${path} is a file here, so nothing can be below it`,
			},
			409,
		);
	}
	return answer.error === 'no_folder'
		? unknownFolder()
		: json(
				{
					error: 'not_importing',
					message: 'this folder takes no imported changes',
				},
				409,
			);
}

/** `POST commits { files }`: one change, as `account` through `via` (see the header). */
export async function folderCommit(
	db: Runner,
	{
		folder,
		account,
		via,
		body,
	}: { folder: string; account: string; via: string; body: unknown },
): Promise<Response> {
	const files = readCommitFiles((body as { files?: unknown } | null)?.files);
	if (!Array.isArray(files)) return invalid(files.message, files.path);
	return sendCommit(await commitChange(db, { folder, account, via, files }));
}

/**
 * `POST import { changes: [{ author, at, message, files }] }`: an import's
 * changes (ADR-0826), each keeping its own author (`Name <email>`), time,
 * and message, landed in order while the folder imports; the answer of
 * the first that did not land ends it. `{ done: true }` ends the import:
 * the folder takes ordinary changes only from then.
 */
export async function folderImport(
	db: Runner,
	{
		folder,
		account,
		via,
		body,
	}: { folder: string; account: string; via: string; body: unknown },
): Promise<Response> {
	const request = (body ?? {}) as { changes?: unknown; done?: unknown };
	if (request.done === true) {
		await db.execute(
			sql`update folder set importing = false where id = ${folder}`,
		);
		return json({ done: true });
	}
	const changes = request.changes;
	if (
		!Array.isArray(changes) ||
		changes.length === 0 ||
		changes.length > MAX_IMPORTED
	)
		return invalid(`changes: 1 to ${MAX_IMPORTED}, or { done: true }`);
	const read: { imported: Imported; files: CommitWrite[] }[] = [];
	for (const change of changes as Record<string, unknown>[]) {
		const { author, at, message } = change ?? {};
		const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
		if (
			typeof author !== 'string' ||
			author.length > 1000 ||
			Number.isNaN(time) ||
			(message !== null && typeof message !== 'string')
		)
			return invalid(
				'each change is { author, at: an ISO time, message, files }',
			);
		const files = readCommitFiles(change.files, MAX_IMPORTED_FILES);
		if (!Array.isArray(files)) return invalid(files.message, files.path);
		read.push({
			imported: { author, at: new Date(time), message },
			files,
		});
	}
	let last: CommitAnswer | null = null;
	for (const { imported, files } of read) {
		last = await commitChange(db, { folder, account, via, files, imported });
		if (!('landed' in last)) return sendCommit(last);
	}
	return sendCommit(last as CommitAnswer);
}
