/**
 * Out-of-band (OOB) OAuth 2.1 authorization-code launcher for the CLI.
 *
 * Prints an authorize URL, optionally opens it in the user's browser,
 * waits for the user to paste the one-time code from
 * `https://api.epicenter.so/cli-callback`, then exchanges the code
 * at `/auth/oauth2/token` with PKCE. Returns a completed OAuth launch result
 * containing a 3-field `OAuthTokenGrant`.
 *
 * The launcher is concerned only with the OAuth dance. The caller pairs the
 * returned grant with `GET /api/session` to fill in the persisted `principalId`.
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth-clients';
import { OAUTH_ROUTES } from '@epicenter/constants/oauth-routes';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch } from '../auth-contract.js';
import type {
	OAuthLauncher,
	OAuthLaunchResult,
} from '../oauth-launchers/contract.js';
import { parseOAuthTokenGrant } from '../oauth-token-endpoints.js';

/**
 * CLI transport failures before machine auth can persist a session.
 *
 * These errors intentionally describe OOB mechanics only: browser opening,
 * pasted-code cancellation, and token endpoint response shape. `/api/session`
 * identity lookup belongs to `loginWithOob`.
 */
const OobLauncherError = defineErrors({
	TokenExchangeFailed: ({
		status,
		body,
		cause,
	}: {
		status: number;
		body: string;
		cause?: unknown;
	}) => ({
		message: `OAuth token exchange failed with status ${status}: ${body}`,
		status,
		body,
		cause,
	}),
	InvalidTokenResponse: ({ cause }: { cause: unknown }) => ({
		message: `Invalid OAuth token response: ${extractErrorMessage(cause)}`,
		cause,
	}),
	AuthorizationCancelled: () => ({
		message: 'No code pasted. Cancelled.',
	}),
});

type OobLauncherError = InferErrors<typeof OobLauncherError>;

type CreateOobOAuthLauncherConfig = {
	/**
	 * Epicenter API origin. The default points at production.
	 */
	baseURL?: string;
	/**
	 * Public OAuth client id for CLI login.
	 */
	clientId: string;
	/**
	 * OOB callback registered for this API deployment.
	 *
	 * Production callers should use the default. Tests and local deployments pass
	 * this only when the trusted OAuth client table was seeded with a different
	 * callback URL.
	 */
	redirectUri?: string;
	/**
	 * OAuth scopes requested by the CLI. Defaults to Epicenter's app-client scope.
	 */
	scopes?: readonly string[];
	/**
	 * Best-effort browser opener. The printed URL remains the source of truth.
	 */
	openBrowser?: (url: string) => Promise<void> | void;
	/**
	 * Reads the one-time code pasted from the hosted CLI callback page.
	 */
	readCode?: () => Promise<string>;
	/**
	 * Output sink for the authorize URL and paste prompt.
	 */
	print?: (line: string) => void;
	/**
	 * Fetch implementation used only for the token exchange.
	 */
	fetch?: AuthFetch;
	/**
	 * Clock used to convert `expires_in` into the persisted grant refresh hint.
	 */
	now?: () => number;
};

/**
 * Create the CLI out-of-band OAuth launcher.
 *
 * Use this for one-shot human login from terminals where a localhost callback
 * is not guaranteed. It prints the authorize URL, exchanges the pasted code
 * with PKCE, and returns a completed launch result with the OAuth grant. The
 * caller must still call `/api/session` before persisting anything, preserving
 * the split between network credentials and replica attachment identity.
 */
export function createOobOAuthLauncher({
	baseURL = EPICENTER_API_URL,
	clientId,
	redirectUri = OAUTH_ROUTES.cliCallback.url(baseURL),
	scopes = EPICENTER_OAUTH_SCOPES,
	openBrowser = defaultOpenBrowser,
	readCode = defaultReadCode,
	print = (line) => process.stdout.write(`${line}\n`),
	fetch = globalThis.fetch.bind(globalThis),
	now = Date.now,
}: CreateOobOAuthLauncherConfig) {
	return {
		async startSignIn(): Promise<Result<OAuthLaunchResult, OobLauncherError>> {
			const verifierBytes = new Uint8Array(32);
			globalThis.crypto.getRandomValues(verifierBytes);
			const codeVerifier = base64UrlEncode(verifierBytes);
			const challengeBytes = new Uint8Array(
				await globalThis.crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode(codeVerifier),
				),
			);
			const codeChallenge = base64UrlEncode(challengeBytes);
			const authorizeUrl = new URL(OAUTH_ROUTES.authorize.url(baseURL));
			authorizeUrl.search = new URLSearchParams({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: redirectUri,
				scope: scopes.join(' '),
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
				resource: baseURL,
			}).toString();

			print(authorizeUrl.toString());
			print(
				'Open the URL above to sign in, then paste the code shown on the success page:',
			);

			try {
				await openBrowser(authorizeUrl.toString());
			} catch {
				// best-effort; the printed URL is the source of truth
			}

			const pastedCode = (await readCode()).trim();
			if (pastedCode === '') {
				return Err(OobLauncherError.AuthorizationCancelled().error);
			}

			let response: Response;
			try {
				response = await fetch(OAUTH_ROUTES.token.url(baseURL), {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					credentials: 'omit',
					body: new URLSearchParams({
						grant_type: 'authorization_code',
						code: pastedCode,
						code_verifier: codeVerifier,
						client_id: clientId,
						redirect_uri: redirectUri,
						resource: baseURL,
					}),
				});
			} catch (cause) {
				return Err(
					OobLauncherError.TokenExchangeFailed({
						status: 0,
						body: extractErrorMessage(cause),
						cause,
					}).error,
				);
			}

			if (!response.ok) {
				let body = '';
				try {
					body = await response.text();
				} catch {
					// fall through with empty body
				}
				return Err(
					OobLauncherError.TokenExchangeFailed({
						status: response.status,
						body,
					}).error,
				);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch (cause) {
				return Err(OobLauncherError.InvalidTokenResponse({ cause }).error);
			}

			const { data: grant, error } = parseOAuthTokenGrant(payload, { now });
			if (error) {
				return Err(
					OobLauncherError.InvalidTokenResponse({ cause: error }).error,
				);
			}
			return Ok({ status: 'completed', grant } satisfies OAuthLaunchResult);
		},
	} satisfies OAuthLauncher;
}

function base64UrlEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

async function defaultOpenBrowser(url: string): Promise<void> {
	const command = pickOpenCommand();
	if (!command) return;
	const [file, ...args] = command;
	try {
		const child = spawn(file, [...args, url], {
			stdio: 'ignore',
			detached: true,
		});
		// Spawn failures (e.g. missing xdg-open) arrive as async 'error' events;
		// an unhandled one would crash the process. Best-effort: the printed URL
		// is the source of truth.
		child.on('error', () => {});
		child.unref();
	} catch {
		// swallow; the printed URL is the source of truth
	}
}

function pickOpenCommand(): [string, ...string[]] | null {
	switch (process.platform) {
		case 'darwin':
			return ['open'];
		case 'win32':
			return ['cmd', '/c', 'start', ''];
		case 'linux':
		case 'freebsd':
		case 'openbsd':
		case 'sunos':
			return ['xdg-open'];
		default:
			return null;
	}
}

function defaultReadCode(): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false,
		});
		rl.question('Paste the code from the success page here: ', (line) => {
			rl.close();
			resolve(line);
		});
	});
}
