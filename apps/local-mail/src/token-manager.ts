/**
 * The live access token for one connected account.
 *
 * What is stored and what is held apart deliberately. `device.secrets` holds
 * the refresh token and nothing else (ADR-0310): it is the only part worth
 * keeping, it is the only part that cannot be re-derived, and it is the only
 * part a keychain should be asked to hold. The access token lives in this
 * object for the life of the process, because it expires in an hour and
 * persisting it would mean writing a secret to buy nothing.
 *
 * There is no proactive refresh-token expiry check, unlike `apps/local-books`.
 * Google returns no refresh-token expiry, so a dead grant is only discoverable
 * by attempting the refresh and reading `invalid_grant` back.
 */

import type { SecretError, SecretLabel, SecretStore } from '@epicenter/device';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { GmailClientIdentity, MailConfig } from './config.js';
import {
	type RefreshedAccess,
	type RefreshAccessError,
	refreshAccess,
} from './oauth.js';

export const TokenError = defineErrors({
	CredentialMissing: () => ({
		message:
			'No Gmail refresh token is stored for this account on this device.',
	}),
});
export type TokenError = InferErrors<typeof TokenError>;
export type TokenManagerError = TokenError | RefreshAccessError | SecretError;

export type TokenManager = {
	getValidAccessToken(): Promise<Result<string, TokenManagerError>>;
	forceRefresh(): Promise<Result<string, TokenManagerError>>;
};

/** Refresh a little early so an in-flight request never races expiry. */
const ACCESS_TOKEN_SKEW_MS = 2 * 60 * 1000;

export function isAccessTokenExpired(
	expiresAt: string,
	now: number,
	skewMs: number = ACCESS_TOKEN_SKEW_MS,
): boolean {
	return Date.parse(expiresAt) - now <= skewMs;
}

export function createTokenManager({
	config,
	identity,
	secrets,
	label,
	now,
}: {
	config: MailConfig;
	identity: GmailClientIdentity;
	secrets: SecretStore;
	/** What this account's refresh token is filed under (ADR-0310). */
	label: SecretLabel;
	now: () => number;
}): TokenManager {
	let access: RefreshedAccess | null = null;
	let pending: { previousRefreshToken: string; grant: RefreshedAccess } | null =
		null;
	let inFlight: Promise<Result<string, TokenManagerError>> | null = null;

	/** Publish access only after its replacement refresh credential is saved. */
	async function keepGrant(
		grant: RefreshedAccess,
		previousRefreshToken: string,
	) {
		access = null;
		if (grant.refreshToken !== previousRefreshToken) {
			pending = { previousRefreshToken, grant };
			const kept = await secrets.put(label, grant.refreshToken);
			if (kept.error !== null) return kept;
		}
		pending = null;
		access = grant;
		return Ok(grant.accessToken);
	}

	async function refreshOnce(
		force: boolean,
	): Promise<Result<string, TokenManagerError>> {
		const stored = await secrets.get(label);
		if (stored.error !== null) return stored;
		// A browser reload keeps the account record but clears its in-memory
		// credential. No request to Google has been made in this case.
		if (stored.data === null) {
			pending = null;
			access = null;
			return TokenError.CredentialMissing();
		}
		let refreshToken = stored.data;
		if (pending !== null) {
			const { grant, previousRefreshToken } = pending;
			// Reconnecting or removing the account supersedes an unsaved grant.
			// A write may also have landed despite returning an error.
			if (
				refreshToken === previousRefreshToken ||
				refreshToken === grant.refreshToken
			) {
				const kept = await keepGrant(grant, refreshToken);
				if (kept.error !== null) return kept;
				if (!force && !isAccessTokenExpired(grant.accessTokenExpiresAt, now()))
					return kept;
				refreshToken = grant.refreshToken;
			} else {
				pending = null;
			}
		}
		access = null;
		const refreshed = await refreshAccess({
			config,
			identity,
			refreshToken,
			now,
		});
		if (refreshed.error !== null) return refreshed;
		return keepGrant(refreshed.data, refreshToken);
	}

	function refresh(force: boolean): Promise<Result<string, TokenManagerError>> {
		inFlight ??= refreshOnce(force).finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	return {
		async getValidAccessToken() {
			if (inFlight !== null) return inFlight;
			if (
				access !== null &&
				!isAccessTokenExpired(access.accessTokenExpiresAt, now())
			) {
				return Ok(access.accessToken);
			}
			return refresh(false);
		},
		forceRefresh() {
			access = null;
			return refresh(true);
		},
	};
}
