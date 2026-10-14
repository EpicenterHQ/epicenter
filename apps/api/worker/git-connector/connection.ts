/**
 * One Epicenter principal's GitHub connection, independent of where it
 * lives. The Worker keeps exactly one per principal in a Durable Object;
 * tests keep one per principal in memory.
 *
 * The record has three independent parts:
 *
 * - Authorization transactions (`txn:<id>`): a `pending` transaction holds
 *   the connector's provider state and PKCE verifier while the person is on
 *   GitHub; after the callback it becomes a `handoff` that only the same
 *   principal can redeem with the browser's PKCE verifier. Both expire.
 * - The grant (`grant`): the sealed GitHub user token pair and the GitHub
 *   user it belongs to. Expiry, revocation, or a refresh that identifies a
 *   different person deletes it.
 * - Folder pairings (`pairing:<folderId>`): an explicit choice of one
 *   repository by numeric id and installation id, plus a branch. Each
 *   creation or replacement mints a new opaque `revision`; Git requests name
 *   the revision they were addressed to, so a replaced pairing retires every
 *   transport built for the old one. Pairings never expire and survive the
 *   grant; each remembers the GitHub user that made it, so a different
 *   GitHub user cannot use it without re-pairing.
 *
 * Git transfers are admitted for a pairing revision, or for a repository
 * named by owner and name with no pairing; either way the admitted request
 * receives a token scoped to one repository id, never the parent user token.
 *
 * Every operation runs exclusively, so concurrent transfers share one token
 * refresh and parallel redemptions observe each other's writes. Secrets are
 * stored only as SHA-256 hashes; provider tokens only sealed with AES-GCM.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	base64url,
	hashSecret,
	pkceChallenge,
	randomSecret,
	seal,
	secretMatches,
	unseal,
} from './crypto.js';
import type {
	GitHubClient,
	GitHubUser,
	InstallationView,
	ProviderFailure,
	RepositoryView,
	TokenGrant,
} from './github.js';

/** Unredeemed connect requests expire with GitHub's own code lifetime. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** The browser redeems the handoff code right after the redirect lands. */
export const HANDOFF_TTL_MS = 5 * 60 * 1000;
/** Live authorization transactions per principal; the oldest is dropped. */
export const MAX_TRANSACTIONS = 5;
/** Refresh this long before the access token's stated expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type ConnectorErrorCode =
	| 'github_authorization_required'
	| 'github_account_mismatch'
	| 'repository_unavailable'
	| 'pairing_not_found'
	| 'pairing_conflict'
	| 'pairing_superseded'
	| 'principal_mismatch'
	| 'access_denied'
	| 'authorization_failed'
	| 'invalid_grant'
	| 'credential_scoping_unsupported'
	| 'upstream_unavailable'
	| 'not_configured';

export type ConnectorError = {
	code: ConnectorErrorCode;
	/** GitHub App installation page, only for `repository_unavailable`. */
	installUrl?: string;
};

/** The repository a folder is paired with. Ids are the identity. */
export type PairedRepository = {
	id: number;
	installationId: number;
	/** Installation account id; the `target_id` used for scoping. */
	ownerId: number;
	/** Name and clone URL when the pairing was made. Never rewritten. */
	fullName: string;
	cloneUrl: string;
};

export type Pairing = {
	folderId: string;
	/**
	 * Opaque, minted on every creation or replacement. A Git request must
	 * name the current revision; any other is refused before a token is
	 * minted.
	 */
	revision: string;
	/** The GitHub user whose grant verified this pairing. */
	githubUserId: number;
	repository: PairedRepository;
	branch: string;
	pairedAt: number;
};

/**
 * Whether the stored grant belongs to the GitHub user that made a pairing.
 * Read from storage only: `ready` does not mean GitHub still honors the
 * grant; the next transfer's `/user` check decides that.
 */
export type PairingStatus =
	| 'ready'
	| 'github_authorization_required'
	| 'github_account_mismatch';

/** One selectable repository from discovery. */
export type RepositoryChoice = {
	id: number;
	installationId: number;
	ownerId: number;
	fullName: string;
	cloneUrl: string;
	defaultBranch: string;
	/** Selection requires push; a read-only repository is listed but refused. */
	push: boolean;
};

type Tokens = Pick<TokenGrant, 'accessToken' | 'refreshToken'>;

type GrantRecord = {
	user: GitHubUser;
	sealed: string;
	accessExpiresAt: number | null;
	refreshExpiresAt: number | null;
	/** When the grant can no longer produce a token; null for never. */
	expiresAt: number | null;
};

type TransactionBase = {
	principalId: string;
	expiresAt: number;
	redirectUri: string;
	browserState: string;
	browserChallenge: string;
};

export type Transaction =
	| (TransactionBase & {
			kind: 'pending';
			stateHash: string;
			providerVerifier: string;
			providerRedirectUri: string;
	  })
	| (TransactionBase & {
			kind: 'handoff';
			handoffHash: string;
			grant: GrantRecord;
	  });

/**
 * Keyed storage owned by one connection object. `schedule` asks the host to
 * call `sweep` at a time, or cancels when given undefined; reads already
 * treat expired entries as absent.
 */
export type ConnectionStorage = {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	list<T>(prefix: string): Promise<Map<string, T>>;
	schedule(at: number | undefined): Promise<void>;
};

export type BeginInput = {
	redirectUri: string;
	browserState: string;
	browserChallenge: string;
	providerRedirectUri: string;
};

export type CallbackInput = {
	transactionId: string;
	secret: string;
	/** Present when GitHub returned a code. */
	code?: string;
	/** Present when GitHub returned `error=...` instead. */
	providerError?: string;
};

/** Where the browser goes after the callback, success or failure. */
export type CallbackOutcome =
	| { redirectUri: string; browserState: string; handoffCode: string }
	| { redirectUri: string; browserState: string; error: ConnectorError };

export type CompleteInput = {
	transactionId: string;
	secret: string;
	verifier: string;
	redirectUri: string;
};

export type PairInput = {
	folderId: string;
	repositoryId: number;
	installationId: number;
	/** Defaults to the repository's default branch. */
	branch?: string;
	/** Replace an existing pairing, minting a new revision. */
	replace?: boolean;
};

/**
 * A repository named by owner and name, as a canonical clone URL
 * `https://github.com/<owner>/<name>.git` names it. The name only locates the
 * repository; access is decided by its id.
 */
export type RepositoryAddress = { owner: string; name: string };

/** What the edge needs to run one Git transfer. */
export type TransferGrant = {
	/** Token scoped to the admitted repository id. Never the parent token. */
	accessToken: string;
	/** Current clone URL, read by repository id with the scoped token. */
	cloneUrl: string;
};

export type Connection = ReturnType<typeof createGitHubConnection>;

const PRINCIPAL_KEY = 'principal';
const GRANT_KEY = 'grant';
const TXN_PREFIX = 'txn:';
const PAIRING_PREFIX = 'pairing:';

/** 16 random bytes as 22 base64url characters. */
function randomId(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function createGitHubConnection({
	id,
	storage,
	sealKey,
	github,
	now = Date.now,
}: {
	/** Public routing id, also bound into every sealed grant. */
	id: string;
	storage: ConnectionStorage;
	sealKey: CryptoKey;
	github: GitHubClient;
	now?: () => number;
}) {
	const sealContext = `github-connector/v2/${id}/grant`;

	let tail: Promise<unknown> = Promise.resolve();
	function exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const run = tail.then(operation, operation);
		tail = run.catch(() => undefined);
		return run;
	}

	/**
	 * The edge routes by principal, so a mismatch is a routing bug. An empty
	 * object belongs to whoever writes first.
	 */
	async function ownedBy(principalId: string): Promise<boolean> {
		const owner = await storage.get<string>(PRINCIPAL_KEY);
		return owner === undefined || owner === principalId;
	}

	async function transactions(): Promise<Map<string, Transaction>> {
		const all = await storage.list<Transaction>(TXN_PREFIX);
		for (const [key, txn] of all)
			if (txn.expiresAt <= now()) {
				await storage.delete(key);
				all.delete(key);
			}
		return all;
	}

	async function loadTransaction(
		transactionId: string,
	): Promise<Transaction | undefined> {
		const txn = await storage.get<Transaction>(TXN_PREFIX + transactionId);
		if (txn && txn.expiresAt <= now()) {
			await storage.delete(TXN_PREFIX + transactionId);
			return undefined;
		}
		return txn;
	}

	async function loadGrant(): Promise<GrantRecord | undefined> {
		const grant = await storage.get<GrantRecord>(GRANT_KEY);
		if (grant?.expiresAt != null && grant.expiresAt <= now()) {
			await storage.delete(GRANT_KEY);
			return undefined;
		}
		return grant;
	}

	/** Wake at the next transaction or grant expiry. Pairings never expire. */
	async function reschedule(): Promise<void> {
		const expiries = [...(await transactions()).values()].map(
			(txn) => txn.expiresAt,
		);
		const grant = await loadGrant();
		if (grant?.expiresAt != null) expiries.push(grant.expiresAt);
		await storage.schedule(expiries.length ? Math.min(...expiries) : undefined);
	}

	async function sealGrant(
		user: GitHubUser,
		tokens: TokenGrant,
	): Promise<GrantRecord> {
		return {
			user,
			sealed: await seal(sealKey, sealContext, {
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
			} satisfies Tokens),
			accessExpiresAt: tokens.accessExpiresAt,
			refreshExpiresAt: tokens.refreshExpiresAt,
			expiresAt: tokens.refreshToken
				? tokens.refreshExpiresAt
				: tokens.accessExpiresAt,
		};
	}

	/** The grant is confirmed unusable: forget it, keep every pairing. */
	async function revokeGrant(): Promise<Err<ConnectorError>> {
		await storage.delete(GRANT_KEY);
		await reschedule();
		return Err({ code: 'github_authorization_required' });
	}

	type Live = { grant: GrantRecord; accessToken: string };

	/**
	 * Ask GitHub who the token belongs to. This is the on-demand consent
	 * check: a person who revoked the app gets a 401 here even when the
	 * stored expiry says the token is live. Every use of the parent token
	 * passes through here first, including the first use after a refresh.
	 */
	async function confirm(
		grant: GrantRecord,
		tokens: Tokens,
		mayRefresh: boolean,
	): Promise<Result<Live, ConnectorError>> {
		const { data: user, error } = await github.user(tokens.accessToken);
		if (error === 'rejected')
			return mayRefresh && tokens.refreshToken
				? refresh(grant, tokens)
				: revokeGrant();
		if (error) return Err({ code: 'upstream_unavailable' });
		if (user.id !== grant.user.id) return revokeGrant();
		if (user.login !== grant.user.login) {
			grant = { ...grant, user };
			await storage.put(GRANT_KEY, grant);
		}
		return Ok({ grant, accessToken: tokens.accessToken });
	}

	/**
	 * Replace the token pair through GitHub's refresh flow. GitHub rotates
	 * refresh tokens, so the new pair is persisted before the identity check:
	 * losing it to a transient failure would strand the grant. The new token
	 * is used only after `/user` names the same GitHub user; if that check
	 * cannot run now, the next operation runs it against the stored pair.
	 */
	async function refresh(
		grant: GrantRecord,
		tokens: Tokens,
	): Promise<Result<Live, ConnectorError>> {
		const refreshExpired =
			grant.refreshExpiresAt !== null && grant.refreshExpiresAt <= now();
		if (!tokens.refreshToken || refreshExpired) return revokeGrant();
		const { data: renewed, error } = await github.refresh(tokens.refreshToken);
		if (error === 'unavailable') return Err({ code: 'upstream_unavailable' });
		if (error) return revokeGrant();
		const next = await sealGrant(grant.user, renewed);
		await storage.put(GRANT_KEY, next);
		await reschedule();
		return confirm(next, renewed, false);
	}

	/**
	 * A parent token that GitHub confirmed for the granted user just now,
	 * refreshed first when due or when `/user` rejects the stored one.
	 */
	async function liveParent(): Promise<Result<Live, ConnectorError>> {
		const grant = await loadGrant();
		if (!grant) return Err({ code: 'github_authorization_required' });
		const tokens = await unseal<Tokens>(sealKey, sealContext, grant.sealed);
		// A grant that fails to open (rotated key, tampering) is unusable.
		if (!tokens) return revokeGrant();
		const expiring =
			grant.accessExpiresAt !== null &&
			grant.accessExpiresAt - REFRESH_MARGIN_MS <= now();
		return expiring ? refresh(grant, tokens) : confirm(grant, tokens, true);
	}

	function unavailableRepository(): ConnectorError {
		return { code: 'repository_unavailable', installUrl: github.installUrl };
	}

	function providerError(failure: ProviderFailure): ConnectorError {
		return failure === 'denied'
			? unavailableRepository()
			: { code: 'upstream_unavailable' };
	}

	/**
	 * The first of this app's installations that the granted user can reach
	 * and `matches` accepts, read with the parent token. Its account id is the
	 * `target_id` for scoping.
	 */
	async function reachableInstallation(
		parentToken: string,
		matches: (installation: InstallationView) => boolean,
	): Promise<Result<InstallationView, ConnectorError>> {
		const { data: installations, error } =
			await github.installations(parentToken);
		if (error) return Err({ code: 'upstream_unavailable' });
		const installation = installations.find(matches);
		return installation ? Ok(installation) : Err(unavailableRepository());
	}

	/**
	 * Mint a token scoped to one repository id under one installation account,
	 * then read that repository by id with the scoped token. The installation
	 * listing is not used here: GitHub lists every repository in the
	 * installation even for a scoped token, so only a read by id shows what
	 * the token reaches. The mutable owner/name path is learned only after the
	 * credential is narrowed, and only from the repository id.
	 */
	async function scopedAccess(
		parentToken: string,
		target: Pick<PairedRepository, 'id' | 'ownerId'>,
	): Promise<Result<{ token: string; view: RepositoryView }, ConnectorError>> {
		const { data: token, error: scopeError } = await github.scopeToken({
			accessToken: parentToken,
			targetId: target.ownerId,
			repositoryId: target.id,
		});
		// GitHub answers 404 for an invalid parent token: the grant was revoked
		// between the `/user` check and this call.
		if (scopeError === 'rejected') return revokeGrant();
		if (scopeError === 'unsupported')
			return Err({ code: 'credential_scoping_unsupported' });
		if (scopeError === 'misconfigured') return Err({ code: 'not_configured' });
		if (scopeError === 'unavailable')
			return Err({ code: 'upstream_unavailable' });
		if (scopeError) return Err(unavailableRepository());

		const { data: view, error: readError } = await github.repository(
			token,
			target.id,
		);
		// The token was minted just now; a 401 for it says nothing about the grant.
		if (readError === 'rejected') return Err({ code: 'upstream_unavailable' });
		if (readError) return Err(providerError(readError));
		if (
			view.id !== target.id ||
			view.ownerId !== target.ownerId ||
			!view.private ||
			!view.pull ||
			!view.push
		)
			return Err(unavailableRepository());
		return Ok({ token, view });
	}

	/**
	 * The scoped token and current clone URL for one admitted Git request.
	 * Both transfer admissions end here; they differ only in how they choose
	 * the repository id and installation account.
	 */
	async function transferGrant(
		parentToken: string,
		target: Pick<PairedRepository, 'id' | 'ownerId'>,
	): Promise<Result<TransferGrant, ConnectorError>> {
		const { data: access, error } = await scopedAccess(parentToken, target);
		if (error) return Err(error);
		return Ok({ accessToken: access.token, cloneUrl: access.view.cloneUrl });
	}

	function loadPairing(folderId: string): Promise<Pairing | undefined> {
		return storage.get<Pairing>(PAIRING_PREFIX + folderId);
	}

	return {
		/**
		 * Open an authorization transaction for this principal and return
		 * GitHub's authorize URL. The provider state names this object and the
		 * transaction, so the unauthenticated callback reaches this record.
		 */
		begin(
			principalId: string,
			input: BeginInput,
		): Promise<Result<string, ConnectorError>> {
			return exclusive(async () => {
				if (!(await ownedBy(principalId)))
					return Err({ code: 'principal_mismatch' });
				await storage.put(PRINCIPAL_KEY, principalId);
				const live = [...(await transactions())].sort(
					([, a], [, b]) => a.expiresAt - b.expiresAt,
				);
				for (const [key] of live.slice(
					0,
					Math.max(0, live.length - MAX_TRANSACTIONS + 1),
				))
					await storage.delete(key);
				const transactionId = randomId();
				const secret = randomSecret();
				const providerVerifier = randomSecret();
				await storage.put(TXN_PREFIX + transactionId, {
					kind: 'pending',
					principalId,
					expiresAt: now() + PENDING_TTL_MS,
					redirectUri: input.redirectUri,
					browserState: input.browserState,
					browserChallenge: input.browserChallenge,
					stateHash: await hashSecret(secret),
					providerVerifier,
					providerRedirectUri: input.providerRedirectUri,
				} satisfies Transaction);
				await reschedule();
				return Ok(
					github.authorizeUrl({
						state: `${id}.${transactionId}.${secret}`,
						challenge: await pkceChallenge(providerVerifier),
						redirectUri: input.providerRedirectUri,
					}),
				);
			});
		},

		/**
		 * Consume the provider state and exchange the code. Unauthenticated: the
		 * state alone selects the transaction. Returns undefined when it names
		 * no live pending transaction, so the edge has no redirect to trust.
		 */
		callback(input: CallbackInput): Promise<CallbackOutcome | undefined> {
			return exclusive(async () => {
				const key = TXN_PREFIX + input.transactionId;
				const txn = await loadTransaction(input.transactionId);
				if (txn?.kind !== 'pending') return undefined;
				if (!(await secretMatches(input.secret, txn.stateHash)))
					return undefined;
				// Consume first: a replayed callback finds nothing to complete.
				await storage.delete(key);
				const fail = async (
					error: ConnectorError,
				): Promise<CallbackOutcome> => {
					await reschedule();
					return {
						redirectUri: txn.redirectUri,
						browserState: txn.browserState,
						error,
					};
				};
				if (input.providerError === 'access_denied')
					return fail({ code: 'access_denied' });
				if (!input.code) return fail({ code: 'authorization_failed' });

				const { data: tokens, error: exchangeError } =
					await github.exchangeCode({
						code: input.code,
						verifier: txn.providerVerifier,
						redirectUri: txn.providerRedirectUri,
					});
				if (exchangeError === 'unavailable')
					return fail({ code: 'upstream_unavailable' });
				if (exchangeError) return fail({ code: 'authorization_failed' });

				const { data: user, error: userError } = await github.user(
					tokens.accessToken,
				);
				if (userError === 'unavailable')
					return fail({ code: 'upstream_unavailable' });
				if (userError) return fail({ code: 'authorization_failed' });

				const handoffSecret = randomSecret();
				await storage.put(key, {
					kind: 'handoff',
					principalId: txn.principalId,
					expiresAt: now() + HANDOFF_TTL_MS,
					redirectUri: txn.redirectUri,
					browserState: txn.browserState,
					browserChallenge: txn.browserChallenge,
					handoffHash: await hashSecret(handoffSecret),
					grant: await sealGrant(user, tokens),
				} satisfies Transaction);
				await reschedule();
				return {
					redirectUri: txn.redirectUri,
					browserState: txn.browserState,
					handoffCode: `${input.transactionId}.${handoffSecret}`,
				};
			});
		},

		/**
		 * Redeem the handoff once, as the principal that began it, and install
		 * the grant, replacing any earlier one. Independent handoffs that both
		 * complete leave the grant of whichever completed last. A matching code
		 * with the wrong verifier or callback burns the handoff. Pairings are
		 * untouched: a different GitHub user does not inherit them.
		 */
		complete(
			principalId: string,
			input: CompleteInput,
		): Promise<Result<{ user: GitHubUser }, ConnectorError>> {
			return exclusive(async () => {
				const txn = await loadTransaction(input.transactionId);
				if (txn?.kind !== 'handoff' || txn.principalId !== principalId)
					return Err({ code: 'invalid_grant' });
				if (!(await secretMatches(input.secret, txn.handoffHash)))
					return Err({ code: 'invalid_grant' });
				await storage.delete(TXN_PREFIX + input.transactionId);
				if (
					(await pkceChallenge(input.verifier)) !== txn.browserChallenge ||
					input.redirectUri !== txn.redirectUri
				) {
					await reschedule();
					return Err({ code: 'invalid_grant' });
				}
				await storage.put(GRANT_KEY, txn.grant);
				await reschedule();
				return Ok({ user: txn.grant.user });
			});
		},

		/**
		 * Private repositories the granted user can reach through this app's
		 * installations. REST reads only; no Git request is made.
		 */
		repositories(
			principalId: string,
		): Promise<Result<RepositoryChoice[], ConnectorError>> {
			return exclusive(async () => {
				if (!(await ownedBy(principalId)))
					return Err({ code: 'principal_mismatch' });
				const { data: live, error } = await liveParent();
				if (error) return Err(error);
				const { data: installations, error: listError } =
					await github.installations(live.accessToken);
				if (listError) return Err({ code: 'upstream_unavailable' });
				const choices: RepositoryChoice[] = [];
				for (const installation of installations) {
					const { data: repositories, error: reposError } =
						await github.installationRepositories(
							live.accessToken,
							installation.id,
						);
					// A suspended or removed installation contributes nothing.
					if (reposError === 'denied') continue;
					if (reposError) return Err({ code: 'upstream_unavailable' });
					for (const repository of repositories)
						if (
							repository.private &&
							repository.ownerId === installation.account.id
						)
							choices.push({
								id: repository.id,
								installationId: installation.id,
								ownerId: installation.account.id,
								fullName: repository.fullName,
								cloneUrl: repository.cloneUrl,
								defaultBranch: repository.defaultBranch,
								push: repository.push,
							});
				}
				return Ok(choices);
			});
		},

		/**
		 * Pair a folder with a repository chosen by id and installation id. The
		 * installation must be one the granted user can reach, and a token
		 * scoped to the repository id must read it by id as owned by the
		 * installation account, private, with push access.
		 * An existing pairing is returned unchanged, revision included, for the
		 * same choice; anything else needs `replace`, which mints a new
		 * revision.
		 */
		pair(
			principalId: string,
			input: PairInput,
		): Promise<Result<Pairing, ConnectorError>> {
			return exclusive(async () => {
				if (!(await ownedBy(principalId)))
					return Err({ code: 'principal_mismatch' });
				const { data: live, error } = await liveParent();
				if (error) return Err(error);
				const existing = await loadPairing(input.folderId);
				if (existing && !input.replace) {
					const same =
						existing.repository.id === input.repositoryId &&
						existing.repository.installationId === input.installationId &&
						existing.githubUserId === live.grant.user.id &&
						(input.branch === undefined || input.branch === existing.branch);
					return same ? Ok(existing) : Err({ code: 'pairing_conflict' });
				}
				const { data: installation, error: installationError } =
					await reachableInstallation(
						live.accessToken,
						(candidate) => candidate.id === input.installationId,
					);
				if (installationError) return Err(installationError);
				const { data: access, error: accessError } = await scopedAccess(
					live.accessToken,
					{ id: input.repositoryId, ownerId: installation.account.id },
				);
				if (accessError) return Err(accessError);
				const pairing: Pairing = {
					folderId: input.folderId,
					revision: randomId(),
					githubUserId: live.grant.user.id,
					repository: {
						id: access.view.id,
						installationId: installation.id,
						ownerId: installation.account.id,
						fullName: access.view.fullName,
						cloneUrl: access.view.cloneUrl,
					},
					branch: input.branch ?? access.view.defaultBranch,
					pairedAt: now(),
				};
				await storage.put(PAIRING_PREFIX + input.folderId, pairing);
				return Ok(pairing);
			});
		},

		/**
		 * Every pairing with whether the stored grant belongs to its GitHub
		 * user. No network: this is not a live consent check.
		 */
		pairings(
			principalId: string,
		): Promise<
			Result<{ pairing: Pairing; status: PairingStatus }[], ConnectorError>
		> {
			return exclusive(async () => {
				if (!(await ownedBy(principalId)))
					return Err({ code: 'principal_mismatch' });
				const grant = await loadGrant();
				const pairings = await storage.list<Pairing>(PAIRING_PREFIX);
				return Ok(
					[...pairings.values()].map((pairing) => ({
						pairing,
						status: !grant
							? 'github_authorization_required'
							: grant.user.id === pairing.githubUserId
								? 'ready'
								: 'github_account_mismatch',
					})),
				);
			});
		},

		unpair(
			principalId: string,
			folderId: string,
		): Promise<Result<undefined, ConnectorError>> {
			return exclusive(async () => {
				if (!(await ownedBy(principalId)))
					return Err({ code: 'principal_mismatch' });
				if (!(await loadPairing(folderId)))
					return Err({ code: 'pairing_not_found' });
				await storage.delete(PAIRING_PREFIX + folderId);
				return Ok(undefined);
			});
		},

		/**
		 * Admit one Git request for a pairing revision: refuse a revision that
		 * is no longer current before any GitHub call, confirm the grant with
		 * GitHub (refreshing when due or rejected), require the paired
		 * installation among the user's installations, then scope a token to
		 * the paired repository id and resolve its current clone URL with it.
		 */
		authorizeTransfer(
			principalId: string,
			folderId: string,
			revision: string,
		): Promise<Result<TransferGrant, ConnectorError>> {
			return exclusive(async () => {
				if (!(await ownedBy(principalId)))
					return Err({ code: 'principal_mismatch' });
				const pairing = await loadPairing(folderId);
				if (!pairing) return Err({ code: 'pairing_not_found' });
				if (pairing.revision !== revision)
					return Err({ code: 'pairing_superseded' });
				const { data: live, error } = await liveParent();
				if (error) return Err(error);
				if (pairing.githubUserId !== live.grant.user.id)
					return Err({ code: 'github_account_mismatch' });
				const { data: installation, error: installationError } =
					await reachableInstallation(
						live.accessToken,
						(candidate) => candidate.id === pairing.repository.installationId,
					);
				if (installationError) return Err(installationError);
				if (installation.account.id !== pairing.repository.ownerId)
					return Err(unavailableRepository());
				return transferGrant(live.accessToken, pairing.repository);
			});
		},

		/**
		 * Admit one Git request for a repository named by owner and name, with
		 * no pairing: confirm the grant with GitHub (refreshing when due or
		 * rejected), read the repository by name with the parent token to learn
		 * its id and owner id, require an installation on that owner among the
		 * user's installations, then scope a token to the repository id and
		 * resolve its current clone URL with it. The name is trusted only to
		 * find the id; the scoped token's read by id decides access.
		 */
		authorizeRepositoryTransfer(
			principalId: string,
			repository: RepositoryAddress,
		): Promise<Result<TransferGrant, ConnectorError>> {
			return exclusive(async () => {
				if (!(await ownedBy(principalId)))
					return Err({ code: 'principal_mismatch' });
				const { data: live, error } = await liveParent();
				if (error) return Err(error);
				const { data: view, error: readError } = await github.repositoryByName(
					live.accessToken,
					repository.owner,
					repository.name,
				);
				// `/user` confirmed the parent just now; a 401 means it was revoked since.
				if (readError === 'rejected') return revokeGrant();
				if (readError) return Err(providerError(readError));
				const { data: installation, error: installationError } =
					await reachableInstallation(
						live.accessToken,
						(candidate) => candidate.account.id === view.ownerId,
					);
				if (installationError) return Err(installationError);
				return transferGrant(live.accessToken, {
					id: view.id,
					ownerId: installation.account.id,
				});
			});
		},

		/** Delete expired transactions and grant. Scheduled cleanup calls this. */
		sweep(): Promise<void> {
			return exclusive(async () => {
				await reschedule();
			});
		},
	};
}
