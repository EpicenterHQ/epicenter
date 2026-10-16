/**
 * The hosted Git store on Cloudflare Artifacts, behind `mountGitHost`
 * (ADR-0546).
 *
 * One Artifacts namespace per environment holds every repository, each named
 * by its immutable id (`repository.id`), so a rename or a move in Postgres
 * never reaches Artifacts and no URL shows an id. The Worker authorizes each
 * request itself, then reaches Artifacts with a token it mints: 24 hours,
 * for one repository and one scope (`read` for a fetch, `write` for a push),
 * cached in the isolate, renewed an hour before it ends, and dropped when
 * Artifacts refuses it. The client's credential never crosses.
 */

import type { GitHost } from '@epicenter/server';

/** The slice of the Artifacts binding this store calls. */
export type ArtifactsNamespace = Pick<Artifacts, 'get' | 'create'>;

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

export function createArtifactsGitHost({
	artifacts,
	accountId,
	namespace,
	now = Date.now,
}: {
	artifacts: ArtifactsNamespace;
	accountId: string;
	namespace: string;
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

	return {
		async create(id) {
			try {
				await artifacts.create(id, { setDefaultBranch: 'main' });
			} catch (cause) {
				// Another first push, or an earlier one that stopped, made it.
				if (!isArtifactsError(cause, 'ALREADY_EXISTS')) throw cause;
			}
		},
		async serve(id, { service, advertisement, headers, body, signal }) {
			const scope = service === 'git-receive-pack' ? 'write' : 'read';
			const pending = token(id, scope);
			const credential = await pending;
			const upstreamHeaders = new Headers(headers);
			upstreamHeaders.set('authorization', `Basic ${btoa(`x:${credential}`)}`);
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
			return response;
		},
	};
}
