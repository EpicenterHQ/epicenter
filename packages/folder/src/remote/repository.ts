/**
 * A folder's repository on the server, as sync and the web reach it
 * (ADR-0807, ADR-0808, ADR-0810): the routes `<git>/folders/<folder>/…` in
 * Git's vocabulary (`packages/server/src/routes/folder.ts`), spoken over
 * the account's fetch.
 *
 * `folderRepository(account, folder)` answers the `Repository` sync needs
 * (where `main` is and what changed, a tree, blobs by id, and a commit) and,
 * over those, the store verbs a web folder opens, every one of them at
 * `main`'s head. A file's version is its Git blob id, so nothing translates:
 * a note's bytes are read by its blob id in one request for many, and an
 * attachment's at `blobs/<sha256>`, named by its pointer and checked against
 * it. A commit puts each new attachment's bytes there first (idempotent, so
 * a lost reply is put again), then lands every path in one commit where it
 * still holds the blob its writer expects; one that moved is `Moved`.
 *
 * A watch asks where `main` is before it answers, then, every `pollMs`, for
 * the paths changed since the commit it last saw. The server becoming
 * unreachable is heard as `'all'`. It stops with the stop it answered, or
 * with the account.
 *
 * `mintFolder` asks the server for a new folder, or for the caller's folder
 * of a name (a web app's, named from its site), answering its id: what a
 * manifest stores (`RepositoryAddress`).
 */
import { ClientError, storedWithLfs } from '@epicenter/definition/contract';
import { parsePointer } from '@epicenter/definition/merge';
import {
	folderUrl,
	isFolderId,
	resolveOAuthAudiences,
} from '@epicenter/definition/site';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type BlobId,
	type FileRead,
	type Listed,
	type Store,
	StoreError,
	type Unavailable,
	within,
} from '../device/store.js';
import { pointerBlobId, sha256Of } from '../hash.js';
import { fromBase64, toBase64 } from '../served/wire.js';
import type {
	CommitReceipt,
	CommitRefusal,
	Repository,
	TreeEntry,
} from '../sync/repository.js';

/**
 * What a repository needs of a signed-in account: an `@epicenter/account`
 * `Account`, named by shape so this package never loads authentication.
 * `fetch` carries the account's credential to its own server; `signal`
 * aborts when the account is retired.
 */
export type RemoteAccount = {
	readonly baseURL: string;
	readonly signal: AbortSignal;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
};

/** Why the server's answer could not be used: the cause of an `Unavailable`. */
export const RemoteError = defineErrors({
	/** The server answered a request with a status this client does not expect. */
	Refused: ({
		status,
		code,
		message,
	}: {
		status: number;
		code: string | null;
		message: string;
	}) => ({
		message: `The server refused the request (${status}${code ? ` ${code}` : ''}): ${message}`,
		status,
		code,
	}),
	/** Bytes read for a blob are not that blob. */
	Corrupt: ({ id }: { id: string }) => ({
		message: `The bytes read for ${id} are not that blob`,
		id,
	}),
});
export type RemoteError = InferErrors<typeof RemoteError>;

/** One commit of a folder's history. */
export type FolderCommit = {
	id: string;
	parents: string[];
	/** Who made it, as its author line names them. */
	author: string;
	/** When, in seconds since the epoch. */
	time: number;
	message: string;
};

/** How often a watch asks the server what changed. */
const POLL_MS = 3000;

const decoder = new TextDecoder();
// A note's bytes travel as text only when they decode exactly, a byte-order mark kept.
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** One request's answer: its status and JSON body (null when it has none), or `Unavailable`. */
async function ask(
	account: RemoteAccount,
	url: string,
	init: RequestInit = {},
): Promise<
	Result<{ status: number; body: unknown; response: Response }, Unavailable>
> {
	let response: Response;
	try {
		response = await account.fetch(url, init);
	} catch (cause) {
		return ClientError.Unavailable({ cause });
	}
	const json = response.headers.get('content-type')?.includes('json');
	const body: unknown = json ? await response.json().catch(() => null) : null;
	return Ok({ status: response.status, body, response });
}

/** `Unavailable` for an answer this client does not expect. */
function refused(status: number, body: unknown) {
	const fields = isRecord(body) ? body : {};
	return ClientError.Unavailable({
		cause: RemoteError.Refused({
			status,
			code: typeof fields.error === 'string' ? fields.error : null,
			message:
				typeof fields.message === 'string'
					? fields.message
					: typeof fields.error_description === 'string'
						? fields.error_description
						: `status ${status}`,
		}).error,
	});
}

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

/**
 * A new folder of `account`'s, or its folder named `name` (made at the first
 * ask), answering its id.
 */
export async function mintFolder(
	account: RemoteAccount,
	{ name }: { name?: string } = {},
): Promise<Result<{ folder: string }, Unavailable>> {
	const { git } = resolveOAuthAudiences(account.baseURL);
	const answered = await ask(
		account,
		folderUrl(git),
		json(name === undefined ? {} : { name }),
	);
	if (answered.error !== null) return answered;
	const { status, body } = answered.data;
	if (
		(status !== 200 && status !== 201) ||
		!isRecord(body) ||
		typeof body.folder !== 'string' ||
		!isFolderId(body.folder)
	)
		return refused(status, body);
	return Ok({ folder: body.folder });
}

/**
 * The repository of the folder `folder` as `account` reaches it, and its
 * store verbs at `main`, asking what changed every `pollMs` while watched.
 * A `folder` that is no folder id throws.
 */
export function folderRepository(
	account: RemoteAccount,
	folder: string,
	{ pollMs = POLL_MS }: { pollMs?: number } = {},
): Store &
	Repository & {
		log(limit?: number): Promise<Result<FolderCommit[], Unavailable>>;
	} {
	if (!isFolderId(folder)) throw new Error(`'${folder}' is not a folder id`);
	const base = folderUrl(resolveOAuthAudiences(account.baseURL).git, folder);

	/** Where `main` is, and what changed since `since` (`''`: before the first commit; null: no paths). */
	async function changes(since: string | null) {
		const query = since === null ? '' : `?since=${encodeURIComponent(since)}`;
		const answered = await ask(account, `${base}/changes${query}`);
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (
			status !== 200 ||
			!isRecord(body) ||
			(typeof body.commit !== 'string' && body.commit !== null) ||
			(body.paths !== null && !Array.isArray(body.paths))
		)
			return refused(status, body);
		return Ok({
			commit: body.commit as string | null,
			paths: body.paths as string[] | null,
		});
	}

	/** The tree of `commit` at `paths` (all when absent), with each attachment's object. */
	async function treeOf(commit: string, paths?: readonly string[]) {
		const answered = await ask(
			account,
			`${base}/tree`,
			json({ commit, paths }),
		);
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (status !== 200 || !isRecord(body) || !Array.isArray(body.entries))
			return refused(status, body);
		return Ok(
			body.entries as {
				path: string;
				blob: BlobId;
				oid?: string;
				size?: number;
			}[],
		);
	}

	/** Many blobs' bytes by id, in one request: null for one the server does not hold. */
	async function blobsById(
		ids: readonly string[],
	): Promise<Result<(Uint8Array | null)[], Unavailable>> {
		if (ids.length === 0) return Ok([]);
		const answered = await ask(account, `${base}/blobs`, json({ ids }));
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (status !== 200 || !isRecord(body) || !Array.isArray(body.blobs))
			return refused(status, body);
		return Ok(
			(body.blobs as (string | null)[]).map((text) =>
				text === null ? null : fromBase64(text),
			),
		);
	}

	/** An attachment's bytes, by its sha256, checked against its pointer. */
	async function attachment(
		oid: string,
		size: number,
	): Promise<Result<Uint8Array | null, Unavailable>> {
		let response: Response;
		try {
			response = await account.fetch(`${base}/blobs/${oid}`);
		} catch (cause) {
			return ClientError.Unavailable({ cause });
		}
		if (response.status === 404) return Ok(null);
		if (!response.ok)
			return refused(response.status, await response.json().catch(() => null));
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch (cause) {
			return ClientError.Unavailable({ cause });
		}
		if (bytes.byteLength !== size || (await sha256Of(bytes)) !== oid)
			return ClientError.Unavailable({
				cause: RemoteError.Corrupt({ id: oid }).error,
			});
		return Ok(bytes);
	}

	async function blobs(
		wanted: readonly { path: string; blob: BlobId }[],
	): Promise<Result<(Uint8Array | null)[], Unavailable>> {
		const read = await blobsById(wanted.map(({ blob }) => blob));
		if (read.error !== null) return read;
		const out: (Uint8Array | null)[] = [];
		for (const [index, { path, blob }] of wanted.entries()) {
			const bytes = read.data[index] ?? null;
			if (bytes === null || !storedWithLfs(path)) {
				out.push(bytes);
				continue;
			}
			// An attachment's blob is its pointer: its bytes are at their sha256.
			const pointer = parsePointer(decoder.decode(bytes));
			if (
				pointer === null ||
				(await pointerBlobId(pointer.oid, pointer.size)) !== blob
			)
				return ClientError.Unavailable({
					cause: RemoteError.Corrupt({ id: blob }).error,
				});
			const got = await attachment(pointer.oid, pointer.size);
			if (got.error !== null) return got;
			out.push(got.data);
		}
		return Ok(out);
	}

	/** Put an attachment's bytes at their sha256: idempotent. */
	async function upload(bytes: Uint8Array) {
		const oid = await sha256Of(bytes);
		const answered = await ask(account, `${base}/blobs/${oid}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/octet-stream' },
			body: bytes as Uint8Array<ArrayBuffer>,
		});
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (status !== 200 && status !== 201) return refused(status, body);
		return Ok({ oid, size: bytes.byteLength });
	}

	async function commit(
		writes: readonly {
			path: string;
			bytes: Uint8Array | null;
			expect: BlobId | null;
		}[],
	): Promise<Result<CommitReceipt | 'moved' | CommitRefusal, Unavailable>> {
		const files: Record<string, unknown>[] = [];
		for (const { path, bytes, expect } of writes) {
			if (bytes === null) {
				files.push({ path, expect, delete: true });
				continue;
			}
			if (storedWithLfs(path)) {
				const lfs = await upload(bytes);
				if (lfs.error !== null) return lfs;
				files.push({ path, expect, lfs: lfs.data });
				continue;
			}
			let text: string | undefined;
			try {
				text = strict.decode(bytes);
			} catch {}
			files.push(
				text === undefined
					? { path, expect, base64: toBase64(bytes) }
					: { path, expect, text },
			);
		}
		const answered = await ask(account, `${base}/commits`, json({ files }));
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		const fields = isRecord(body) ? body : {};
		if (status === 200 && isRecord(fields.blobs))
			return Ok({
				commit: fields.commit as string,
				blobs: fields.blobs as Record<string, BlobId | null>,
			});
		if (status === 409 && fields.error === 'moved') return Ok('moved' as const);
		if (
			status === 409 &&
			fields.error === 'case_collision' &&
			typeof fields.path === 'string'
		)
			return Ok({
				refused: fields.path,
				reason:
					typeof fields.message === 'string'
						? fields.message
						: 'case collision',
			});
		return refused(status, body);
	}

	const repository: Repository = {
		changes,
		async tree(commit, paths) {
			const tree = await treeOf(commit, paths);
			if (tree.error !== null) return tree;
			return Ok(
				tree.data.map(
					({ path, blob, size }): TreeEntry => ({
						path,
						blob,
						size: size ?? null,
					}),
				),
			);
		},
		blobs,
		commit,
	};

	/** `main`'s head now, null before the first commit. */
	async function head() {
		const at = await changes(null);
		if (at.error !== null) return at;
		return Ok(at.data.commit);
	}

	return {
		...repository,
		/** `main`'s history, newest first, along first parents: at most `limit` commits. */
		async log(limit = 50): Promise<Result<FolderCommit[], Unavailable>> {
			const answered = await ask(account, `${base}/commits?limit=${limit}`);
			if (answered.error !== null) return answered;
			const { status, body } = answered.data;
			if (status !== 200 || !isRecord(body) || !Array.isArray(body.commits))
				return refused(status, body);
			return Ok(body.commits as FolderCommit[]);
		},
		async list(under): Promise<Result<Listed[], Unavailable>> {
			const at = await head();
			if (at.error !== null) return at;
			if (at.data === null) return Ok([]);
			const tree = await treeOf(at.data);
			if (tree.error !== null) return tree;
			return Ok(
				tree.data
					.filter(({ path }) => within(path, under))
					.map(({ path, blob, size }) => ({
						path,
						version: blob,
						size: size ?? null,
					})),
			);
		},
		async read(paths): Promise<Result<FileRead[], Unavailable>> {
			if (paths.length === 0) return Ok([]);
			const at = await head();
			if (at.error !== null) return at;
			if (at.data === null)
				return Ok(paths.map((path) => ({ path, gone: true as const })));
			const tree = await treeOf(at.data, paths);
			if (tree.error !== null) return tree;
			const held = new Map(tree.data.map(({ path, blob }) => [path, blob]));
			const wanted = paths.flatMap((path) => {
				const blob = held.get(path);
				return blob === undefined ? [] : [{ path, blob }];
			});
			const bytes = await blobs(wanted);
			if (bytes.error !== null) return bytes;
			const byPath = new Map(
				wanted.map(({ path, blob }, index) => [
					path,
					{ blob, bytes: bytes.data[index] },
				]),
			);
			return Ok(
				paths.map((path): FileRead => {
					const file = byPath.get(path);
					return file?.bytes == null
						? { path, gone: true }
						: { path, bytes: file.bytes, version: file.blob };
				}),
			);
		},
		async put(path, bytes, expect) {
			const landed = await commit([{ path, bytes, expect }]);
			if (landed.error !== null) return landed;
			if (landed.data === 'moved') {
				const at = await head();
				if (at.error !== null) return at;
				const tree = at.data === null ? Ok([]) : await treeOf(at.data, [path]);
				if (tree.error !== null) return tree;
				return StoreError.Moved({ path, now: tree.data[0]?.blob ?? null });
			}
			// A store's put has no refusal: the folder keeps it, saying why.
			if ('refused' in landed.data)
				return ClientError.Unavailable({ cause: landed.data.reason });
			return Ok(landed.data.blobs[path] ?? null);
		},
		async watch(changed) {
			if (account.signal.aborted)
				return ClientError.Unavailable({ cause: 'the account was retired' });
			const first = await changes(null);
			if (first.error !== null) return first;
			/** The commit `main` was at when last asked. */
			let seen = first.data.commit;
			let reachable = true;
			let stopped = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			async function poll() {
				if (stopped || account.signal.aborted) return;
				const asked = await changes(seen ?? '');
				if (stopped) return;
				if (asked.error !== null) {
					if (reachable) changed('all');
					reachable = false;
				} else {
					reachable = true;
					const { commit: now, paths } = asked.data;
					if (paths === null) changed('all');
					else if (paths.length > 0) changed(paths);
					seen = now;
				}
				timer = setTimeout(poll, pollMs);
			}
			timer = setTimeout(poll, pollMs);
			return Ok(() => {
				stopped = true;
				clearTimeout(timer);
			});
		},
		close() {},
	};
}
