/**
 * The write translator (decisions 14, 47, 68, ADR-0773): the web reads and
 * writes a repository's files through these, and never holds a copy of it.
 *
 * ```txt
 * GET  <git>/<ns>/<name>.git/epicenter/changes?since=<commit>  folders:read   the commit main is at, and the paths changed since
 * GET  <git>/<ns>/<name>.git/epicenter/files?root=<dir>&…       folders:read   every file under each <dir>
 * POST <git>/<ns>/<name>.git/epicenter/read                     folders:read   the files at { paths, at? }, in one request
 * POST <git>/<ns>/<name>.git/epicenter/writes                   folders:write  one commit
 * ```
 *
 * A write is `{ root?, files }`, each file one of
 * `{ path, text, base }` (a note, or a hidden path such as `.gitattributes`),
 * `{ path, lfs: { oid, size }, base }` (any other file, whose LFS object
 * must already be uploaded and verified), or `{ path, delete: true, base }`.
 * Paths are repository-relative and must lie under `root` when it is given.
 * A body is at most `MAX_WRITE_BYTES` (16 MiB).
 *
 * `base` is what the writer read at the path: the Git blob id, or null for
 * nothing. The server never merges: a file lands only while the path still
 * holds its `base`, and otherwise the whole write is refused, `409 occupied`
 * for a create where a file is and `409 stale` for a path that moved since
 * its writer read it. The writer then reads what is there and writes again
 * over it, so every merge runs on the computer of the person writing.
 *
 * Each request reads `main`, checks every file's `base` against it, builds
 * one commit, and moves `main` only if it has not moved, retrying from the
 * check when it has, so the check and the move are one step.
 *
 * The first commit of a repository also holds `REPOSITORY_ATTRIBUTES` as
 * `.gitattributes` (decision 59), unless the write brings its own, so a
 * desktop clone of a repository the web made runs Git LFS.
 *
 * The reply is `{ commit, paths, blobs }`: each file's path and the Git
 * blob id there, null where a delete landed. Writing the bytes a path
 * already holds lands as nothing, and a request that changes nothing makes
 * no commit. The server keeps nothing about a request once it answers
 * (decision 68): a resend after a lost reply is judged like any write, and
 * its writer, reading what is there, finds its own bytes.
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
	type PackObject,
	readCommit,
	treeObject,
	ZERO_OID,
} from '../git/objects.js';
import { writePack } from '../git/pack.js';
import {
	type Change,
	diffTrees,
	editTree,
	listFiles,
	lookup,
	treeLookup,
} from '../git/tree-edit.js';
import { LFS_OID, type LfsObject, type LfsStore } from '../lfs/lfs-store.js';

const OID = /^[0-9a-f]{40}$/;
const MAX_FILES = 1000;
/** The largest web write body read; a larger one is refused (413) before it is read whole. */
export const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 12;
const decoder = new TextDecoder();

/**
 * A JSON reply, compressed on its way out by the host: Cloudflare's edge for
 * the Worker, `compress()` for the Bun entry. Both compress only a
 * compressible type, and neither touches a reply marked `no-transform`.
 */
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		},
	});

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

/** Whether `path` lies under `root` (`''`: anywhere). */
const under = (root: string, path: string) =>
	root === '' || path.startsWith(`${root}/`);

/** `root` as given, or null when it is not a folder path. */
function readRoot(root: unknown): string | null {
	if (root === undefined || root === null || root === '') return '';
	return pathProblem(root) === null ? (root as string) : null;
}

export type FileWrite =
	| { path: string; text: string; base: string | null }
	| { path: string; lfs: LfsObject; base: string | null }
	| { path: string; delete: true; base: string };

export type WriteRequest = {
	root?: string;
	files: FileWrite[];
};

export type Receipt = {
	commit: string;
	/** Each file's path, in the request's order. */
	paths: string[];
	/** The Git blob id at each path, the `base` of a later write; null where a delete landed. */
	blobs: Record<string, string | null>;
	attempts?: number;
};

type Refusal = {
	status: 400;
	error: string;
	path?: string;
	message: string;
};

/** The request in `body`, or why it is refused. */
export function readWriteRequest(body: unknown): WriteRequest | Refusal {
	const bad = (message: string, path?: string): Refusal => ({
		status: 400,
		error: 'invalid_write',
		path,
		message,
	});
	if (typeof body !== 'object' || body === null)
		return bad('expected a JSON object');
	const { root, files } = body as Record<string, unknown>;
	const folder = readRoot(root);
	if (folder === null) return bad('root is not a folder path');
	if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES)
		return bad(`files: 1 to ${MAX_FILES}`);
	const seen = new Set<string>();
	for (const file of files as Record<string, unknown>[]) {
		const path = file?.path;
		const problem = pathProblem(path);
		if (problem !== null) return bad(problem, String(path));
		const p = path as string;
		if (!under(folder, p)) return bad(`${p} is outside ${folder}`, p);
		if (seen.has(p)) return bad('a path appears twice', p);
		seen.add(p);
		if (
			file.base !== null &&
			(typeof file.base !== 'string' || !OID.test(file.base))
		)
			return bad('base is the Git blob id read there, or null for nothing', p);
		const kinds = ['text', 'lfs', 'delete'].filter(
			(k) => file[k] !== undefined,
		);
		if (kinds.length !== 1)
			return bad('give exactly one of text, lfs and delete', p);
		if (file.delete !== undefined) {
			if (file.delete !== true) return bad('delete is true', p);
			if (typeof file.base !== 'string')
				return bad('a delete names the base it read', p);
		} else if (file.text !== undefined) {
			if (typeof file.text !== 'string') return bad('text is a string', p);
			if (storedWithLfs(p))
				return bad(
					'files other than .md notes are stored with Git LFS: send lfs',
					p,
				);
		} else {
			const lfs = file.lfs as LfsObject;
			if (
				typeof lfs !== 'object' ||
				lfs === null ||
				typeof lfs.oid !== 'string' ||
				!LFS_OID.test(lfs.oid) ||
				!Number.isSafeInteger(lfs.size) ||
				lfs.size < 0
			)
				return bad('lfs is { oid: 64 hex digits, size }', p);
			if (!storedWithLfs(p))
				return bad('a .md note or a hidden path is text, not LFS', p);
		}
	}
	return {
		root: folder,
		files: files as FileWrite[],
	};
}

async function readText(
	objects: GitObjects,
	oid: string,
): Promise<string | null> {
	const found = await objects.read(oid, 'blob');
	return found?.bytes ? decoder.decode(found.bytes) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Apply one write request to the repository. `author` names who the commit
 * is by. `hold` (tests only) waits after reading `main` on the first
 * attempt, so two writes can be made to race.
 */
export async function applyWrite({
	objects,
	lfs,
	repositoryId,
	request,
	author,
	now = () => new Date(),
	hold,
}: {
	objects: GitObjects;
	lfs: LfsStore | null;
	repositoryId: string;
	request: WriteRequest;
	author: { name: string; email: string };
	now?: () => Date;
	hold?: () => Promise<void>;
}): Promise<Response> {
	// A pointer is admitted only when its object is stored and verified.
	for (const file of request.files)
		if ('lfs' in file) {
			const stored =
				lfs !== null && (await lfs.verified(repositoryId, file.lfs));
			if (!stored)
				return json(
					{
						error: 'lfs_not_uploaded',
						path: file.path,
						message: `upload ${file.lfs.oid} through the LFS batch API, then write`,
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
		const changes = new Map<string, Change>();
		const blobs: PackObject[] = [];
		const landedBlobs: Record<string, string | null> = {};

		for (const file of request.files) {
			const current = (await lookup(objects, root, file.path))?.oid ?? null;
			if (current !== file.base)
				return json(
					file.base === null
						? {
								error: 'occupied',
								path: file.path,
								message: `${file.path} is already on main`,
							}
						: {
								error: 'stale',
								path: file.path,
								message: `${file.path} changed since ${file.base} was read`,
							},
					409,
				);
			if ('delete' in file) {
				changes.set(file.path, null);
				landedBlobs[file.path] = null;
				continue;
			}
			const blob = makeObject(
				'blob',
				'lfs' in file ? writePointer(file.lfs) : file.text,
			);
			landedBlobs[file.path] = blob.oid;
			// The bytes already there land as nothing.
			if (blob.oid === current) continue;
			blobs.push(blob);
			changes.set(file.path, { oid: blob.oid, mode: '100644' });
		}

		const paths = request.files.map((file) => file.path);
		// A repository's first commit holds the standard attributes
		// (decision 59), unless the write brings its own.
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
				return json(
					{
						error: 'invalid_write',
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
				const subject = `Web write: ${paths.length} file${paths.length === 1 ? '' : 's'}`;
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
		const result: Receipt = {
			commit: next,
			paths,
			blobs: landedBlobs,
			attempts: attempt,
		};
		// Nothing changed (the bytes already there): no commit.
		if (next === main) return json(result);
		const applied = await objects.apply(
			[{ ref: MAIN, old: main, next }],
			writePack(written),
		);
		if (applied.ok) return json(result);
		if (!applied.stale)
			throw new Error(`the store refused a web write: ${applied.reason}`);
		await sleep(10 + Math.random() * 40 * attempt);
	}
	return json({ error: 'busy', message: 'main kept moving; try again' }, 503);
}

/**
 * Every file at or below each of `roots` (a folder or a file path; `''`
 * or none: the whole repository), with each pointer's LFS object, all from
 * one commit of `main`.
 */
export async function listRepositoryFiles(
	objects: GitObjects,
	roots: readonly unknown[],
): Promise<Response> {
	const folders = (roots.length === 0 ? [''] : roots).map(readRoot);
	if (folders.some((folder) => folder === null))
		return json(
			{ error: 'invalid_request', message: 'root is not a folder path' },
			400,
		);
	const main = (await objects.refs()).get(MAIN);
	if (main === undefined) return json({ commit: null, files: [] });
	const tree = (await readCommit(objects, main))?.tree ?? null;
	const wanted = [...new Set(folders as string[])].filter(
		(folder, _, all) =>
			!all.some(
				(other) => other !== folder && (other === '' || under(other, folder)),
			),
	);
	const entries: { oid: string; path: string }[] = [];
	for (const folder of wanted) {
		const file = folder === '' ? null : await lookup(objects, tree, folder);
		if (file !== null) entries.push({ oid: file.oid, path: folder });
		else entries.push(...(await listFiles(objects, tree, folder)));
	}
	const files = await Promise.all(
		entries.map(async ({ path, oid }) => {
			if (!storedWithLfs(path)) return { path, blob: oid };
			const pointer = await readLfsPointer(objects, oid);
			return pointer ? { path, blob: oid, lfs: pointer } : { path, blob: oid };
		}),
	);
	return json({ commit: main, files });
}

/** The LFS object the pointer blob `oid` names, or null when it names none. */
async function readLfsPointer(objects: GitObjects, oid: string) {
	const found = await objects.read(oid, 'blob', {
		maxBytes: MAX_POINTER_BYTES,
	});
	return found?.bytes ? readPointer(found.bytes) : null;
}

/** The most paths one read request may name. */
export const MAX_READ_PATHS = 10_000;

/**
 * The files at `paths` on one commit, in the request's order: each note's
 * text, each other file's LFS object, or `gone` where nothing is. One
 * request answers a folder's contents (ADR-0779). The commit is `main`, or
 * `at` when the body names one: a sync reads a note's base where both
 * sides last agreed (ADR-0803). An `at` this repository does not hold is
 * `404 unknown_commit`.
 */
export async function readRepositoryFiles(
	objects: GitObjects,
	body: unknown,
): Promise<Response> {
	const { paths, at } = (body ?? {}) as { paths?: unknown; at?: unknown };
	if (
		!Array.isArray(paths) ||
		paths.length > MAX_READ_PATHS ||
		paths.some((path) => pathProblem(path) !== null)
	)
		return json(
			{
				error: 'invalid_request',
				message: `paths is a list of at most ${MAX_READ_PATHS} repository paths`,
			},
			400,
		);
	if (at != null && (typeof at !== 'string' || !OID.test(at)))
		return json(
			{ error: 'invalid_request', message: 'at is a commit id' },
			400,
		);
	const commit =
		typeof at === 'string' ? at : ((await objects.refs()).get(MAIN) ?? null);
	const tree = commit
		? ((await readCommit(objects, commit))?.tree ?? undefined)
		: null;
	if (tree === undefined)
		return json(
			{
				error: 'unknown_commit',
				message: `${commit} is not a commit of this repository`,
			},
			404,
		);
	const lookupIn = treeLookup(objects, tree);
	const files = await Promise.all(
		(paths as string[]).map(async (path) => {
			const entry = await lookupIn(path);
			if (!entry) return { path, gone: true };
			if (storedWithLfs(path))
				return {
					path,
					blob: entry.oid,
					lfs: await readLfsPointer(objects, entry.oid),
				};
			return {
				path,
				blob: entry.oid,
				text: await readText(objects, entry.oid),
			};
		}),
	);
	return json({ commit, files });
}

/**
 * Where `main` is (`commit`, null before the first write), and the paths
 * that changed since the commit `since` names: every path whose blob
 * differs between the two trees. `paths` is null when `since` is not
 * given, or names no commit this repository holds, so the reader takes a
 * new listing; `[]` when `main` is still there. A poller asks this every
 * few seconds (ADR-0778).
 */
export async function readRepositoryChanges(
	objects: GitObjects,
	since: unknown,
): Promise<Response> {
	const main = (await objects.refs()).get(MAIN) ?? null;
	if (since === undefined || since === null)
		return json({ commit: main, paths: null });
	const from = since === '' ? null : String(since);
	if (from === main) return json({ commit: main, paths: [] });
	if (from !== null && !OID.test(from))
		return json(
			{ error: 'invalid_request', message: 'since is a commit id' },
			400,
		);
	const before =
		from === null
			? null
			: ((await readCommit(objects, from))?.tree ?? undefined);
	if (before === undefined) return json({ commit: main, paths: null });
	const after = main ? ((await readCommit(objects, main))?.tree ?? null) : null;
	return json({ commit: main, paths: await diffTrees(objects, before, after) });
}
