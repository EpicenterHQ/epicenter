/**
 * The HTTP a remote client speaks to its repository on the server: the write
 * translator (`epicenter/files`, `epicenter/file`, `epicenter/writes`) and
 * the Git LFS API, both under the repository's Git remote.
 *
 * The repository is `<git>/<owner>/<name>.git`, by default
 * `<git>/~/<contract name>.git` (decision 46): `~` is the signed-in person's
 * own namespace, and one repository holds one app's files (decision 19), so
 * its paths are the contract's paths. Another person's repository is
 * reached under their handle, through the grant they gave this account.
 *
 * Every request to the server goes through `account.fetch`, which carries
 * the account's credential and refuses once the account is retired. An LFS
 * action on another origin (a presigned storage URL) goes through a plain
 * `fetch`, with only the headers the server's answer names.
 */
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { ClientError, type Version } from '@epicenter/definition/contract';
import { lfsOid } from '@epicenter/definition/merge';
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * What a remote needs of a signed-in account: an `@epicenter/auth` `Account`,
 * named by shape so this package never loads authentication. `fetch` carries
 * the account's credential to its own server; `signal` aborts when the
 * account is retired.
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
	/** Bytes downloaded for an LFS object are not that object. */
	Corrupt: ({ oid }: { oid: string }) => ({
		message: `The bytes downloaded for ${oid} are not that object`,
		oid,
	}),
});
export type RemoteError = InferErrors<typeof RemoteError>;

/** One file of a write request, as the translator takes it. */
export type FileWrite =
	| { path: string; text: string; base?: Version }
	| { path: string; lfs: LfsObject; base?: Version }
	| { path: string; delete: true; base: Version };

export type LfsObject = { oid: string; size: number };

/** What the translator answers for a write that landed. */
export type WriteReceipt = {
	commit: string;
	paths: string[];
	blobs: Record<string, string | null>;
	outcomes: { path: string; landed: string; outcome: Outcome }[];
	replayed?: true;
};

export type Outcome =
	| 'written'
	| 'merged'
	| 'conflict'
	| 'conflict-copy'
	| 'unchanged'
	| 'deleted'
	| 'kept';

/** A write's answer: the receipt, or a refusal the caller turns into a client error. */
export type WriteAnswer =
	| { landed: true; receipt: WriteReceipt }
	| {
			landed: false;
			status: number;
			code: string | null;
			path: string | null;
			message: string;
	  };

/** One file on `main`: a note's text, or another file's LFS object. */
export type RemoteFile = {
	blob: Version;
	text?: string;
	lfs?: LfsObject | null;
};

type LfsAction = { href: string; header?: Record<string, string> };
type LfsAnswer = {
	oid: string;
	size: number;
	actions?: Partial<Record<'upload' | 'verify' | 'download', LfsAction>>;
	error?: { code: number; message: string };
};

const LFS_JSON = 'application/vnd.git-lfs+json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export type Wire = ReturnType<typeof createWire>;

/** The wire to the repository `<owner>/<name>` as `account` reaches it. */
export function createWire(account: RemoteAccount, repository: string) {
	const remote = `${resolveOAuthAudiences(account.baseURL).git}/${repository}.git`;
	const { origin } = new URL(remote);

	/** Send one request: the account's for the server, a plain one elsewhere. */
	async function send(
		url: string,
		init: RequestInit,
	): Promise<Result<Response, Unavailable>> {
		try {
			const sameOrigin = new URL(url).origin === origin;
			return Ok(await (sameOrigin ? account.fetch : fetch)(url, init));
		} catch (cause) {
			return ClientError.Unavailable({ cause });
		}
	}

	/** The JSON body of `response`, or null when it has none. */
	async function body(response: Response): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			return null;
		}
	}

	/** `Unavailable` for an answer this client does not expect. */
	async function refused(response: Response) {
		const answer = await body(response);
		const fields = isRecord(answer) ? answer : {};
		return ClientError.Unavailable({
			cause: RemoteError.Refused({
				status: response.status,
				code: typeof fields.error === 'string' ? fields.error : null,
				message:
					typeof fields.message === 'string'
						? fields.message
						: response.statusText,
			}).error,
		});
	}

	/** Ask the LFS batch API about `objects` for `operation`. */
	async function batch(
		operation: 'upload' | 'download',
		objects: LfsObject[],
	): Promise<Result<LfsAnswer[], Unavailable>> {
		const sent = await send(`${remote}/info/lfs/objects/batch`, {
			method: 'POST',
			headers: { accept: LFS_JSON, 'content-type': LFS_JSON },
			body: JSON.stringify({ operation, transfers: ['basic'], objects }),
		});
		if (sent.error !== null) return sent;
		if (!sent.data.ok) return refused(sent.data);
		const answer = await body(sent.data);
		if (!isRecord(answer) || !Array.isArray(answer.objects))
			return refused(sent.data);
		const answers = answer.objects as LfsAnswer[];
		const failed = answers.find((object) => object.error);
		if (failed?.error)
			return ClientError.Unavailable({
				cause: RemoteError.Refused({
					status: failed.error.code,
					code: 'lfs_object',
					message: failed.error.message,
				}).error,
			});
		return Ok(answers);
	}

	/** Run one LFS action. */
	async function act(
		action: LfsAction,
		init: RequestInit,
	): Promise<Result<Response, Unavailable>> {
		const headers = new Headers(init.headers);
		for (const [name, value] of Object.entries(action.header ?? {}))
			headers.set(name, value);
		const sent = await send(action.href, { ...init, headers });
		if (sent.error !== null) return sent;
		if (!sent.data.ok) return refused(sent.data);
		return sent;
	}

	return {
		/** The repository's Git remote. */
		remote,
		/** Every file on `main` under `root` (`''`: the whole repository). */
		async list(
			root: string,
		): Promise<
			Result<{ path: string; blob: Version; lfs?: LfsObject }[], Unavailable>
		> {
			const sent = await send(
				`${remote}/epicenter/files?root=${encodeURIComponent(root)}`,
				{ method: 'GET' },
			);
			if (sent.error !== null) return sent;
			if (!sent.data.ok) return refused(sent.data);
			const answer = await body(sent.data);
			if (!isRecord(answer) || !Array.isArray(answer.files))
				return refused(sent.data);
			return Ok(answer.files as { path: string; blob: Version }[]);
		},
		/** The file at `path` on `main`, or null when nothing is there. */
		async read(path: string): Promise<Result<RemoteFile | null, Unavailable>> {
			const sent = await send(
				`${remote}/epicenter/file?path=${encodeURIComponent(path)}`,
				{ method: 'GET' },
			);
			if (sent.error !== null) return sent;
			if (sent.data.status === 404) return Ok(null);
			if (!sent.data.ok) return refused(sent.data);
			const answer = await body(sent.data);
			if (!isRecord(answer) || typeof answer.blob !== 'string')
				return refused(sent.data);
			return Ok(answer as RemoteFile);
		},
		/**
		 * One write request: one commit on `main`, or a refusal. A capture
		 * resent with other bytes than its first landing (an edit made after
		 * a lost reply) is refused with that landing's receipt (409
		 * `CaptureMismatch`); it answers as that receipt, replayed, so the
		 * device lets go only of what landed and sends the rest as updates.
		 */
		async write(request: {
			captureId?: string;
			files: FileWrite[];
		}): Promise<Result<WriteAnswer, Unavailable>> {
			const sent = await send(`${remote}/epicenter/writes`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(request),
			});
			if (sent.error !== null) return sent;
			const answer = await body(sent.data);
			const fields = isRecord(answer) ? answer : {};
			if (sent.data.ok && typeof fields.commit === 'string')
				return Ok({ landed: true, receipt: fields as WriteReceipt });
			if (
				sent.data.status === 409 &&
				fields.error === 'CaptureMismatch' &&
				isRecord(fields.receipt) &&
				typeof fields.receipt.commit === 'string' &&
				isRecord(fields.receipt.blobs)
			)
				return Ok({
					landed: true,
					receipt: {
						...(fields.receipt as WriteReceipt),
						replayed: true,
					},
				});
			if (sent.data.status !== 400 && sent.data.status !== 409)
				return refused(sent.data);
			return Ok({
				landed: false,
				status: sent.data.status,
				code: typeof fields.error === 'string' ? fields.error : null,
				path: typeof fields.path === 'string' ? fields.path : null,
				message: typeof fields.message === 'string' ? fields.message : '',
			});
		},
		/**
		 * Store each of `files`' bytes as an LFS object (upload, then verify),
		 * skipping the ones the server already has. Returns their objects in
		 * order.
		 */
		async upload(
			files: Uint8Array[],
		): Promise<Result<LfsObject[], Unavailable>> {
			const objects = await Promise.all(
				files.map(async (bytes) => ({
					oid: await lfsOid(bytes),
					size: bytes.byteLength,
				})),
			);
			if (objects.length === 0) return Ok([]);
			const answered = await batch('upload', objects);
			if (answered.error !== null) return answered;
			for (const answer of answered.data) {
				const { upload, verify } = answer.actions ?? {};
				if (upload === undefined) continue;
				const index = objects.findIndex(({ oid }) => oid === answer.oid);
				const bytes = files[index];
				if (bytes === undefined) continue;
				const put = await act(upload, {
					method: 'PUT',
					headers: { 'content-type': 'application/octet-stream' },
					body: bytes as Uint8Array<ArrayBuffer>,
				});
				if (put.error !== null) return put;
				if (verify === undefined) continue;
				const verified = await act(verify, {
					method: 'POST',
					headers: { accept: LFS_JSON, 'content-type': LFS_JSON },
					body: JSON.stringify({ oid: answer.oid, size: answer.size }),
				});
				if (verified.error !== null) return verified;
			}
			return Ok(objects);
		},
		/** The bytes of one LFS object, checked against its oid. */
		async download(
			object: LfsObject,
		): Promise<Result<Uint8Array, Unavailable>> {
			const answered = await batch('download', [object]);
			if (answered.error !== null) return answered;
			const action = answered.data[0]?.actions?.download;
			if (action === undefined)
				return ClientError.Unavailable({
					cause: RemoteError.Refused({
						status: 404,
						code: 'lfs_object',
						message: `${object.oid} has no download`,
					}).error,
				});
			const got = await act(action, { method: 'GET' });
			if (got.error !== null) return got;
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(await got.data.arrayBuffer());
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
			if (
				bytes.byteLength !== object.size ||
				(await lfsOid(bytes)) !== object.oid
			)
				return ClientError.Unavailable({
					cause: RemoteError.Corrupt({ oid: object.oid }).error,
				});
			return Ok(bytes);
		},
	};
}
