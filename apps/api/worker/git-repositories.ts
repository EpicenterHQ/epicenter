/**
 * The hosted Git store on Cloudflare Artifacts, behind `mountGitHost`
 * (ADR-0546). Clone and fetch are proxied to Artifacts. With the receiver
 * (`receiver: true`, which `resolveArtifactsGitHost` sets only when an R2
 * LFS store is bound), pushes, web writes and LFS go through
 * `@epicenter/server`'s receiver and translator over `objects`
 * (`artifacts-objects.ts`), so Artifacts' own receive-pack is only ever
 * called by this Worker. Without it, every Git request is proxied as before
 * the receiver, and the host has no `objects`.
 *
 * One Artifacts namespace per environment holds every repository, each named
 * by its immutable id (`repository.id`), so a rename or a move in Postgres
 * never reaches Artifacts and no URL shows an id. The Worker authorizes each
 * request itself, then reaches Artifacts with a token it mints: 24 hours,
 * for one repository and one scope (`read` for a fetch, `write` for a push),
 * cached in the isolate, renewed an hour before it ends, and dropped when
 * Artifacts refuses it or the repository is deleted. The client's credential never crosses.
 *
 * With the receiver, receipt refs (`refs/epicenter/captures/*`, decision
 * 50) are hidden from clients: upload-pack is asked for protocol v0, whose
 * one advertisement this proxy filters, instead of v2's `ls-refs`.
 */

import {
	FLUSH,
	type GitHost,
	pktLine,
	readCommandLines,
} from '@epicenter/server';
import {
	type ArtifactsReader,
	createArtifactsObjects,
} from './artifacts-objects.js';
import { type LfsBindings, resolveR2Lfs } from './lfs-store.js';

/** The slice of the Artifacts binding this store calls. */
export type ArtifactsNamespace = Pick<Artifacts, 'get' | 'create' | 'delete'>;

/** How long a minted token lives, and how long before its end it is replaced. */
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const RENEW_BEFORE_MS = 60 * 60 * 1000;
/** The most tokens one isolate keeps; the oldest go first. */
const MAX_CACHED_TOKENS = 512;

/** The message Artifacts gives each error this store handles. */
const MESSAGES: Partial<Record<ArtifactsErrorCode, RegExp>> = {
	ALREADY_EXISTS: /^(?:ArtifactsError: )?repo already exists: /,
};

/**
 * Whether `cause` is an Artifacts binding error with `code`. The binding
 * documents `.code`, but measured on 2026-10-14 in a deployed Worker its
 * errors arrive as a plain `Error` with no code, whose message carries the
 * kind: `ArtifactsError: repo already exists: <name>`. The message is the
 * fallback.
 */
function isArtifactsError(cause: unknown, code: ArtifactsErrorCode): boolean {
	if (typeof cause !== 'object' || cause === null) return false;
	const { code: actual, message } = cause as Partial<ArtifactsError>;
	if (actual !== undefined) return actual === code;
	return typeof message === 'string' && MESSAGES[code]?.test(message) === true;
}

type CachedToken = { token: Promise<string>; renewAt: number };

/** Refs no client sees: the translator's receipts. */
const HIDDEN_REFS = 'refs/epicenter/captures/';

/**
 * A protocol v0 upload-pack advertisement without the hidden refs. The
 * capabilities ride on the first ref line, so they move to the first line
 * kept; with none kept, they ride on `capabilities^{}` as for an empty
 * repository.
 */
export async function hideRefs(response: Response): Promise<Response> {
	const body = new Uint8Array(await response.arrayBuffer());
	const service = readCommandLines(body);
	const advertised = readCommandLines(service.rest);
	let capabilities: string | undefined;
	const kept: string[] = [];
	for (const [index, line] of advertised.lines.entries()) {
		const [head = '', caps] = line.replace(/\n$/, '').split('\0');
		if (index === 0) capabilities = caps;
		const ref = head.split(' ')[1] ?? '';
		if (ref.startsWith(HIDDEN_REFS) || ref === 'capabilities^{}') continue;
		kept.push(head);
	}
	const lines = kept.map((head, index) =>
		index === 0 && capabilities !== undefined
			? `${head}\0${capabilities}\n`
			: `${head}\n`,
	);
	if (lines.length === 0 && capabilities !== undefined)
		lines.push(`${'0'.repeat(40)} capabilities^{}\0${capabilities}\n`);
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	headers.delete('content-encoding');
	return new Response(
		new Blob([
			...service.lines.map((line) => pktLine(line)),
			FLUSH,
			...lines.map((line) => pktLine(line)),
			FLUSH,
		] as BlobPart[]),
		{ status: response.status, statusText: response.statusText, headers },
	);
}

/** The bindings hosted Git reads: Artifacts, and the R2 LFS store. */
export type GitBindings = LfsBindings & {
	ARTIFACTS?: ArtifactsNamespace;
	ARTIFACTS_NAMESPACE?: string;
};

/**
 * The deployment's Artifacts host, or null when Artifacts is not bound
 * (the local dev launcher removes it, and hosted Git answers 503). The
 * receiver comes only with an R2 LFS store (`resolveR2Lfs`): without one,
 * it would refuse every push that holds a file other than a note, so the
 * host proxies every request as before the receiver until all four LFS
 * bindings are there.
 */
export function resolveArtifactsGitHost(env: GitBindings): GitHost | null {
	const { ARTIFACTS, ARTIFACTS_ACCOUNT_ID, ARTIFACTS_NAMESPACE } = env;
	if (!ARTIFACTS || !ARTIFACTS_ACCOUNT_ID || !ARTIFACTS_NAMESPACE) return null;
	return createArtifactsGitHost({
		artifacts: ARTIFACTS,
		accountId: ARTIFACTS_ACCOUNT_ID,
		namespace: ARTIFACTS_NAMESPACE,
		receiver: resolveR2Lfs(env) !== null,
	});
}

export function createArtifactsGitHost({
	artifacts,
	accountId,
	namespace,
	receiver,
	now = Date.now,
}: {
	artifacts: ArtifactsNamespace;
	accountId: string;
	namespace: string;
	/** Whether pushes, web writes and LFS go through the receiver (`objects`). */
	receiver: boolean;
	now?: () => number;
}): GitHost {
	const upstream = `https://${accountId}.artifacts.cloudflare.net/git/${namespace}`;
	const tokens = new Map<string, CachedToken>();

	/** A token for `id` and `scope`, from this isolate's cache or newly minted. */
	function token(id: string, scope: 'read' | 'write'): Promise<string> {
		const key = `${scope}:${id}`;
		const cached = tokens.get(key);
		if (cached !== undefined && now() < cached.renewAt) return cached.token;
		const minted = (async () => {
			const repository = await artifacts.get(id);
			const created = await repository.createToken(scope, TOKEN_TTL_SECONDS);
			return created.plaintext;
		})();
		tokens.delete(key);
		tokens.set(key, {
			token: minted,
			renewAt: now() + TOKEN_TTL_SECONDS * 1000 - RENEW_BEFORE_MS,
		});
		for (const oldest of tokens.keys()) {
			if (tokens.size <= MAX_CACHED_TOKENS) break;
			tokens.delete(oldest);
		}
		// A failed mint is not kept: the next request asks again.
		minted.catch(() => {
			if (tokens.get(key)?.token === minted) tokens.delete(key);
		});
		return minted;
	}

	const host: GitHost = {
		async create(id) {
			try {
				await artifacts.create(id, { setDefaultBranch: 'main' });
			} catch (cause) {
				// Another first push, or an earlier one that stopped, made it.
				if (!isArtifactsError(cause, 'ALREADY_EXISTS')) throw cause;
			}
		},
		async delete(id) {
			// `false` is a repository that was not there.
			await artifacts.delete(id);
			tokens.delete(`read:${id}`);
			tokens.delete(`write:${id}`);
		},
		async serve(id, { service, advertisement, headers, body, signal }) {
			const scope = service === 'git-receive-pack' ? 'write' : 'read';
			const pending = token(id, scope);
			const credential = await pending;
			const upstreamHeaders = new Headers(headers);
			upstreamHeaders.set('authorization', `Basic ${btoa(`x:${credential}`)}`);
			// Protocol v0, so the one advertisement can be filtered.
			if (receiver && service === 'git-upload-pack')
				upstreamHeaders.delete('git-protocol');
			const path = advertisement
				? `/info/refs?service=${service}`
				: `/${service}`;
			const response = await fetch(`${upstream}/${id}.git${path}`, {
				method: advertisement ? 'GET' : 'POST',
				headers: upstreamHeaders,
				body,
				signal,
				redirect: 'manual',
			});
			// A refused token is not kept, or every request for a day would
			// present it again: the next request mints a new one.
			const key = `${scope}:${id}`;
			if (
				(response.status === 401 || response.status === 403) &&
				tokens.get(key)?.token === pending
			)
				tokens.delete(key);
			return receiver &&
				service === 'git-upload-pack' &&
				advertisement &&
				response.ok
				? hideRefs(response)
				: response;
		},
	};
	if (!receiver) return host;
	return {
		...host,
		objects(id) {
			return createArtifactsObjects({
				remote: `${upstream}/${id}.git`,
				token: () => {
					const value = token(id, 'write');
					return {
						value,
						refused: () => {
							if (tokens.get(`write:${id}`)?.token === value)
								tokens.delete(`write:${id}`);
						},
					};
				},
				repository: async () =>
					(await artifacts.get(id)) as unknown as ArtifactsReader,
			});
		},
	};
}
