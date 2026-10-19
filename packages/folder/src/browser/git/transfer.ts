/**
 * Ordinary Git smart-HTTP fetch and push for the inflated-object engine.
 *
 * The engine stores inflated objects, two refs and pending edits, not a Git
 * directory. Each call here builds a bare repository in memory, seeds it with
 * the objects the caller already holds, lets isomorphic-git run the ordinary
 * transfer, reads the new objects back out, and throws the repository away.
 * Nothing is checked out, indexed, cached between calls, or authenticated: the
 * URL and the supplied `request` carry whatever access the caller has.
 *
 * Only the branch `main` is transferred.
 */
// biome-ignore lint/style/useNodejsImportProtocol: Browser Buffer polyfill package.
import { Buffer } from 'buffer';
import * as git from 'isomorphic-git';

// isomorphic-git's browser entry expects Buffer when its operations run.
if (typeof globalThis.Buffer === 'undefined')
	Object.assign(globalThis, { Buffer });

export type HttpRequest = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

import type { GitHttpRequest, HttpClient } from 'isomorphic-git';
import {
	type GitObject,
	hashObject,
	readCommit,
	readTree,
} from '../../git/raw-objects.js';
import { createScratchFs, type ScratchFs } from './transfer-fs.js';

/** Git transfer refs derived from the durable browser state. */
type TransferRefs = {
	base: string | null;
	head: string | null;
	shallow: readonly string[];
};

/** Every inflated object the caller holds for both snapshots. */
export type TransferInput = {
	objects: ReadonlyMap<string, GitObject>;
	refs: TransferRefs;
};

/**
 * `transport`: the request, the reply, or the objects in it failed; nothing
 * is known about whether the remote changed.
 * `limited-history`: the retained commits cannot show whether the push is a
 * fast-forward. This is not a rejection.
 * `declined`: the remote answered definitively that it did not take the push
 * for a reason other than a changed `main`.
 */
export type TransferFailureReason =
	| 'transport'
	| 'limited-history'
	| 'declined';

/** An ordinary, expected failure of a transfer. Other errors are defects. */
export class TransferFailure extends Error {
	readonly reason: TransferFailureReason;
	/** The HTTP status when the server answered with one. */
	readonly status: number | undefined;

	constructor(
		message: string,
		{
			reason = 'transport',
			status,
			cause,
		}: {
			reason?: TransferFailureReason;
			status?: number;
			cause?: unknown;
		} = {},
	) {
		super(message, { cause });
		this.name = 'TransferFailure';
		this.reason = reason;
		this.status = status;
	}
}

const GITDIR = '/git';
const BRANCH = 'main';
const MAIN = `refs/heads/${BRANCH}`;
const REMOTE = 'origin';
const ZERO_OID = '0'.repeat(40);
const GITLINK_MODE = '160000';

/** isomorphic-git errors that mean the call was wrong, not that a transfer failed. */
const USAGE_CODES = new Set([
	'MissingParameterError',
	'InvalidRefNameError',
	'NoRefspecError',
	// A needed local object is absent: the caller's closure is incomplete.
	'NotFoundError',
	'ObjectTypeError',
]);

/** A push also reads the remote's own report of what it did with `main`. */
const PUSH_OWN_CODES = new Set([...USAGE_CODES, 'GitPushError']);

type GitError = Error & { code: string; data?: Record<string, unknown> };

function isGitError(error: unknown): error is GitError {
	return (
		error instanceof Error &&
		typeof (error as { code?: unknown }).code === 'string'
	);
}

function describe(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

type Scratch = { fs: ScratchFs; cache: object };

/** Builds the bare repository and puts everything the caller holds into it. */
async function openScratch(input: TransferInput | null, ref: string | null) {
	const scratch: Scratch = { fs: createScratchFs(), cache: {} };
	const { fs } = scratch;
	await git.init({ fs, gitdir: GITDIR, bare: true, defaultBranch: BRANCH });
	// Without a refspec isomorphic-git cannot record what it fetched. The
	// remote's URL is deliberately not configured: it may hold credentials.
	await git.setConfig({
		fs,
		gitdir: GITDIR,
		path: `remote.${REMOTE}.fetch`,
		value: `+refs/heads/*:refs/remotes/${REMOTE}/*`,
	});
	if (input === null) return scratch;
	for (const [oid, { type, bytes }] of input.objects) {
		const written = await git.writeObject({
			fs,
			gitdir: GITDIR,
			type,
			object: bytes,
			format: 'content',
		});
		if (written !== oid) {
			throw new Error(`object keyed ${oid} hashes to ${written}`);
		}
	}
	if (input.refs.shallow.length > 0) {
		// Git reads the boundary from this file; it has no public writer.
		await fs.promises.writeFile(
			`${GITDIR}/shallow`,
			`${input.refs.shallow.join('\n')}\n`,
		);
	}
	if (ref !== null) {
		if (!input.objects.has(ref)) {
			throw new Error(`commit ${ref} is not among the supplied objects`);
		}
		await git.writeRef({ fs, gitdir: GITDIR, ref: MAIN, value: ref });
	}
	return scratch;
}

async function readShallow({ fs }: Scratch) {
	try {
		const text = (await fs.promises.readFile(
			`${GITDIR}/shallow`,
			'utf8',
		)) as string;
		return new Set(text.split('\n').filter((line) => line !== ''));
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT')
			return new Set<string>();
		throw error;
	}
}

async function collect(body: GitHttpRequest['body']) {
	if (body === undefined) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * isomorphic-git's reader treats a body that errors as one that ended, so a
 * reply cut off mid-stream can parse as a short but valid one. The first
 * failure is latched here and outranks whatever the transfer concluded.
 */
function createHttp(request: HttpRequest | undefined, signal?: AbortSignal) {
	const send: (url: string, init: RequestInit) => Promise<Response> =
		request ?? ((url, init) => globalThis.fetch(url, init));
	const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
	let latched: TransferFailure | undefined;

	function fail(cause: unknown) {
		if (cause instanceof TransferFailure) latched ??= cause;
		else {
			latched ??= new TransferFailure(
				signal?.aborted
					? 'The Git transfer was aborted'
					: `The Git request failed: ${describe(cause)}`,
				{ cause },
			);
		}
		return latched;
	}

	function bodyOf(stream: ReadableStream<Uint8Array> | null) {
		if (stream === null) return (async function* () {})();
		const reader = stream.getReader();
		readers.push(reader);
		const iterator: AsyncIterableIterator<Uint8Array> = {
			async next() {
				try {
					const { done, value } = await reader.read();
					return done
						? { done: true, value: undefined }
						: { done: false, value };
				} catch (cause) {
					throw fail(cause);
				}
			},
			async return() {
				await reader.cancel().catch(() => {});
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return iterator;
			},
		};
		return iterator;
	}

	const client: HttpClient = {
		async request({ url, method = 'GET', headers = {}, body }) {
			const authorized = Object.keys(headers).some(
				(name) => name.toLowerCase() === 'authorization',
			);
			try {
				// Browsers cannot stream a request body, and Git wants a length.
				const payload = await collect(body);
				const response = await send(url, {
					method,
					headers,
					body: payload as Uint8Array<ArrayBuffer> | undefined,
					signal,
					// Git needs no cookie, and a credential goes to the URL it was
					// given for. A redirected POST would be replayed as a GET.
					credentials: 'omit',
					redirect: method === 'GET' && !authorized ? 'follow' : 'error',
				});
				return {
					url: response.url,
					method,
					statusCode: response.status,
					statusMessage: response.statusText,
					headers: Object.fromEntries(response.headers),
					body: bodyOf(response.body),
				};
			} catch (cause) {
				throw fail(cause);
			}
		},
	};

	return {
		client,
		failure: () => latched,
		/** Stops reading replies the transfer left unfinished. */
		close() {
			for (const reader of readers) reader.cancel().catch(() => {});
		},
	};
}

type Http = ReturnType<typeof createHttp>;

/**
 * Runs one isomorphic-git call; its failures become `TransferFailure`s, except
 * errors whose code is in `own`, which the caller reads for itself.
 */
async function ordinary<T>(
	http: Http,
	run: () => Promise<T>,
	own: ReadonlySet<string> = USAGE_CODES,
): Promise<T> {
	let result: T;
	try {
		result = await run();
	} catch (error) {
		const latched = http.failure();
		if (latched !== undefined) throw latched;
		if (error instanceof TransferFailure) throw error;
		if (isGitError(error) && own.has(error.code)) throw error;
		if (isGitError(error) && error.code === 'HttpError') {
			const statusCode = error.data?.statusCode as number | undefined;
			throw new TransferFailure(
				`The Git server answered ${statusCode} ${String(error.data?.statusMessage ?? '')}`.trim(),
				{ status: statusCode, cause: error },
			);
		}
		throw new TransferFailure(`The Git transfer failed: ${describe(error)}`, {
			cause: error,
		});
	}
	const latched = http.failure();
	if (latched !== undefined) throw latched;
	return result;
}

function assertLive(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new TransferFailure('The Git transfer was aborted', {
			cause: signal.reason,
		});
	}
}

/** Reads one object out of the scratch repository and proves it is the one named. */
async function readVerified(
	scratch: Scratch,
	oid: string,
	type: GitObject['type'],
): Promise<GitObject> {
	let read: Awaited<ReturnType<typeof git.readObject>>;
	try {
		read = await git.readObject({
			fs: scratch.fs,
			gitdir: GITDIR,
			cache: scratch.cache,
			oid,
			format: 'content',
		});
	} catch (cause) {
		throw new TransferFailure(
			`The fetch did not include ${type} ${oid}: ${describe(cause)}`,
			{ cause },
		);
	}
	if (read.type !== type || !(read.object instanceof Uint8Array)) {
		throw new TransferFailure(`Object ${oid} is a ${read.type}, not a ${type}`);
	}
	const object: GitObject = { type, bytes: new Uint8Array(read.object) };
	const actual = await hashObject(object);
	if (actual !== oid) {
		throw new TransferFailure(
			`The server sent ${actual} where ${oid} was named`,
		);
	}
	return object;
}

/**
 * Everything new that `head` needs: its commits down to the history boundary,
 * and the trees and blobs of each new commit. Gitlinks name commits in other
 * repositories and are not followed.
 */
async function readFetched(
	scratch: Scratch,
	head: string,
	known: ReadonlyMap<string, GitObject>,
) {
	const boundary = await readShallow(scratch);
	const objects = new Map<string, GitObject>();
	const shallow = new Set<string>();
	const commits = new Set<string>();
	const queue = [head];
	for (let oid = queue.pop(); oid !== undefined; oid = queue.pop()) {
		if (commits.has(oid)) continue;
		commits.add(oid);
		const supplied = known.get(oid);
		const commit = supplied ?? (await readVerified(scratch, oid, 'commit'));
		if (supplied !== undefined && supplied.type !== 'commit') {
			throw new Error(
				`supplied object ${oid} is a ${supplied.type}, not a commit`,
			);
		}
		const { tree, parents } = readCommit(commit.bytes);
		if (supplied === undefined) {
			objects.set(oid, commit);
			await readFetchedTree(scratch, tree, known, objects);
		}
		if (boundary.has(oid)) shallow.add(oid);
		else queue.push(...parents);
	}
	return { objects, shallow: [...shallow] };
}

async function readFetchedTree(
	scratch: Scratch,
	root: string,
	known: ReadonlyMap<string, GitObject>,
	objects: Map<string, GitObject>,
) {
	const pending = [root];
	for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
		if (known.has(oid) || objects.has(oid)) continue;
		const tree = await readVerified(scratch, oid, 'tree');
		objects.set(oid, tree);
		for (const entry of readTree(tree.bytes)) {
			if (entry.mode === GITLINK_MODE) continue;
			if (entry.mode === '40000' || entry.mode === '040000') {
				pending.push(entry.oid);
			} else if (!known.has(entry.oid) && !objects.has(entry.oid)) {
				objects.set(entry.oid, await readVerified(scratch, entry.oid, 'blob'));
			}
		}
	}
}

/**
 * Fetches `main`.
 *
 * `initial` asks for the tip commit alone. Otherwise the remote is asked for
 * everything newer than B, which the scratch repository advertises as its own
 * `main`, with the retained boundary declared shallow. `recover` ignores
 * `input` and asks an empty repository for the whole history, for when the
 * retained commits cannot reach the remote's. That history is returned like
 * any other result and is the caller's to discard.
 *
 * `head` is null only when the remote affirmatively has no `main`. `objects`
 * holds every commit, tree and blob the fetch added beyond `input`, and
 * `shallow` the commits reachable from `head` whose parents are not held.
 */
export async function fetchRemote({
	url,
	input,
	initial,
	signal,
	request,
	recover = false,
}: {
	url: string;
	input: TransferInput;
	initial: boolean;
	signal?: AbortSignal;
	request?: HttpRequest;
	recover?: boolean;
}): Promise<{
	head: string | null;
	objects: Map<string, GitObject>;
	shallow: readonly string[];
}> {
	assertLive(signal);
	const known: ReadonlyMap<string, GitObject> = recover
		? new Map()
		: input.objects;
	const scratch = await openScratch(
		recover ? null : input,
		recover || initial ? null : input.refs.base,
	);
	const http = createHttp(request, signal);
	try {
		let fetched: Awaited<ReturnType<typeof git.fetch>>;
		try {
			fetched = await ordinary(http, () =>
				git.fetch({
					fs: scratch.fs,
					http: http.client,
					gitdir: GITDIR,
					cache: scratch.cache,
					url,
					remote: REMOTE,
					ref: BRANCH,
					remoteRef: MAIN,
					singleBranch: true,
					tags: false,
					depth: initial && !recover ? 1 : undefined,
				}),
			);
		} catch (error) {
			// The remote answered, and `main` is not among its branches.
			if (
				isGitError(error) &&
				error.code === 'NotFoundError' &&
				error.data?.what === MAIN
			) {
				return { head: null, objects: new Map(), shallow: [] };
			}
			throw error;
		}
		if (fetched.fetchHead === null) {
			return { head: null, objects: new Map(), shallow: [] };
		}
		const head = fetched.fetchHead;
		const { objects, shallow } = await readFetched(scratch, head, known);
		return { head, objects, shallow };
	} finally {
		http.close();
		scratch.fs.clear();
	}
}

/** Whether `head` descends from `base` using only commits that are held. */
function ancestry(input: TransferInput, head: string, base: string) {
	const boundary = new Set(input.refs.shallow);
	const seen = new Set<string>();
	const queue = [head];
	let complete = true;
	for (let oid = queue.pop(); oid !== undefined; oid = queue.pop()) {
		if (seen.has(oid)) continue;
		seen.add(oid);
		const commit = input.objects.get(oid);
		if (commit === undefined || commit.type !== 'commit') {
			complete = false;
			continue;
		}
		if (boundary.has(oid)) {
			complete = false;
			continue;
		}
		for (const parent of readCommit(commit.bytes).parents) {
			if (parent === base) return 'descends';
			queue.push(parent);
		}
	}
	return complete ? 'diverges' : 'limited';
}

/** The remote refused to move `main` from where this push saw it. */
function movedRef(reason: string) {
	return /^(non-fast-forward|failed to update ref)/.test(reason);
}

type Decision = 'pushed' | 'rejected' | 'limited';

/**
 * Pushes `head` to `main`, expecting `main` to be at `base` (null: absent).
 *
 * The expectation is checked against the very advertisement the push is built
 * from, in isomorphic-git's pre-push hook, and again by the server when it
 * moves the ref. `'pushed'` includes a remote that already holds `head`, which
 * is what a push whose reply vanished looks like on retry. `'rejected'` means
 * only that `main` is not where `base` says, or is not a fast-forward to
 * `head`; the caller reconciles and tries again. Anything that leaves the
 * outcome unknown throws.
 */
export async function pushRemote({
	url,
	input,
	base,
	head,
	signal,
	request,
}: {
	url: string;
	input: TransferInput;
	base: string | null;
	head: string;
	signal?: AbortSignal;
	request?: HttpRequest;
}): Promise<'pushed' | 'rejected'> {
	assertLive(signal);
	if (!input.objects.has(head)) {
		throw new Error(`commit ${head} is not among the supplied objects`);
	}
	const scratch = await openScratch(input, null);
	await git.writeRef({
		fs: scratch.fs,
		gitdir: GITDIR,
		ref: MAIN,
		value: head,
	});
	const http = createHttp(request, signal);
	let decision = undefined as Decision | undefined;
	let defect: Error | undefined;
	try {
		let result: Awaited<ReturnType<typeof git.push>>;
		try {
			result = await ordinary(
				http,
				() =>
					git.push({
						fs: scratch.fs,
						http: http.client,
						gitdir: GITDIR,
						cache: scratch.cache,
						url,
						remote: REMOTE,
						ref: BRANCH,
						remoteRef: MAIN,
						force: false,
						onPrePush: ({ localRef, remoteRef }) => {
							if (remoteRef.ref !== MAIN || localRef.oid !== head) {
								defect = new Error(
									`push of ${localRef.oid} to ${remoteRef.ref} is not ${head} to ${MAIN}`,
								);
								return false;
							}
							const advertised =
								remoteRef.oid === ZERO_OID ? null : remoteRef.oid;
							if (advertised === head) decision = 'pushed';
							else if (advertised !== base) decision = 'rejected';
							else if (base !== null) {
								const found = ancestry(input, head, base);
								if (found === 'diverges') decision = 'rejected';
								else if (found === 'limited') decision = 'limited';
							}
							return decision === undefined;
						},
					}),
				PUSH_OWN_CODES,
			);
		} catch (error) {
			// A reply that failed mid-stream can leave a partial advertisement
			// behind; nothing it implied counts.
			const interrupted = http.failure();
			if (interrupted !== undefined) throw interrupted;
			if (defect !== undefined) throw defect;
			if (decision === 'pushed' || decision === 'rejected') return decision;
			if (decision === 'limited') {
				throw new TransferFailure(
					`The retained commits do not show that ${head} descends from ${base}`,
					{ reason: 'limited-history', cause: error },
				);
			}
			if (isGitError(error) && error.code === 'GitPushError') {
				const report = (
					error.data?.result as
						| { refs?: Record<string, { ok: boolean; error: string }> }
						| undefined
				)?.refs?.[MAIN];
				if (report !== undefined && !report.ok) {
					if (movedRef(report.error)) return 'rejected';
					throw new TransferFailure(
						`The remote declined the push: ${report.error}`,
						{ reason: 'declined', cause: error },
					);
				}
				// The remote objected, but not to `main`: an unpack failure or a
				// report that names no outcome for it.
				throw new TransferFailure(
					`The remote did not apply the push: ${describe(error)}`,
					{ cause: error },
				);
			}
			throw error;
		}
		// A reply that names no outcome for `main` leaves it unknown.
		if (!result.ok || result.refs?.[MAIN]?.ok !== true) {
			throw new TransferFailure(
				'The remote did not report the push as applied',
			);
		}
		return 'pushed';
	} finally {
		http.close();
		scratch.fs.clear();
	}
}
