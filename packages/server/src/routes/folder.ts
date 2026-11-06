/**
 * A folder's repository as sync reaches it (ADR-0808, ADR-0810), in Git's
 * own vocabulary, at `<git>/folders/<folder>/…` (`folderUrl` in
 * `@epicenter/definition/site`, the one address a folder id becomes):
 *
 * ```txt
 * GET  changes?since=<commit>     folders:read   where main is, and the paths whose blob changed since <commit>
 * GET  commits?limit=<n>          folders:read   main's history, newest first, along first parents
 * POST tree    { commit, paths? } folders:read   the blob at each path of <commit>'s tree (every path when none)
 * POST blobs   { ids }            folders:read   many blobs' bytes by id, in one request
 * GET  blobs/<blob id>            folders:read   one blob's bytes
 * GET  blobs/<sha256>             folders:read   an attachment's bytes, streamed, private and immutable
 * PUT  blobs/<sha256>             folders:write  an attachment's bytes: idempotent, checked against the hash
 * POST commits { files }          folders:write  one commit on main, each path over the blob its writer expects
 * POST <git>/folders { name? }    folders:write  a new folder, or the caller's folder of that name: { folder }
 * ```
 *
 * A file's version is its Git blob id (ADR-0808): a note's blob, or an
 * attachment's canonical Git LFS pointer, whose object is the attachment's
 * sha256. An attachment's bytes live apart from Git at `blobs/<sha256>`,
 * one address for every Epicenter client; Git LFS's own protocol stays
 * under the repository's Git remote for plain Git clients.
 *
 * A commit is `{ files }`, each one of `{ path, expect, text }` or
 * `{ path, expect, base64 }` (a note, or a hidden path),
 * `{ path, expect, lfs: { oid, size } }` (an attachment, its bytes already
 * uploaded), or `{ path, expect, delete: true }`. `expect` is the blob id
 * the writer expects at the path, null for nothing. The server never
 * merges: the commit lands only where every path still holds its
 * `expect`, and otherwise nothing lands and it answers
 * `409 { error: 'moved', path, now }` with what the path holds. A path that
 * would differ only in case from one the repository then holds is
 * `409 case_collision`. Each request reads `main`, checks every path, builds
 * one commit, and moves `main` only if it has not moved (the branch updated
 * only where it still points where the writer read), retrying from the
 * check when it has. The reply is `{ commit, blobs }`: the blob id now at
 * each path, null where a delete landed. Writing the bytes a path already
 * holds lands as nothing; a commit that changes nothing makes none.
 *
 * An upload of bytes the repository did not hold is pending in the ledger
 * (`uploads.ts`) until a commit keeps it.
 */
import {
	REPOSITORY_ATTRIBUTES,
	storedWithLfs,
} from '@epicenter/definition/contract';
import { writePointer } from '@epicenter/definition/merge';
import { MAX_POINTER_BYTES, readPointer } from '../git/lfs-rule.js';
import {
	commitObject,
	type GitObjects,
	MAIN,
	makeObject,
	OID,
	type PackObject,
	parseCommit,
	readCommit,
	treeObject,
	ZERO_OID,
} from '../git/objects.js';
import { writePack } from '../git/pack.js';
import {
	CaseCollision,
	type Change,
	diffTrees,
	editTree,
	listFiles,
	treeLookup,
} from '../git/tree-edit.js';
import { LFS_OID, type LfsObject, type LfsStore } from '../lfs/lfs-store.js';
import type { UploadLedger } from '../uploads.js';

/** Why `path` is not a repository path a write may name, or null. */
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
		return 'not a repository path';
	return null;
}

/** What a request under a folder asks for. */
export type FolderEndpoint =
	| { kind: 'changes' }
	| { kind: 'log' }
	| { kind: 'tree' }
	| { kind: 'blobs' }
	| { kind: 'blob'; id: string }
	| { kind: 'attachment'; oid: string; upload: boolean }
	| { kind: 'commits' };

/** The endpoint `rest` (the path below `folders/<folder>/`) names for `method`, or undefined. */
export function readFolderEndpoint(
	method: string,
	rest: string,
): FolderEndpoint | undefined {
	if (rest === 'changes' && method === 'GET') return { kind: 'changes' };
	if (rest === 'commits' && method === 'GET') return { kind: 'log' };
	if (rest === 'tree' && method === 'POST') return { kind: 'tree' };
	if (rest === 'blobs' && method === 'POST') return { kind: 'blobs' };
	if (rest === 'commits' && method === 'POST') return { kind: 'commits' };
	const id = /^blobs\/([0-9a-f]{40}|[0-9a-f]{64})$/.exec(rest)?.[1];
	if (id === undefined) return undefined;
	if (id.length === 40)
		return method === 'GET' ? { kind: 'blob', id } : undefined;
	if (method === 'GET' || method === 'PUT')
		return { kind: 'attachment', oid: id, upload: method === 'PUT' };
	return undefined;
}

/** What `endpoint` does to the repository: read it, or write it. */
export const folderOperation = (endpoint: FolderEndpoint): 'read' | 'push' =>
	endpoint.kind === 'commits' ||
	(endpoint.kind === 'attachment' && endpoint.upload)
		? 'push'
		: 'read';

/** The most paths or ids one request may name. */
export const MAX_NAMED = 10_000;
/** The largest commit body read; a larger one is refused (413) before it is read whole. */
export const MAX_COMMIT_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_ATTEMPTS = 12;

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

/** The bytes as base64, which JSON can carry. */
function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

/**
 * Where `main` is (`commit`, null before the first write), and the paths
 * whose blob differs between the commit `since` names (empty: before the
 * first) and `main`: null when `since` is not given or names no commit this
 * repository holds, so the reader compares every path. A poller asks this
 * every few seconds.
 */
export async function folderChanges(
	objects: GitObjects,
	since: string | undefined,
): Promise<Response> {
	const main = (await objects.refs()).get(MAIN) ?? null;
	if (since === undefined) return json({ commit: main, paths: null });
	if (since !== '' && !OID.test(since))
		return invalid('since is a commit id, or empty for before the first');
	if (since === (main ?? '')) return json({ commit: main, paths: [] });
	const before = since === '' ? null : (await readCommit(objects, since))?.tree;
	if (before === undefined) return json({ commit: main, paths: null });
	const after = main ? ((await readCommit(objects, main))?.tree ?? null) : null;
	return json({ commit: main, paths: await diffTrees(objects, before, after) });
}

/** The most commits one history request answers. */
const MAX_LOG = 1000;

/**
 * `main`'s history, newest first, along first parents: each commit's id,
 * parents, author, time (seconds since the epoch), and message. At most
 * `limit` (default 50, at most `MAX_LOG`).
 */
export async function folderLog(
	objects: GitObjects,
	limit: string | undefined,
): Promise<Response> {
	const most =
		limit === undefined ? 50 : /^\d+$/.test(limit) ? Number(limit) : Number.NaN;
	if (!Number.isSafeInteger(most) || most < 1 || most > MAX_LOG)
		return invalid(`limit is 1 to ${MAX_LOG}`);
	const commits: {
		id: string;
		parents: string[];
		author: string;
		time: number;
		message: string;
	}[] = [];
	let next = (await objects.refs()).get(MAIN) ?? null;
	while (next !== null && commits.length < most) {
		const found = await objects.read(next, 'commit');
		if (!found?.bytes) break;
		const commit = parseCommit(found.bytes);
		const text = new TextDecoder().decode(found.bytes);
		const author = /^author (.*) <[^>]*> (\d+) [+-]\d{4}$/m.exec(text);
		commits.push({
			id: next,
			parents: commit.parents,
			author: author?.[1] ?? '',
			time: Number(author?.[2] ?? 0),
			message: commit.message,
		});
		next = commit.parents[0] ?? null;
	}
	return json({ commits });
}

/** The LFS object the pointer blob `oid` names, or null when it names none. */
async function pointerOf(objects: GitObjects, oid: string) {
	const found = await objects.read(oid, 'blob', {
		maxBytes: MAX_POINTER_BYTES,
	});
	return found?.bytes ? readPointer(found.bytes) : null;
}

/**
 * The tree of `commit` at `paths` (every file when absent): each file's
 * blob id, and for an attachment its object (`oid`) and `size`. A path the
 * tree does not hold is left out. An unknown commit is `404 unknown_commit`.
 */
export async function folderTree(
	objects: GitObjects,
	body: unknown,
): Promise<Response> {
	const { commit, paths } = (body ?? {}) as {
		commit?: unknown;
		paths?: unknown;
	};
	if (typeof commit !== 'string' || !OID.test(commit))
		return invalid('commit is a commit id');
	if (
		paths !== undefined &&
		(!Array.isArray(paths) ||
			paths.length > MAX_NAMED ||
			paths.some((path) => pathProblem(path) !== null))
	)
		return invalid(`paths is a list of at most ${MAX_NAMED} repository paths`);
	const tree = (await readCommit(objects, commit))?.tree;
	if (tree === undefined)
		return json(
			{
				error: 'unknown_commit',
				message: `${commit} is not a commit of this repository`,
			},
			404,
		);
	let found: { path: string; oid: string }[];
	if (paths === undefined) found = await listFiles(objects, tree, '');
	else {
		const lookupIn = treeLookup(objects, tree);
		found = (
			await Promise.all(
				(paths as string[]).map(async (path) => {
					const entry = await lookupIn(path);
					return entry === null ? null : { path, oid: entry.oid };
				}),
			)
		).filter((entry) => entry !== null);
	}
	const entries = await Promise.all(
		found.map(async ({ path, oid }) => {
			if (!storedWithLfs(path)) return { path, blob: oid };
			const pointer = await pointerOf(objects, oid);
			return pointer === null
				? { path, blob: oid }
				: { path, blob: oid, oid: pointer.oid, size: pointer.size };
		}),
	);
	return json({ commit, entries });
}

/** Many blobs' bytes, by id, in the request's order: base64, or null for a blob the repository does not hold. */
export async function folderBlobs(
	objects: GitObjects,
	body: unknown,
): Promise<Response> {
	const { ids } = (body ?? {}) as { ids?: unknown };
	if (
		!Array.isArray(ids) ||
		ids.length > MAX_NAMED ||
		ids.some((id) => typeof id !== 'string' || !OID.test(id))
	)
		return invalid(`ids is a list of at most ${MAX_NAMED} blob ids`);
	const blobs = await Promise.all(
		(ids as string[]).map(async (id) => {
			const found = await objects.read(id, 'blob');
			return found?.bytes ? toBase64(found.bytes) : null;
		}),
	);
	return json({ blobs });
}

/** One blob's bytes, by id: immutable, so a browser keeps it. */
export async function folderBlob(
	objects: GitObjects,
	id: string,
): Promise<Response> {
	const found = await objects.read(id, 'blob');
	if (!found?.bytes)
		return json({ error: 'not_found', message: `no blob ${id}` }, 404);
	return new Response(found.bytes as Uint8Array<ArrayBuffer>, {
		headers: {
			'content-type': 'application/octet-stream',
			'cache-control': 'private, max-age=31536000, immutable',
		},
	});
}

/** An attachment's bytes, by its sha256, streamed from storage: immutable, so a browser keeps it. */
export async function getAttachment(
	lfs: LfsStore,
	repositoryId: string,
	oid: string,
): Promise<Response> {
	const found = await lfs.get(repositoryId, oid);
	if (found === null)
		return json({ error: 'not_found', message: `no attachment ${oid}` }, 404);
	return new Response(found.body, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(found.size),
			'cache-control': 'private, max-age=31536000, immutable',
		},
	});
}

/**
 * Store an attachment's bytes as `oid`, refusing bytes that are not `oid`:
 * idempotent, so a lost reply is sent again. Bytes the repository did not
 * already hold are pending in `ledger` until a commit keeps them.
 */
export async function putAttachment({
	lfs,
	ledger,
	repositoryId,
	oid,
	request,
}: {
	lfs: LfsStore;
	ledger: UploadLedger | null;
	repositoryId: string;
	oid: string;
	request: Request;
}): Promise<Response> {
	if (!LFS_OID.test(oid)) return invalid('not a sha256');
	if (request.body === null) return invalid('no body');
	const length = request.headers.get('content-length');
	const size =
		length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
	const held =
		size !== undefined && (await lfs.verified(repositoryId, { oid, size }));
	if (held) {
		await request.body.cancel();
		return json({ oid, size });
	}
	const stored = await lfs.put(repositoryId, oid, request.body, size);
	if (!stored.ok)
		return json(
			{
				error: stored.reason,
				message:
					stored.reason === 'hash-mismatch'
						? `the bytes' sha256 is not ${oid}`
						: stored.reason === 'size-mismatch'
							? 'the bytes are not the declared length'
							: 'the attachment is too large',
			},
			stored.reason === 'too-large' ? 413 : 422,
		);
	await ledger?.pending(repositoryId, oid);
	return json({ oid, size: stored.size }, 201);
}

/** One file of a commit, as read from its request. */
export type CommitFile =
	| { path: string; expect: string | null; bytes: Uint8Array }
	| { path: string; expect: string | null; lfs: LfsObject }
	| { path: string; expect: string | null; delete: true };

/** The commit request in `body`: its files, or why it is refused. */
export function readCommitRequest(
	body: unknown,
): CommitFile[] | { message: string; path?: string } {
	if (typeof body !== 'object' || body === null)
		return { message: 'expected a JSON object' };
	const { files } = body as { files?: unknown };
	if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES)
		return { message: `files: 1 to ${MAX_FILES}` };
	const seen = new Set<string>();
	const out: CommitFile[] = [];
	for (const file of files as Record<string, unknown>[]) {
		const path = file?.path;
		const problem = pathProblem(path);
		if (problem !== null) return { message: problem, path: String(path) };
		const p = path as string;
		if (seen.has(p)) return { message: 'a path appears twice', path: p };
		seen.add(p);
		const expect = file.expect;
		if (expect !== null && (typeof expect !== 'string' || !OID.test(expect)))
			return {
				message:
					'expect is the blob id the writer expects there, or null for nothing',
				path: p,
			};
		const kinds = ['text', 'base64', 'lfs', 'delete'].filter(
			(kind) => file[kind] !== undefined,
		);
		if (kinds.length !== 1)
			return {
				message: 'give exactly one of text, base64, lfs and delete',
				path: p,
			};
		if (file.delete !== undefined) {
			if (file.delete !== true) return { message: 'delete is true', path: p };
			out.push({ path: p, expect, delete: true });
			continue;
		}
		if (file.lfs !== undefined) {
			const lfs = file.lfs as LfsObject;
			if (
				typeof lfs !== 'object' ||
				lfs === null ||
				typeof lfs.oid !== 'string' ||
				!LFS_OID.test(lfs.oid) ||
				!Number.isSafeInteger(lfs.size) ||
				lfs.size < 0
			)
				return { message: 'lfs is { oid: 64 hex digits, size }', path: p };
			if (!storedWithLfs(p))
				return {
					message: 'a .md note or a hidden path is bytes, not an attachment',
					path: p,
				};
			out.push({ path: p, expect, lfs: { oid: lfs.oid, size: lfs.size } });
			continue;
		}
		if (storedWithLfs(p))
			return {
				message:
					'files other than .md notes are attachments: upload the bytes, then send lfs',
				path: p,
			};
		if (file.text !== undefined) {
			if (typeof file.text !== 'string')
				return { message: 'text is a string', path: p };
			out.push({ path: p, expect, bytes: new TextEncoder().encode(file.text) });
			continue;
		}
		if (typeof file.base64 !== 'string')
			return { message: 'base64 is a string', path: p };
		out.push({
			path: p,
			expect,
			bytes: new Uint8Array(Buffer.from(file.base64, 'base64')),
		});
	}
	return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Land `files` in one commit on `main` (see the header), as `author`.
 * `hold` (tests only) waits after reading `main` on the first attempt, so
 * two commits can be made to race.
 */
export async function folderCommit({
	objects,
	lfs,
	ledger,
	repositoryId,
	files,
	author,
	now = () => new Date(),
	hold,
}: {
	objects: GitObjects;
	lfs: LfsStore | null;
	ledger: UploadLedger | null;
	repositoryId: string;
	files: CommitFile[];
	author: { name: string; email: string };
	now?: () => Date;
	hold?: () => Promise<void>;
}): Promise<Response> {
	const attachments = files.flatMap((file) => ('lfs' in file ? [file] : []));
	// Kept before it is checked, so a sweep that runs meanwhile finds no row.
	await ledger?.keep(
		repositoryId,
		attachments.map(({ lfs: { oid } }) => oid),
	);
	for (const file of attachments) {
		const stored = lfs !== null && (await lfs.verified(repositoryId, file.lfs));
		if (!stored)
			return json(
				{
					error: 'not_uploaded',
					path: file.path,
					message: `put ${file.lfs.oid} at blobs/${file.lfs.oid}, then commit`,
				},
				409,
			);
	}
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const main = (await objects.refs()).get(MAIN) ?? ZERO_OID;
		if (attempt === 1) await hold?.();
		const root =
			main === ZERO_OID
				? null
				: ((await readCommit(objects, main))?.tree ?? null);
		const lookupIn = treeLookup(objects, root);
		const changes = new Map<string, Change>();
		const blobs: PackObject[] = [];
		const landed: Record<string, string | null> = {};
		for (const file of files) {
			const now = (await lookupIn(file.path))?.oid ?? null;
			if (now !== file.expect)
				return json(
					{
						error: 'moved',
						path: file.path,
						now,
						message: `${file.path} holds ${now ?? 'nothing'}, not ${file.expect ?? 'nothing'}`,
					},
					409,
				);
			if ('delete' in file) {
				if (now !== null) changes.set(file.path, null);
				landed[file.path] = null;
				continue;
			}
			const blob = makeObject(
				'blob',
				'lfs' in file ? writePointer(file.lfs) : file.bytes,
			);
			landed[file.path] = blob.oid;
			// The bytes already there land as nothing.
			if (blob.oid === now) continue;
			blobs.push(blob);
			changes.set(file.path, { oid: blob.oid, mode: '100644' });
		}
		// A repository's first commit holds the standard attributes, so a
		// clone of it runs Git LFS, unless the commit brings its own.
		if (
			main === ZERO_OID &&
			changes.size > 0 &&
			!changes.has('.gitattributes')
		) {
			const attributes = makeObject('blob', REPOSITORY_ATTRIBUTES);
			blobs.push(attributes);
			changes.set('.gitattributes', { oid: attributes.oid, mode: '100644' });
		}
		let next = main;
		const written: PackObject[] = [...blobs];
		if (changes.size > 0) {
			let tree: string | null;
			try {
				tree = await editTree(objects, root, changes, written);
			} catch (cause) {
				if (cause instanceof CaseCollision)
					return json(
						{
							error: 'case_collision',
							path: cause.path,
							held: cause.held,
							message: cause.message,
						},
						409,
					);
				return json(
					{
						error: 'invalid_request',
						message:
							cause instanceof Error
								? cause.message
								: 'the paths do not fit the tree',
					},
					409,
				);
			}
			if (tree === null) {
				const empty = treeObject([]);
				written.push(empty);
				tree = empty.oid;
			}
			if (tree !== root) {
				const subject = `Sync: ${files.length} file${files.length === 1 ? '' : 's'}`;
				const commit = commitObject({
					tree,
					parents: main === ZERO_OID ? [] : [main],
					author: { ...author, at: now() },
					message: `${subject}\n`,
				});
				written.push(commit);
				next = commit.oid;
			}
		}
		const receipt = { commit: next === ZERO_OID ? null : next, blobs: landed };
		// Nothing changed (the bytes already there): no commit.
		if (next === main) return json(receipt);
		const applied = await objects.apply(
			[{ ref: MAIN, old: main, next }],
			writePack(written),
		);
		if (applied.ok) return json(receipt);
		if (!applied.stale)
			throw new Error(`the store refused a commit: ${applied.reason}`);
		await sleep(10 + Math.random() * 40 * attempt);
	}
	return json({ error: 'busy', message: 'main kept moving; try again' }, 503);
}
