/**
 * The write translator (decisions 14, 15, 47, 50): the web reads and writes
 * a repository's files through these, and never holds a copy of it.
 *
 * ```txt
 * GET  <git>/<ns>/<name>.git/epicenter/files?root=<dir>   folders:read   every file under <dir>
 * GET  <git>/<ns>/<name>.git/epicenter/file?path=<path>   folders:read   one file
 * POST <git>/<ns>/<name>.git/epicenter/writes             folders:write  one commit
 * ```
 *
 * A write is `{ captureId?, root?, files }`, each file one of
 * `{ path, text, base? }` (a note, or a hidden path such as `.gitattributes`),
 * `{ path, lfs: { oid, size }, base? }` (any other file, whose LFS object
 * must already be uploaded and verified), or `{ path, delete: true, base }`.
 * Paths are repository-relative and must lie under `root` when it is given.
 * `base` is the Git blob id the writer read; without it a write is a create.
 *
 * Each request reads `main`, settles every file against it, builds one
 * commit, and moves `main` only if it has not moved, retrying when it has:
 *
 * - a note merges with `settle` (phase 1): front matter by key, the later
 *   arrival winning a key both changed; the body by line, one conflict
 *   block per clash; the incoming note's key order kept and other keys
 *   appended (decision 47), since the server holds no contract;
 * - any other file lands by compare-and-swap (`settlePointer`), and a
 *   racing replace lands beside it as a conflict copy (`conflictSibling`);
 * - an edit beats a delete.
 *
 * The first commit of a repository also holds `REPOSITORY_ATTRIBUTES` as
 * `.gitattributes` (decision 59), unless the write brings its own, so a
 * desktop clone of a repository the web made runs Git LFS.
 *
 * The reply is the receipt `{ commit, paths, blobs, outcomes }`. A write
 * with a `captureId` moves `refs/epicenter/captures/<id>` with `main`, in
 * one transaction, and its commit records the request's fingerprint (each
 * path and its content: `requestDigest`). While that commit is on `main`, a
 * replay of the same files with the same content returns the original
 * receipt, and a replay with other files or content (an edit made after a
 * lost reply, an id reused) is refused, 409 `CaptureMismatch`, carrying the
 * original receipt: the landed paths and their blob ids, over which the
 * device sends its edit as an ordinary update. A capture whose commit left
 * `main` lands again as a create (decision 50), which is nothing when its
 * files are already there. A capture ref at a commit that records no
 * fingerprint (a capture that changed nothing) is no receipt: the request
 * runs as a write.
 */

import { createHash } from 'node:crypto';
import {
	REPOSITORY_ATTRIBUTES,
	storedWithLfs,
} from '@epicenter/definition/contract';
import {
	conflictSibling,
	settle,
	settlePointer,
	writePointer,
} from '@epicenter/definition/merge';
import { parseRowSource } from '@epicenter/definition/note';
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
import { type Change, editTree, listFiles, lookup } from '../git/tree-edit.js';
import { LFS_OID, type LfsObject, type LfsStore } from '../lfs/lfs-store.js';

const CAPTURE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OID = /^[0-9a-f]{40}$/;
const MAX_FILES = 1000;
const MAX_ATTEMPTS = 12;
const decoder = new TextDecoder();

export const captureRef = (id: string) => `refs/epicenter/captures/${id}`;

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
	| { path: string; text: string; base?: string }
	| { path: string; lfs: LfsObject; base?: string }
	| { path: string; delete: true; base: string };

export type WriteRequest = {
	captureId?: string;
	root?: string;
	files: FileWrite[];
};

export type Outcome =
	| 'written'
	| 'merged'
	| 'conflict'
	| 'conflict-copy'
	| 'unchanged'
	| 'deleted'
	| 'kept';

export type Receipt = {
	commit: string;
	/** Where each file of the request landed (a conflict copy's own path), in order. */
	paths: string[];
	/** The Git blob id at each landed path, the `base` of a later write; null where a delete landed. */
	blobs: Record<string, string | null>;
	outcomes: { path: string; landed: string; outcome: Outcome }[];
	replayed?: true;
	attempts?: number;
};

type Refusal = {
	status: 400 | 409;
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
	const { captureId, root, files } = body as Record<string, unknown>;
	if (
		captureId !== undefined &&
		(typeof captureId !== 'string' || !CAPTURE_ID.test(captureId))
	)
		return bad('captureId is 1 to 64 of A-Z, a-z, 0-9, _ and -');
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
			file.base !== undefined &&
			(typeof file.base !== 'string' || !OID.test(file.base))
		)
			return bad('base is a Git blob id', p);
		const kinds = ['text', 'lfs', 'delete'].filter(
			(k) => file[k] !== undefined,
		);
		if (kinds.length !== 1)
			return bad('give exactly one of text, lfs and delete', p);
		if (file.delete !== undefined) {
			if (file.delete !== true) return bad('delete is true', p);
			if (file.base === undefined)
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
		captureId: captureId as string | undefined,
		root: folder,
		files: files as FileWrite[],
	};
}

async function readText(
	objects: GitObjects,
	oid: string,
): Promise<string | null> {
	const found = await objects.read(oid);
	return found?.kind === 'blob' && found.bytes
		? decoder.decode(found.bytes)
		: null;
}

/**
 * A request's fingerprint: each path with its content (a text's Git blob
 * id, an LFS object's oid and size, or a delete), in path order. Two
 * requests with one fingerprint would land the same bytes at the same paths.
 */
export function requestDigest(files: FileWrite[]): string {
	const lines = files
		.map((file) => {
			const content =
				'delete' in file
					? 'delete'
					: 'lfs' in file
						? `lfs ${file.lfs.oid} ${file.lfs.size}`
						: `blob ${makeObject('blob', file.text).oid}`;
			return `${file.path}\0${content}`;
		})
		.sort();
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * The receipt a capture's commit records, read back from its trailers, with
 * the fingerprint of the request that landed it; null when the commit
 * records none.
 */
async function receiptOf(
	objects: GitObjects,
	commit: string,
): Promise<{ receipt: Receipt; digest: string } | null> {
	const found = await readCommit(objects, commit);
	if (!found) return null;
	const digest = found.message.match(
		/^Epicenter-Request: ([0-9a-f]{64})$/m,
	)?.[1];
	if (digest === undefined) return null;
	const paths = [...found.message.matchAll(/^Epicenter-Path: (.+)$/gm)].map(
		(m) => m[1] as string,
	);
	const blobs: Record<string, string | null> = {};
	for (const path of paths)
		blobs[path] = (await lookup(objects, found.tree, path))?.oid ?? null;
	return {
		digest,
		receipt: {
			commit,
			paths,
			blobs,
			outcomes: paths.map((path) => ({
				path,
				landed: path,
				outcome: 'unchanged',
			})),
			replayed: true,
		},
	};
}

/** The house-style key order of `text`'s own front matter, when it parses. */
function incomingKeys(text: string): readonly string[] | undefined {
	const parsed = parseRowSource(text);
	return parsed.error === null ? parsed.data.keyOrder : undefined;
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
	const capture = request.captureId ? captureRef(request.captureId) : null;
	const digest = capture === null ? null : requestDigest(request.files);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const refs = await objects.refs();
		const main = refs.get(MAIN) ?? ZERO_OID;
		const receipt = capture ? refs.get(capture) : undefined;
		if (
			receipt !== undefined &&
			digest !== null &&
			main !== ZERO_OID &&
			(await objects.isAncestor(receipt, main))
		) {
			const original = await receiptOf(objects, receipt);
			if (original?.digest === digest) return json(original.receipt);
			if (original)
				return json(
					{
						error: 'CaptureMismatch',
						message: `capture ${request.captureId} already landed other files or bytes; write the change as an update over the receipt's blobs`,
						receipt: original.receipt,
					},
					409,
				);
		}
		if (attempt === 1) await hold?.();
		const root =
			main === ZERO_OID
				? null
				: ((await readCommit(objects, main))?.tree ?? null);
		const at = now();
		const parties = {
			current: { author: 'main', time: at.toISOString() },
			incoming: { author: 'web', time: at.toISOString() },
		};
		const changes = new Map<string, Change>();
		const blobs: PackObject[] = [];
		const outcomes: Receipt['outcomes'] = [];
		const landedBlobs: Record<string, string | null> = {};
		let merged = false;

		const land = (path: string, text: string | null) => {
			if (text === null) {
				changes.set(path, null);
				landedBlobs[path] = null;
				return;
			}
			const blob = makeObject('blob', text);
			blobs.push(blob);
			changes.set(path, { oid: blob.oid, mode: '100644' });
			landedBlobs[path] = blob.oid;
		};

		for (const file of request.files) {
			const current = await lookup(objects, root, file.path);
			const currentText = current ? await readText(objects, current.oid) : null;
			let baseText: string | null = null;
			if (file.base !== undefined) {
				baseText = await readText(objects, file.base);
				if (baseText === null)
					return json(
						{
							error: 'base_not_found',
							path: file.path,
							message: `${file.base} is not a blob of this repository`,
						},
						409,
					);
			}
			const unchanged = (outcome: Outcome) => {
				outcomes.push({ path: file.path, landed: file.path, outcome });
				landedBlobs[file.path] = current?.oid ?? null;
			};

			if ('lfs' in file || !file.path.endsWith('.md')) {
				// Every file that is not a note: compare-and-swap, never a merge.
				const incoming =
					'lfs' in file
						? writePointer(file.lfs)
						: 'delete' in file
							? null
							: file.text;
				const settled = settlePointer(baseText, currentText, incoming);
				if ('text' in settled) {
					if (settled.text === currentText)
						unchanged(
							incoming === null && currentText !== null ? 'kept' : 'unchanged',
						);
					else {
						land(file.path, settled.text);
						outcomes.push({
							path: file.path,
							landed: file.path,
							outcome: settled.text === null ? 'deleted' : 'written',
						});
					}
					continue;
				}
				if (!('lfs' in file))
					return json(
						{
							error: 'conflict',
							path: file.path,
							current: current?.oid ?? null,
							message: `${file.path} changed since base; read it and write again`,
						},
						409,
					);
				const sibling = conflictSibling(file.path, file.lfs.oid);
				const there = await lookup(objects, root, sibling);
				const pointer = makeObject('blob', incoming as string);
				if (there?.oid === pointer.oid) landedBlobs[sibling] = pointer.oid;
				else land(sibling, incoming);
				outcomes.push({
					path: file.path,
					landed: sibling,
					outcome: 'conflict-copy',
				});
				continue;
			}

			// A note.
			const incoming = 'delete' in file ? null : file.text;
			const settled = settle(baseText, currentText, incoming, {
				parties,
				keys: incoming === null ? undefined : incomingKeys(incoming),
			});
			if (settled.text === currentText) {
				unchanged(
					incoming === null && currentText !== null ? 'kept' : 'unchanged',
				);
				continue;
			}
			land(file.path, settled.text);
			const raced = file.base !== undefined && current?.oid !== file.base;
			if (raced) merged = true;
			outcomes.push({
				path: file.path,
				landed: file.path,
				outcome:
					settled.text === null
						? 'deleted'
						: settled.blocks
							? 'conflict'
							: raced && settled.text !== incoming
								? 'merged'
								: 'written',
			});
		}

		const paths = outcomes.map((o) => o.landed);
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
				const subject = request.captureId
					? `Capture ${request.captureId}`
					: `Web write: ${paths.length} file${paths.length === 1 ? '' : 's'}`;
				const trailers = [
					...paths.map((p) => `Epicenter-Path: ${p}`),
					...(request.captureId
						? [
								`Epicenter-Capture: ${request.captureId}`,
								`Epicenter-Request: ${digest}`,
							]
						: []),
				];
				const commit = commitObject({
					tree,
					parents: main === ZERO_OID ? [] : [main],
					author: { ...author, at },
					message: `${subject}${merged ? ' (merged)' : ''}\n\n${trailers.join('\n')}\n`,
				});
				written.push(commit);
				next = commit.oid;
			}
		}
		const result: Receipt = {
			commit: next,
			paths,
			blobs: landedBlobs,
			outcomes,
			attempts: attempt,
		};
		if (next === main && capture === null) return json(result);
		if (next === ZERO_OID)
			return json(
				{
					error: 'invalid_write',
					message: 'nothing to write to an empty repository',
				},
				409,
			);
		const updates = [];
		if (next !== main) updates.push({ ref: MAIN, old: main, next });
		if (capture !== null && receipt !== next)
			updates.push({ ref: capture, old: receipt ?? ZERO_OID, next });
		if (updates.length === 0) return json(result);
		const applied = await objects.apply(
			updates,
			next === main ? null : writePack(written),
		);
		if (applied.ok) return json(result);
		if (!applied.stale)
			throw new Error(`the store refused a web write: ${applied.reason}`);
		await sleep(10 + Math.random() * 40 * attempt);
	}
	return json({ error: 'busy', message: 'main kept moving; try again' }, 503);
}

/** Every file under `root`, with each pointer's LFS object. */
export async function listRepositoryFiles(
	objects: GitObjects,
	root: unknown,
): Promise<Response> {
	const folder = readRoot(root);
	if (folder === null)
		return json(
			{ error: 'invalid_request', message: 'root is not a folder path' },
			400,
		);
	const main = (await objects.refs()).get(MAIN);
	if (main === undefined) return json({ commit: null, files: [] });
	const tree = (await readCommit(objects, main))?.tree ?? null;
	const entries = await listFiles(objects, tree, folder);
	const files = await Promise.all(
		entries.map(async ({ path, oid }) => {
			if (!storedWithLfs(path)) return { path, blob: oid };
			const found = await objects.read(oid, { maxBytes: MAX_POINTER_BYTES });
			const pointer = found?.bytes ? readPointer(found.bytes) : null;
			return pointer ? { path, blob: oid, lfs: pointer } : { path, blob: oid };
		}),
	);
	return json({ commit: main, files });
}

/** One file: a note's text, or another file's LFS object. */
export async function readRepositoryFile(
	objects: GitObjects,
	path: unknown,
): Promise<Response> {
	if (pathProblem(path) !== null)
		return json(
			{ error: 'invalid_request', message: 'path is not a repository path' },
			400,
		);
	const p = path as string;
	const main = (await objects.refs()).get(MAIN);
	const tree = main ? ((await readCommit(objects, main))?.tree ?? null) : null;
	const entry = await lookup(objects, tree, p);
	if (!entry)
		return json({ error: 'not_found', message: `${p} is not on main` }, 404);
	if (storedWithLfs(p)) {
		const found = await objects.read(entry.oid, {
			maxBytes: MAX_POINTER_BYTES,
		});
		const pointer = found?.bytes ? readPointer(found.bytes) : null;
		return json({ commit: main, path: p, blob: entry.oid, lfs: pointer });
	}
	return json({
		commit: main,
		path: p,
		blob: entry.oid,
		text: await readText(objects, entry.oid),
	});
}
