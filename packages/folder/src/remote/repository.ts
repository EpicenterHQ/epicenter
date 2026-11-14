/**
 * A folder on the server, as sync, the web, and the CLI reach it (ADR-0807,
 * ADR-0810, ADR-0824): the routes `<folders>/<folder>/…`
 * (`packages/server/src/routes/folder.ts`), spoken over the account's
 * fetch.
 *
 * `folderRepository(account, folder)` answers the `Repository` sync needs
 * (what changed since a cursor, every file, bytes by version, and a
 * change to append), the store verbs a web folder opens, and the folder's
 * history (its log, its files at any change, its marks, a change naming
 * versions it holds, and an import's changes). A file's version is the SHA-256 of its
 * bytes, so nothing translates: bytes up to 16 KiB travel inline, and
 * larger ones by version at `blobs/<sha256>`, checked against it. A change
 * asks which of its larger versions the folder lacks and uploads those
 * first (idempotent, so a lost reply is put again), then lands every path
 * in one change where it still holds the version its writer expects; one
 * that moved is `Moved`. Bytes the server holds or sent for this folder are
 * not asked about again.
 *
 * A watch asks for the head before it answers, then, every `pollMs`, for
 * the paths changed since the cursor it last saw. The server becoming
 * unreachable is heard as `'all'`. It stops with the stop it answered, or
 * with the account.
 *
 * `makeFolder` makes a new folder on the server and never joins one
 * (ADR-0822); `joinApp` joins the one folder attached to an app, naming the
 * app, as a web app's first open does (ADR-0823).
 */
import { ClientError } from '@epicenter/definition/contract';
import {
	folderUrl,
	isFolderId,
	resolveOAuthAudiences,
} from '@epicenter/definition/site';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type FileRead,
	type Listed,
	type Moved,
	type Store,
	StoreError,
	type Unavailable,
	type Version,
	within,
} from '../device/store.js';
import { versionOf } from '../hash.js';
import { fromBase64, toBase64 } from '../served/wire.js';
import type {
	ChangedPath,
	ChangeMoved,
	ChangeReceipt,
	ChangeRefusal,
	FileEntry,
	Repository,
} from '../sync/repository.js';

/**
 * What a folder needs of a signed-in account: an `@epicenter/account`
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
	/** Bytes read for a version are not that version. */
	Corrupt: ({ id }: { id: string }) => ({
		message: `The bytes read for ${id} are not that version`,
		id,
	}),
});
export type RemoteError = InferErrors<typeof RemoteError>;

/** One change of a folder's log. */
export type LoggedChange = {
	seq: number;
	/** When, as an ISO 8601 time. */
	at: string;
	/** Who, as `Name <email>` when they made it (or as an imported commit named them). */
	author: string;
	/** The program, by the client id it signs in as. */
	via: string;
	/** An imported commit's message; null for a change made here. */
	message: string | null;
	/** The SHA-256 chaining this change to the one before. */
	digest: string;
	/** Each path it wrote: its version, null for a deletion, and size. */
	files: { path: string; version: Version | null; size: number | null }[];
	/** The marks naming this change. */
	marks: string[];
};

/** A name a person gave one change (`epicenter mark`). */
export type Mark = { name: string; seq: number; at: string };

/** A file as of some change, with its bytes when asked for and kept inline. */
export type FileAt = FileEntry & { bytes?: Uint8Array };

/** One write of a change that names a version: one the folder holds, or null to delete. */
export type NamedWrite = {
	path: string;
	expect: Version | null;
	version: Version | null;
};

/** One change of an import: its author, time, message, and the files it writes. */
export type ImportedChange = {
	author: string;
	at: Date;
	message: string | null;
	files: (
		| { path: string; expect: Version | null; bytes: Uint8Array }
		| NamedWrite
	)[];
};

/** How often a watch asks the server what changed. */
const POLL_MS = 3000;

/**
 * How long a put waits for others to land with it as one change, after the
 * last one made, and at most after the first (ADR-0823).
 */
const BATCH_MS = 50;
const BATCH_MAX_MS = 300;

/** The most bytes that travel inside a change; larger ones are uploaded and named. */
export const INLINE_MAX = 16 * 1024;

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

const json = (body: unknown, method = 'POST'): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

/** The folder id in a 200 or 201 answer to `POST <folders>`, or the refusal. */
function folderOf(status: number, body: unknown) {
	if (
		(status !== 200 && status !== 201) ||
		!isRecord(body) ||
		typeof body.folder !== 'string' ||
		!isFolderId(body.folder)
	)
		return refused(status, body);
	return Ok(body.folder);
}

/**
 * Make a new folder on the server, held by `account`'s person, and answer
 * its id. It never joins one. From a token that reaches every folder, `app`
 * attaches it to that app (the client id it signs in as); an app's own
 * token attaches it to itself. With `importing`, it takes an import's
 * changes until the import is done (ADR-0826).
 */
export async function makeFolder(
	account: RemoteAccount,
	{ app, importing = false }: { app?: string; importing?: boolean } = {},
): Promise<Result<string, Unavailable>> {
	const { folders } = resolveOAuthAudiences(account.baseURL);
	const answered = await ask(
		account,
		folderUrl(folders),
		json({
			create: true,
			...(app === undefined ? {} : { app }),
			...(importing ? { import: true } : {}),
		}),
	);
	if (answered.error !== null) return answered;
	return folderOf(answered.data.status, answered.data.body);
}

/** What joining an app's folder answered. */
export type Joined =
	/** The one folder attached to the app that the person holds. */
	| { folder: string }
	/** The person holds several: which one is theirs to say. */
	| { choose: string[] }
	/** The person holds none. */
	| { none: true };

/**
 * Join the one folder attached to `app` (the client id it signs in as) that
 * `account`'s person holds. An app's token joins only its own app's folder.
 */
export async function joinApp(
	account: RemoteAccount,
	app: string,
): Promise<Result<Joined, Unavailable>> {
	const { folders } = resolveOAuthAudiences(account.baseURL);
	const answered = await ask(account, folderUrl(folders), json({ join: app }));
	if (answered.error !== null) return answered;
	const { status, body } = answered.data;
	if (
		status === 409 &&
		isRecord(body) &&
		body.error === 'choose' &&
		Array.isArray(body.folders)
	)
		return Ok({ choose: body.folders as string[] });
	if (status === 404 && isRecord(body) && body.error === 'none')
		return Ok({ none: true });
	const folder = folderOf(status, body);
	if (folder.error !== null) return folder;
	return Ok({ folder: folder.data });
}

/** An appended change's answer, read: landed, moved, refused, or the versions it lacks. */
type AppendAnswer =
	| ChangeReceipt
	| ChangeMoved
	| ChangeRefusal
	| { missing: Version[] };

function readAppendAnswer(
	status: number,
	body: unknown,
): Result<AppendAnswer, Unavailable> {
	const fields = isRecord(body) ? body : {};
	if (
		status === 200 &&
		typeof fields.cursor === 'string' &&
		isRecord(fields.versions)
	)
		return Ok({
			cursor: fields.cursor,
			versions: fields.versions as Record<string, Version | null>,
		});
	if (status === 409 && fields.error === 'moved' && Array.isArray(fields.moved))
		return Ok({ moved: fields.moved as ChangeMoved['moved'] });
	if (
		status === 409 &&
		fields.error === 'missing' &&
		Array.isArray(fields.missing)
	)
		return Ok({ missing: fields.missing as Version[] });
	if (
		status === 409 &&
		fields.error === 'refused' &&
		typeof fields.path === 'string'
	)
		return Ok({
			refused: fields.path,
			reason: typeof fields.message === 'string' ? fields.message : 'refused',
		});
	return refused(status, body);
}

/**
 * The folder `folder` on the server as `account` reaches it: what sync
 * needs, its store verbs (asking what changed every `pollMs` while
 * watched), and its history. A `folder` that is no folder id throws.
 */
export function folderRepository(
	account: RemoteAccount,
	folder: string,
	{
		pollMs = POLL_MS,
		batchMs = BATCH_MS,
	}: { pollMs?: number; batchMs?: number } = {},
) {
	if (!isFolderId(folder)) throw new Error(`'${folder}' is not a folder id`);
	const base = folderUrl(
		resolveOAuthAudiences(account.baseURL).folders,
		folder,
	);

	/** Versions this folder holds bytes for: put or read here, so never asked about again. */
	const held = new Set<string>();

	/** The head, and what changed since `since` (null: "compare every path"). */
	async function changes(since: string | null) {
		const query = since === null ? '' : `?since=${encodeURIComponent(since)}`;
		const answered = await ask(account, `${base}/changes${query}`);
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (
			status !== 200 ||
			!isRecord(body) ||
			typeof body.cursor !== 'string' ||
			(body.changes !== null && !Array.isArray(body.changes))
		)
			return refused(status, body);
		return Ok({
			cursor: body.cursor,
			changes: body.changes as ChangedPath[] | null,
		});
	}

	/** The files now, or as of `at` (a seq, a mark, or an ISO time), only `paths` when given, with inline bytes when asked. */
	async function filesAt({
		at,
		paths,
		bytes = false,
	}: {
		at?: string | number;
		paths?: readonly string[];
		bytes?: boolean;
	} = {}) {
		const answered = await ask(
			account,
			`${base}/files`,
			json({
				...(at === undefined ? {} : { at: String(at) }),
				...(paths === undefined ? {} : { paths }),
				...(bytes ? { bytes: true } : {}),
			}),
		);
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (status !== 200 || !isRecord(body) || !Array.isArray(body.files))
			return refused(status, body);
		const files: FileAt[] = [];
		for (const file of body.files as (FileEntry & { base64?: string })[]) {
			const entry: FileAt = {
				path: file.path,
				version: file.version,
				size: file.size,
			};
			if (file.base64 !== undefined) {
				const read = fromBase64(file.base64);
				if ((await versionOf(read)) !== file.version)
					return ClientError.Unavailable({
						cause: RemoteError.Corrupt({ id: file.version }).error,
					});
				entry.bytes = read;
				held.add(file.version);
			}
			files.push(entry);
		}
		return Ok({
			cursor: body.cursor as string,
			seq: body.seq as number,
			files,
		});
	}

	/** One version's bytes from `blobs/<sha256>`, checked against it: null when the folder holds none. */
	async function blobAt(
		version: Version,
	): Promise<Result<Uint8Array | null, Unavailable>> {
		let response: Response;
		try {
			response = await account.fetch(`${base}/blobs/${version}`);
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
		if ((await versionOf(bytes)) !== version)
			return ClientError.Unavailable({
				cause: RemoteError.Corrupt({ id: version }).error,
			});
		held.add(version);
		return Ok(bytes);
	}

	/** Each version's bytes, in order, in one request for the inline ones: null for one the folder holds none of. */
	async function blobs(
		versions: readonly Version[],
	): Promise<Result<(Uint8Array | null)[], Unavailable>> {
		if (versions.length === 0) return Ok([]);
		const answered = await ask(account, `${base}/blobs`, json({ versions }));
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (status !== 200 || !isRecord(body) || !Array.isArray(body.blobs))
			return refused(status, body);
		const out: (Uint8Array | null)[] = [];
		for (const [index, version] of versions.entries()) {
			const found = (body.blobs as unknown[])[index];
			if (!isRecord(found)) {
				out.push(null);
				continue;
			}
			if (typeof found.base64 === 'string') {
				const bytes = fromBase64(found.base64);
				if ((await versionOf(bytes)) !== version)
					return ClientError.Unavailable({
						cause: RemoteError.Corrupt({ id: version }).error,
					});
				held.add(version);
				out.push(bytes);
				continue;
			}
			const got = await blobAt(version);
			if (got.error !== null) return got;
			out.push(got.data);
		}
		return Ok(out);
	}

	/** Upload each of `bytes` the folder lacks: it asks which, then puts only those. */
	async function uploadMissing(
		uploads: readonly { version: Version; bytes: Uint8Array }[],
	): Promise<Result<null, Unavailable>> {
		const unknown = uploads.filter(({ version }) => !held.has(version));
		if (unknown.length === 0) return Ok(null);
		const answered = await ask(
			account,
			`${base}/blobs/missing`,
			json({ versions: [...new Set(unknown.map(({ version }) => version))] }),
		);
		if (answered.error !== null) return answered;
		const { status, body } = answered.data;
		if (status !== 200 || !isRecord(body) || !Array.isArray(body.missing))
			return refused(status, body);
		const missing = new Set(body.missing as string[]);
		for (const { version } of unknown)
			if (!missing.has(version)) held.add(version);
		const sent = new Set<string>();
		for (const { version, bytes } of unknown) {
			if (!missing.has(version) || sent.has(version)) continue;
			sent.add(version);
			const put = await ask(account, `${base}/blobs/${version}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/octet-stream' },
				body: bytes as Uint8Array<ArrayBuffer>,
			});
			if (put.error !== null) return put;
			if (put.data.status !== 200 && put.data.status !== 201)
				return refused(put.data.status, put.data.body);
			held.add(version);
		}
		return Ok(null);
	}

	/** One write as `POST changes` takes it: inline bytes, or a version uploaded first. */
	async function wireOf(write: {
		path: string;
		expect: Version | null;
		bytes: Uint8Array | null;
	}) {
		const { path, expect, bytes } = write;
		if (bytes === null) return { file: { path, expect, delete: true } };
		if (bytes.byteLength > INLINE_MAX) {
			const version = await versionOf(bytes);
			return { file: { path, expect, version }, upload: { version, bytes } };
		}
		let text: string | undefined;
		try {
			text = strict.decode(bytes);
		} catch {}
		return {
			file:
				text === undefined
					? { path, expect, base64: toBase64(bytes) }
					: { path, expect, text },
		};
	}

	/** Post `files` to `route` after uploading what the folder lacks; once more when it says some went missing. */
	async function send(
		route: 'changes' | 'import',
		body: (files: unknown[]) => unknown,
		prepared: {
			file: unknown;
			upload?: { version: Version; bytes: Uint8Array };
		}[],
	): Promise<Result<AppendAnswer, Unavailable>> {
		const uploads = prepared.flatMap(({ upload }) =>
			upload === undefined ? [] : [upload],
		);
		for (let attempt = 1; ; attempt++) {
			const uploaded = await uploadMissing(uploads);
			if (uploaded.error !== null) return uploaded;
			const answered = await ask(
				account,
				`${base}/${route}`,
				json(body(prepared.map(({ file }) => file))),
			);
			if (answered.error !== null) return answered;
			const read = readAppendAnswer(answered.data.status, answered.data.body);
			if (read.error !== null || !('missing' in read.data) || attempt === 2)
				return read;
			// Swept since it was uploaded: forget it, and upload it again.
			for (const version of read.data.missing) held.delete(version);
		}
	}

	async function append(
		writes: readonly {
			path: string;
			bytes: Uint8Array | null;
			expect: Version | null;
		}[],
	): Promise<Result<ChangeReceipt | ChangeMoved | ChangeRefusal, Unavailable>> {
		const sent = await send(
			'changes',
			(files) => ({ files }),
			await Promise.all(writes.map(wireOf)),
		);
		if (sent.error !== null) return sent;
		if ('missing' in sent.data)
			return refused(409, { error: 'missing', message: 'bytes went missing' });
		return Ok(sent.data);
	}

	const repository: Repository = {
		changes,
		async files() {
			const listed = await filesAt();
			if (listed.error !== null) return listed;
			return Ok({ cursor: listed.data.cursor, files: listed.data.files });
		},
		blobs,
		append,
	};

	/** One put, landed alone: `Moved` to what the path holds when it moved. */
	async function putAlone({
		path,
		bytes,
		expect,
	}: Waiting['write']): Promise<Result<Version | null, Moved | Unavailable>> {
		const landed = await append([{ path, bytes, expect }]);
		if (landed.error !== null) return landed;
		if ('moved' in landed.data)
			return StoreError.Moved({
				path,
				now:
					landed.data.moved.find((moved) => moved.path === path)?.now ?? null,
			});
		// A store's put has no refusal: the folder keeps it, saying why.
		if ('refused' in landed.data)
			return ClientError.Unavailable({ cause: landed.data.reason });
		return Ok(landed.data.versions[path] ?? null);
	}

	/** A put made within a moment of others, waiting to land with them. */
	type Waiting = {
		write: { path: string; bytes: Uint8Array | null; expect: Version | null };
		resolve(result: Result<Version | null, Moved | Unavailable>): void;
	};
	let waiting: Waiting[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let firstAt: number | null = null;

	/**
	 * Land every waiting put as one change (ADR-0823). When one of them
	 * moved, or the server refuses one, nothing lands, and each is put again
	 * alone, so each hears its own answer.
	 */
	async function flush() {
		const batch = waiting;
		waiting = [];
		firstAt = null;
		const paths = new Set(batch.map(({ write }) => write.path));
		if (batch.length === 1 || paths.size !== batch.length) {
			for (const { write, resolve } of batch) resolve(await putAlone(write));
			return;
		}
		const landed = await append(batch.map(({ write }) => write));
		if (landed.error !== null) {
			for (const { resolve } of batch) resolve(landed);
			return;
		}
		const receipt = landed.data;
		if ('moved' in receipt || 'refused' in receipt) {
			for (const { write, resolve } of batch) resolve(await putAlone(write));
			return;
		}
		for (const { write, resolve } of batch)
			resolve(Ok(receipt.versions[write.path] ?? null));
	}

	const store: Store = {
		async list(under): Promise<Result<Listed[], Unavailable>> {
			const listed = await filesAt();
			if (listed.error !== null) return listed;
			return Ok(
				listed.data.files
					.filter(({ path }) => within(path, under))
					.map(({ path, version, size }) => ({ path, version, size })),
			);
		},
		async read(paths): Promise<Result<FileRead[], Unavailable>> {
			if (paths.length === 0) return Ok([]);
			const listed = await filesAt({ paths, bytes: true });
			if (listed.error !== null) return listed;
			const byPath = new Map(
				listed.data.files.map((file) => [file.path, file]),
			);
			const large = listed.data.files.filter(
				(file) => file.bytes === undefined,
			);
			const read = await blobs(large.map(({ version }) => version));
			if (read.error !== null) return read;
			large.forEach((file, index) => {
				const bytes = read.data[index];
				if (bytes != null) file.bytes = bytes;
			});
			return Ok(
				paths.map((path): FileRead => {
					const file = byPath.get(path);
					return file?.bytes === undefined
						? { path, gone: true }
						: { path, bytes: file.bytes, version: file.version };
				}),
			);
		},
		batches: true,
		put(path, bytes, expect) {
			return new Promise((resolve) => {
				waiting.push({ write: { path, bytes, expect }, resolve });
				clearTimeout(timer);
				firstAt ??= Date.now();
				const wait = Math.max(
					0,
					Math.min(batchMs, firstAt + BATCH_MAX_MS - Date.now()),
				);
				timer = setTimeout(() => void flush(), wait);
			});
		},
		async watch(changed) {
			if (account.signal.aborted)
				return ClientError.Unavailable({ cause: 'the account was retired' });
			const first = await changes(null);
			if (first.error !== null) return first;
			/** The cursor the log was at when last asked. */
			let seen = first.data.cursor;
			let reachable = true;
			let stopped = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			async function poll() {
				if (stopped || account.signal.aborted) return;
				const asked = await changes(seen);
				if (stopped) return;
				if (asked.error !== null) {
					if (reachable) changed('all');
					reachable = false;
				} else {
					reachable = true;
					const { cursor, changes: paths } = asked.data;
					if (paths === null) changed('all');
					else if (paths.length > 0) changed(paths.map(({ path }) => path));
					seen = cursor;
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

	return {
		...repository,
		...store,
		filesAt,
		/**
		 * Changes of the log, at most `limit` (50 by default): after `after`
		 * oldest first, else at or before `at` (a seq, a mark, or an ISO
		 * time; the head when absent) newest first. With `path`, only the
		 * changes that wrote it: the file's history.
		 */
		async log({
			after,
			at,
			path,
			limit = 50,
		}: {
			after?: number;
			at?: string | number;
			path?: string;
			limit?: number;
		} = {}): Promise<Result<LoggedChange[], Unavailable>> {
			const query = new URLSearchParams({ limit: String(limit) });
			if (after !== undefined) query.set('after', String(after));
			if (at !== undefined) query.set('at', String(at));
			if (path !== undefined) query.set('path', path);
			const answered = await ask(account, `${base}/log?${query}`);
			if (answered.error !== null) return answered;
			const { status, body } = answered.data;
			if (status !== 200 || !isRecord(body) || !Array.isArray(body.changes))
				return refused(status, body);
			return Ok(body.changes as LoggedChange[]);
		},
		/** Every mark of the folder, by name. */
		async marks(): Promise<Result<Mark[], Unavailable>> {
			const answered = await ask(account, `${base}/marks`);
			if (answered.error !== null) return answered;
			const { status, body } = answered.data;
			if (status !== 200 || !isRecord(body) || !Array.isArray(body.marks))
				return refused(status, body);
			return Ok(body.marks as Mark[]);
		},
		/**
		 * Mark the folder's last change (or `seq`) as `name`: the mark, or
		 * `{ taken }` when the name marks another change and `move` was not
		 * asked, or `{ empty }` when there is no change to mark.
		 */
		async mark(
			name: string,
			{ seq, move = false }: { seq?: number; move?: boolean } = {},
		): Promise<
			Result<{ mark: Mark } | { taken: Mark } | { empty: true }, Unavailable>
		> {
			const answered = await ask(
				account,
				`${base}/marks/${encodeURIComponent(name)}`,
				json({ ...(seq === undefined ? {} : { seq }), move }, 'PUT'),
			);
			if (answered.error !== null) return answered;
			const { status, body } = answered.data;
			const fields = isRecord(body) ? body : {};
			if (status === 200 && isRecord(fields.mark))
				return Ok({ mark: fields.mark as Mark });
			if (status === 409 && fields.error === 'taken' && isRecord(fields.mark))
				return Ok({ taken: fields.mark as Mark });
			if (status === 409 && fields.error === 'empty')
				return Ok({ empty: true as const });
			return refused(status, body);
		},
		/**
		 * Land `writes` in one change, each naming a version the folder holds
		 * (null to delete): a restore, which moves no bytes.
		 */
		async appendVersions(
			writes: readonly NamedWrite[],
		): Promise<Result<AppendAnswer, Unavailable>> {
			const answered = await ask(
				account,
				`${base}/changes`,
				json({
					files: writes.map(({ path, expect, version }) =>
						version === null
							? { path, expect, delete: true }
							: { path, expect, version },
					),
				}),
			);
			if (answered.error !== null) return answered;
			return readAppendAnswer(answered.data.status, answered.data.body);
		},
		/**
		 * Land an import's `changes` in order (ADR-0826), each keeping its
		 * author, time, and message, uploading what the folder lacks first.
		 */
		async importChanges(
			changes: readonly ImportedChange[],
		): Promise<Result<AppendAnswer, Unavailable>> {
			const prepared = await Promise.all(
				changes.map(async (change) => ({
					change,
					files: await Promise.all(
						change.files.map(async (file) =>
							'version' in file
								? {
										file:
											file.version === null
												? { path: file.path, expect: file.expect, delete: true }
												: {
														path: file.path,
														expect: file.expect,
														version: file.version,
													},
									}
								: wireOf(file),
						),
					),
				})),
			);
			const flat = prepared.flatMap(({ files }) => files);
			let offset = 0;
			const shapes = prepared.map(({ change, files }) => {
				const start = offset;
				offset += files.length;
				return { change, start, end: offset };
			});
			return send(
				'import',
				(files) => ({
					changes: shapes.map(({ change, start, end }) => ({
						author: change.author,
						at: change.at.toISOString(),
						message: change.message,
						files: files.slice(start, end),
					})),
				}),
				flat,
			);
		},
		/** End the import: the folder takes ordinary changes only from now. */
		async importDone(): Promise<Result<null, Unavailable>> {
			const answered = await ask(
				account,
				`${base}/import`,
				json({ done: true }),
			);
			if (answered.error !== null) return answered;
			if (answered.data.status !== 200)
				return refused(answered.data.status, answered.data.body);
			return Ok(null);
		},
		/**
		 * Delete the folder, its log, and its bytes, only while it still
		 * imports (ADR-0827): `'abandoned'`; `'in use'` for a folder whose
		 * import finished, which is never deleted this way; or `'gone'` when
		 * the person holds no such folder, abandoned already.
		 */
		async importAbandon(): Promise<
			Result<'abandoned' | 'in use' | 'gone', Unavailable>
		> {
			const answered = await ask(
				account,
				`${base}/import`,
				json({ abandon: true }),
			);
			if (answered.error !== null) return answered;
			const { status, body } = answered.data;
			if (status === 200) return Ok('abandoned' as const);
			if (status === 409 && isRecord(body) && body.error === 'not_importing')
				return Ok('in use' as const);
			if (status === 403 || status === 404) return Ok('gone' as const);
			return refused(status, body);
		},
	};
}

/** A folder on the server, as `folderRepository` answers it. */
export type FolderRepository = ReturnType<typeof folderRepository>;
