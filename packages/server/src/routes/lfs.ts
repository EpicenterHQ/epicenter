/**
 * The Git LFS API of a hosted repository, under its Git remote
 * (`<git>/<namespace>/<name>.git/info/lfs/...`), so stock `git lfs` finds it
 * from the remote alone:
 *
 * ```txt
 * POST objects/batch     download: folders:read, read;  upload: folders:write, push
 * PUT  objects/<oid>     folders:write, push   the bytes; stored only when their sha256 is <oid>
 * GET  objects/<oid>     folders:read, read
 * POST verify            folders:write, push   { oid, size }: 200 when stored with that size
 * *    locks...          404: locking is not offered
 * ```
 *
 * The batch's actions point back at these routes, carrying no credential,
 * and leave `authenticated` unset: that is what tells `git lfs` to find a
 * credential for the action's URL (its credential helper, or
 * `http.<url>.extraHeader`). `authenticated: true` would tell it none is
 * needed, and it would retry the refused request without one forever. A
 * browser sends `account.fetch`'s. On R2 (phase 7) the actions become
 * presigned URLs, which carry their own authorization and should say
 * `authenticated: true`.
 *
 * `git.ts` authorizes every request and resolves the repository first.
 */
import { LFS_OID, type LfsObject, type LfsStore } from '../lfs/lfs-store.js';

export const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
const EXPIRES_IN = 3600;

export const lfsJson = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': LFS_CONTENT_TYPE, 'cache-control': 'no-store' },
	});

export type LfsBatch = {
	operation: 'upload' | 'download';
	objects: LfsObject[];
};

/** The batch request in `body`, or a reason it is not one. */
export function readBatch(body: unknown): LfsBatch | string {
	if (typeof body !== 'object' || body === null) return 'not a batch request';
	const { operation, objects, transfers } = body as Record<string, unknown>;
	if (operation !== 'upload' && operation !== 'download')
		return 'operation must be upload or download';
	if (!Array.isArray(objects) || objects.length > 1000)
		return 'objects must be a list of at most 1000';
	if (Array.isArray(transfers) && !transfers.includes('basic'))
		return 'only the basic transfer is offered';
	return { operation, objects: objects as LfsObject[] };
}

const isObject = (o: unknown): o is LfsObject =>
	typeof o === 'object' &&
	o !== null &&
	typeof (o as LfsObject).oid === 'string' &&
	LFS_OID.test((o as LfsObject).oid) &&
	Number.isSafeInteger((o as LfsObject).size) &&
	(o as LfsObject).size >= 0;

/**
 * Answer a batch for `repositoryId` (null: the repository does not exist
 * yet, so nothing can be downloaded). `remote` is the repository's URL as
 * the client named it, ending `.git`.
 */
export async function answerBatch(
	store: LfsStore,
	repositoryId: string | null,
	{ operation, objects }: LfsBatch,
	remote: string,
): Promise<Response> {
	const out = await Promise.all(
		objects.map(async (object) => {
			if (!isObject(object))
				return {
					oid: (object as LfsObject)?.oid,
					size: (object as LfsObject)?.size,
					error: {
						code: 422,
						message: 'an oid is 64 hex digits and a size a whole number',
					},
				};
			const { oid, size } = object;
			const stored =
				repositoryId !== null && (await store.verified(repositoryId, object));
			const href = `${remote}/info/lfs/objects/${oid}`;
			if (operation === 'upload')
				return stored
					? { oid, size }
					: {
							oid,
							size,
							actions: {
								upload: { href, expires_in: EXPIRES_IN },
								verify: {
									href: `${remote}/info/lfs/verify`,
									expires_in: EXPIRES_IN,
								},
							},
						};
			return stored
				? {
						oid,
						size,
						actions: { download: { href, expires_in: EXPIRES_IN } },
					}
				: { oid, size, error: { code: 404, message: 'object not found' } };
		}),
	);
	return lfsJson({ transfer: 'basic', objects: out, hash_algo: 'sha256' });
}

/** Store one uploaded object, refusing bytes that are not `oid`. */
export async function putObject(
	store: LfsStore,
	repositoryId: string,
	oid: string,
	request: Request,
): Promise<Response> {
	if (!LFS_OID.test(oid)) return lfsJson({ message: 'not an LFS oid' }, 422);
	if (request.body === null) return lfsJson({ message: 'no body' }, 400);
	const length = request.headers.get('content-length');
	const size =
		length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
	const stored = await store.put(repositoryId, oid, request.body, size);
	if (stored.ok) return new Response(null, { status: 200 });
	return lfsJson(
		{
			message:
				stored.reason === 'hash-mismatch'
					? `the bytes' sha256 is not ${oid}`
					: stored.reason === 'size-mismatch'
						? 'the bytes are not the declared length'
						: 'the object is too large',
		},
		stored.reason === 'too-large' ? 413 : 422,
	);
}

export async function getObject(
	store: LfsStore,
	repositoryId: string,
	oid: string,
): Promise<Response> {
	const found = await store.get(repositoryId, oid);
	if (found === null) return lfsJson({ message: 'object not found' }, 404);
	return new Response(found.body, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(found.size),
			'cache-control': 'private, max-age=31536000, immutable',
		},
	});
}

export async function verifyObject(
	store: LfsStore,
	repositoryId: string,
	body: unknown,
): Promise<Response> {
	if (!isObject(body))
		return lfsJson({ message: 'expected { oid, size }' }, 422);
	return (await store.verified(repositoryId, body))
		? lfsJson({ message: 'verified' })
		: lfsJson({ message: 'object not uploaded with that size' }, 404);
}
