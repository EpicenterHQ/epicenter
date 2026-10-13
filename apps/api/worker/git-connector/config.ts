/**
 * Deployment bindings and exact browser callbacks for the GitHub connector.
 * Kept free of `cloudflare:workers` so Bun tests read the same rules the
 * Worker and its Durable Object apply.
 */
import { APPS, localUrl } from '@epicenter/constants/apps';
import { importSealKey } from './crypto.js';
import type { GitHubAppCredentials } from './github.js';

/**
 * Every binding is optional in the type: a deployment without them answers
 * 503 `not_configured` instead of failing to boot or falling back to another
 * credential. The GitHub App client is separate from Epicenter sign-in's
 * `GITHUB_CLIENT_ID` and must not reuse it.
 */
export type GitConnectorBindings = {
	/** Base64 (standard or URL-safe) of exactly 32 random bytes; seals GitHub grants. */
	GIT_GRANT_ENCRYPTION_KEY?: string;
	GIT_GITHUB_CLIENT_ID?: string;
	GIT_GITHUB_CLIENT_SECRET?: string;
	/** Public slug from `https://github.com/apps/<slug>`; enables install links. */
	GIT_GITHUB_APP_SLUG?: string;
};

export type GitConnectorSecrets = {
	sealKey: CryptoKey;
	app: GitHubAppCredentials;
};

/** Read the connector's secrets, or undefined when any is missing or malformed. */
export async function readGitConnectorSecrets(
	env: GitConnectorBindings,
): Promise<GitConnectorSecrets | undefined> {
	const clientId = env.GIT_GITHUB_CLIENT_ID?.trim();
	const clientSecret = env.GIT_GITHUB_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) return undefined;
	const sealKey = await importSealKey(env.GIT_GRANT_ENCRYPTION_KEY);
	if (!sealKey) return undefined;
	const appSlug = env.GIT_GITHUB_APP_SLUG?.trim();
	return {
		sealKey,
		app: {
			clientId,
			clientSecret,
			...(appSlug && /^[a-z0-9-]+$/i.test(appSlug) ? { appSlug } : {}),
		},
	};
}

/** Production destinations for a GitHub handoff code. */
export const ZHONGWEN_SYNC_CALLBACK = `${APPS.ZHONGWEN.url}/sync`;
export const TODOS_SYNC_CALLBACK = `${APPS.TODOS.url}/sync`;

/**
 * Exact `redirectUri` values the connector accepts. A loopback API origin
 * (local `wrangler dev`) also accepts development `/sync` pages; a deployed
 * origin accepts only production.
 */
export function gitHubConnectorCallbacks(apiOrigin: string): string[] {
	const { hostname } = new URL(apiOrigin);
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
	const zhongwenCallback = `${localUrl(APPS.ZHONGWEN)}/sync`;
	const zhongwenLoopback = new URL(zhongwenCallback);
	zhongwenLoopback.hostname = '127.0.0.1';
	const todosCallback = `${localUrl(APPS.TODOS)}/sync`;
	const todosLoopback = new URL(todosCallback);
	todosLoopback.hostname = '127.0.0.1';
	return [
		ZHONGWEN_SYNC_CALLBACK,
		TODOS_SYNC_CALLBACK,
		...(local
			? [zhongwenCallback, zhongwenLoopback.href, todosCallback, todosLoopback.href]
			: []),
	];
}
