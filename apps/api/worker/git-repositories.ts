/**
 * The hosted Git repository store: Cloudflare Artifacts behind `mountGitApp`
 * (ADR-0521).
 *
 * A folder's repository is named `<folder>.<tag>`, where `tag` is the first 16
 * hex characters of SHA-256 over the principal ID. The tag has no dot, so the
 * name splits back into one folder and one tag, and the principal ID never
 * appears in a URL.
 *
 * Connect uses the binding: it finds or creates the repository, then mints a
 * write token for it alone. Serving never touches the binding. The upstream
 * URL derives from the account and namespace, and Artifacts checks the token
 * the client sent.
 */

import type { GitRepositoryStore } from '@epicenter/server';

/** The slice of the Artifacts binding this store calls. */
export type ArtifactsNamespace = Pick<Artifacts, 'get' | 'create'>;

/** The message Artifacts gives each error this store handles. */
const MESSAGES: Partial<Record<ArtifactsErrorCode, RegExp>> = {
	NOT_FOUND: /^(?:ArtifactsError: )?Repository not found: /,
	ALREADY_EXISTS: /^(?:ArtifactsError: )?repo already exists: /,
};

/**
 * Whether `cause` is an Artifacts binding error with `code`. The binding
 * documents `.code`, but measured on 2026-10-14 in a deployed Worker its
 * errors arrive as a plain `Error` with no code, whose message carries the
 * kind: `ArtifactsError: Repository not found: <name>.` and
 * `ArtifactsError: repo already exists: <name>`. The message is the fallback.
 */
function isArtifactsError(cause: unknown, code: ArtifactsErrorCode): boolean {
	if (typeof cause !== 'object' || cause === null) return false;
	const { code: actual, message } = cause as Partial<ArtifactsError>;
	if (actual !== undefined) return actual === code;
	return typeof message === 'string' && MESSAGES[code]?.test(message) === true;
}

/** The first 16 lowercase hex characters of SHA-256 over the UTF-8 principal ID. */
async function principalTag(principal: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(principal),
	);
	return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

export function createArtifactsRepositoryStore({
	artifacts,
	accountId,
	namespace,
	ttlSeconds = 3600,
}: {
	artifacts: ArtifactsNamespace;
	accountId: string;
	namespace: string;
	ttlSeconds?: number;
}): GitRepositoryStore {
	const upstream = `https://${accountId}.artifacts.cloudflare.net/git/${namespace}`;

	async function findOrCreate(name: string): Promise<ArtifactsRepo> {
		try {
			return await artifacts.get(name);
		} catch (cause) {
			if (!isArtifactsError(cause, 'NOT_FOUND')) throw cause;
		}
		try {
			// create() also mints a token; connect mints its own below so every
			// answer carries the same scope and lifetime.
			await artifacts.create(name, { setDefaultBranch: 'main' });
		} catch (cause) {
			// Another connect created it between our get() and create().
			if (!isArtifactsError(cause, 'ALREADY_EXISTS')) throw cause;
		}
		return await artifacts.get(name);
	}

	return {
		async connect(principal, folder) {
			const name = `${folder}.${await principalTag(principal)}`;
			const repository = await findOrCreate(name);
			const token = await repository.createToken('write', ttlSeconds);
			return { name, token: token.plaintext, expiresAt: token.expiresAt };
		},
		serve(name, { service, advertisement, headers, body, signal }) {
			const path = advertisement
				? `/info/refs?service=${service}`
				: `/${service}`;
			return fetch(`${upstream}/${name}.git${path}`, {
				method: advertisement ? 'GET' : 'POST',
				headers,
				body,
				signal,
				redirect: 'manual',
			});
		},
	};
}
