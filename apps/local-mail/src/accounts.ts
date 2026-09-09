/**
 * Connecting, removing, and opening one account's work.
 *
 * This is where Local Mail's three stores meet: the durable file says who is
 * connected and what this machine owes Gmail, one borrowed file per account
 * holds the mail, and the keychain holds the credential. All three are
 * addressed by the same `sub`, which is the subject Google returns for the
 * account and which nothing here allocates (ADR-0319).
 *
 * The outbox is the fourth thing filed under the same `sub`: `label_intents` is
 * what a person owes Gmail and `last_pass` is what happened the last time this
 * device tried to pay it (`outbox.ts`). Both are in the durable file, and both
 * leave with the account row in the same transaction below.
 *
 * **Nothing is minted, so nothing can be minted twice.** An earlier design gave
 * each account a row id and keyed the stores by it, which meant removing the
 * account deleted the only name its rows had. Reconnecting the same person
 * produced a second id and left the first account's undelivered triage where no
 * interface could reach it. Deriving the key from the subject removes the
 * failure rather than guarding against it.
 *
 * Local Mail owns Gmail's meaning here and the host owns none of it. The host
 * knows how to hold an opaque value under a label, how to run a statement
 * against a file it scoped, and how to delete one of those files. That a label
 * is a Gmail refresh token, and that a mailbox is pulled by `history.list`, are
 * decided in this file.
 */

import type { Device, SecretError } from '@epicenter/device';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	DEFAULT_MAIL_CONFIG,
	type GmailClientIdentity,
	type MailConfig,
} from './config.ts';
import { createGmailClient } from './gmail-client.ts';
import { sqliteHandle } from './handle.ts';
import {
	type IntentStore,
	type LabelAssertion,
	openIntentStore,
} from './intent-store.ts';
import { openMailbox } from './mailbox.ts';
import {
	type AuthorizationRequest,
	beginAuthorization,
	completeAuthorization,
	type OAuthError,
} from './oauth.ts';
import {
	type DiscardedAssertion,
	openPassRecord,
	readOutbox,
	type PassOutcome,
	type PassRecord,
} from './outbox.ts';
import { type ReconcilePassOutcome, reconcileAccount } from './reconcile.ts';
import {
	accountFiling,
	type LocalMailStorage,
	requireAccountFiling,
} from './storage.ts';
import type { SyncDeps } from './sync.ts';
import { createTokenManager } from './token-manager.ts';

export const AccountError = defineErrors({
	/**
	 * Removal refused because Gmail has not been told about work recorded here.
	 *
	 * Not a failure to remove. Removal deletes nothing until the count is zero
	 * (ADR-0320), so this is the account standing exactly as it did, with the
	 * number a person needs in order to choose between delivering and
	 * discarding.
	 */
	OwesWork: ({ sub, pending }: { sub: string; pending: number }) => ({
		message: `Gmail has not been told about ${pending} change${pending === 1 ? '' : 's'} recorded for this account.`,
		sub,
		pending,
	}),
	/** Google returned a subject this application cannot make a file name from. */
	UnusableSubject: ({ sub }: { sub: string }) => ({
		message: `This account's Google subject cannot name its local storage.`,
		sub,
	}),
});
export type AccountError = InferErrors<typeof AccountError>;

export type ConnectedAccount = {
	/** Google's subject for this account, which is the key to all three stores. */
	sub: string;
	email: string;
	connectedAt: string;
};

/** One account's open storage and Gmail client, borrowed through withSession. */
export type MailSession = SyncDeps & {
	sub: string;
	intents: IntentStore;
	passes: PassRecord;
};

export type ReconcileOutcome = ReconcilePassOutcome & {
	/** The run's durable report, including rejections from its follow-up passes. */
	pass: PassOutcome;
};

export type MailApp = {
	storage: LocalMailStorage;
	config: MailConfig;
	identity: GmailClientIdentity;
	device: Device;
	now: () => number;
	/** One owner for each account's admitted work, session, and removal. */
	readonly activity: Map<string, AccountActivity>;
};

type AccountActivity = {
	pending: Set<Promise<unknown>>;
	session?: Promise<MailSession>;
	sync?: { request(): void; promise: Promise<ReconcileOutcome> };
	removal?: Promise<Result<void, SecretError | AccountError>>;
};

function accountActivity(app: MailApp, sub: string): AccountActivity {
	let activity = app.activity.get(sub);
	if (!activity) {
		activity = { pending: new Set() };
		app.activity.set(sub, activity);
	}
	return activity;
}

/** Removal closes admission before waiting for every operation it admitted. */
function withAccount<T>(
	app: MailApp,
	sub: string,
	run: () => Promise<T>,
): Promise<T> {
	const activity = accountActivity(app, sub);
	if (activity.removal)
		return Promise.reject(new Error('This Gmail account is being removed.'));
	const work = Promise.resolve().then(run);
	activity.pending.add(work);
	void work.then(
		() => activity.pending.delete(work),
		() => activity.pending.delete(work),
	);
	return work;
}

/**
 * Hold the account open until the callback settles. Finish all session work
 * inside the callback; do not retain its session or handles after returning.
 */
export function withSession<T>(
	app: MailApp,
	sub: string,
	run: (session: MailSession) => Promise<T>,
): Promise<T> {
	return withAccount(app, sub, async () => run(await openSession(app, sub)));
}

/** Record one label choice without opening the cache or consulting Gmail.
 * A fresh revision makes this choice supersede any delivery already in flight. */
export function assertAccountLabel(
	app: MailApp,
	sub: string,
	assertion: LabelAssertion,
): Promise<void> {
	return withAccount(app, sub, async () => {
		await requireConnectedAccount(app, sub);
		await openIntentStore(app.storage.local, sub).assert(
			[assertion],
			new Date(app.now()).toISOString(),
		);
	});
}

/** Inspect durable work even when opening the optional mail cache fails. */
export function readAccountOutbox(app: MailApp, sub: string) {
	return withAccount(app, sub, async () => {
		await requireConnectedAccount(app, sub);
		return readOutbox({
			intents: openIntentStore(app.storage.local, sub),
			passes: openPassRecord(app.storage.local, sub),
			subjectsOf: async (ids) =>
				openMailbox(await app.storage.mail(sub)).subjectsOf(ids),
		});
	});
}

/** Membership failures must never be mistaken for an unavailable cache. */
async function requireConnectedAccount(
	app: MailApp,
	sub: string,
): Promise<void> {
	const [row] = await sqliteHandle(app.storage.local).all<{ sub: string }>(
		`SELECT sub FROM accounts WHERE sub = ?`,
		[sub],
	);
	if (row === undefined) {
		throw new Error(`No account is connected on this device for ${sub}.`);
	}
}

export function createMailApp({
	device,
	storage,
	identity,
	config = DEFAULT_MAIL_CONFIG,
	now = () => Date.now(),
}: {
	device: Device;
	storage: LocalMailStorage;
	identity: GmailClientIdentity;
	config?: MailConfig;
	now?: () => number;
}): MailApp {
	return {
		device,
		storage,
		identity,
		config,
		now,
		activity: new Map(),
	};
}

type AccountRow = {
	sub: string;
	email: string;
	connected_at: string;
};

const toAccount = (row: AccountRow): ConnectedAccount => ({
	sub: row.sub,
	email: row.email,
	connectedAt: row.connected_at,
});

/** Every account connected on this device, oldest connection first. */
export async function listAccounts(app: MailApp): Promise<ConnectedAccount[]> {
	const rows = await sqliteHandle(app.storage.local).all<AccountRow>(
		`SELECT sub, email, connected_at FROM accounts
		 ORDER BY connected_at, sub`,
	);
	return rows.map(toAccount);
}

/** Step one of connecting: where to send the person, and what to hold. */
export function startConnect(
	app: MailApp,
	{ redirectUri }: { redirectUri: string },
): Promise<AuthorizationRequest> {
	return beginAuthorization({
		config: app.config,
		identity: app.identity,
		redirectUri,
	});
}

/**
 * Step two: redeem the code, record the account, and keep the credential.
 *
 * A subject this person already connected lands on the row it already has, by
 * arithmetic rather than by lookup, and the address is refreshed because it is
 * display metadata that may have changed since the last connection.
 *
 * **A credential that did not store is a failed connection.** The secret owner
 * can refuse: a locked keychain, a host with no Rust parent. Returning `Ok`
 * anyway would leave a row in the registry and an account in the switcher whose
 * first synchronization asks for re-consent with nothing to explain why, so the
 * error arm carries `SecretError` as well.
 *
 * The row stays on a refusal, because it is either the row this account already
 * had or a new one owing nothing. Deleting it here would throw away a person's
 * earlier undelivered triage in order to report a keychain failure.
 */
export async function finishConnect(
	app: MailApp,
	{ request, callbackUrl }: { request: AuthorizationRequest; callbackUrl: URL },
): Promise<Result<ConnectedAccount, OAuthError | SecretError | AccountError>> {
	const authorized = await completeAuthorization({
		config: app.config,
		identity: app.identity,
		request,
		callbackUrl,
		now: app.now,
	});
	if (authorized.error !== null) return authorized;

	const sub = authorized.data.providerAccountId;
	const { email, refreshToken } = authorized.data;
	// The subject names this account's mail file and its credential, so a
	// subject the storage owner would refuse has to fail here, while the person
	// can still read why. Google issues numeric subjects, so nothing has
	// reached this.
	const filing = accountFiling(sub);
	if (filing === undefined) {
		return Err(AccountError.UnusableSubject({ sub }).error);
	}
	return withAccount(app, sub, async () => {
		const local = sqliteHandle(app.storage.local);
		const connectedAt = new Date(app.now()).toISOString();
		await local.run(
			`INSERT INTO accounts (sub, email, connected_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(sub) DO UPDATE SET email = excluded.email`,
			[sub, email, connectedAt],
		);

		const kept = await app.device.secrets.put(filing.secret, refreshToken);
		if (kept.error !== null) return kept;

		const [row] = await local.all<AccountRow>(
			`SELECT sub, email, connected_at FROM accounts WHERE sub = ?`,
			[sub],
		);
		if (!row) throw new Error('The connected Gmail account was not recorded.');
		return Ok(toAccount(row));
	});
}

/**
 * Abandon this account's undelivered triage, which is a thing to mean on purpose.
 *
 * Straight at the durable file rather than through `openSession`, because a
 * session opens the account's mail file and builds a Gmail client, and this
 * needs neither. Going through one would create the borrowed file that the
 * removal following this is about to unlink.
 */
export async function discardPending(
	app: MailApp,
	sub: string,
): Promise<number> {
	return withAccount(app, sub, () =>
		openIntentStore(app.storage.local, sub).discardAll(),
	);
}

/**
 * Remove one account from this device: the credential, the mail, and the rows.
 *
 * **It deletes nothing while the account owes Gmail anything** (ADR-0320).
 * Delivering needs the credential that removal destroys, so a caller that means
 * to deliver first delivers first, and a caller that means to abandon the work
 * calls `discardPending`. Either way this verb sees a count of zero before it
 * touches anything, so a delivery that could not finish leaves the account
 * exactly as it was.
 *
 * **Then it commits in reachability order.** The credential goes first, because
 * there is no `secrets.list` (ADR-0310) and the account row is the only thing
 * that knows the credential exists; deleting the row after a failed delete
 * would strand it in the keychain with nothing left that can name it. The
 * borrowed file goes next, because Gmail still has it. The rows go last, in one
 * transaction, because they are the name everything else was filed under.
 *
 * An interruption therefore always leaves more than it should rather than less,
 * and running this again finishes the job.
 */
export function removeAccount(
	app: MailApp,
	sub: string,
): Promise<Result<void, SecretError | AccountError>> {
	const activity = accountActivity(app, sub);
	if (activity.removal) return activity.removal;
	const removing = Promise.resolve().then(async () => {
		await Promise.allSettled(activity.pending);
		return removeIdleAccount(app, sub, activity);
	});
	activity.removal = removing;
	void removing.then(
		() => {
			activity.removal = undefined;
		},
		() => {
			activity.removal = undefined;
		},
	);
	return removing;
}

async function removeIdleAccount(
	app: MailApp,
	sub: string,
	activity: AccountActivity,
): Promise<Result<void, SecretError | AccountError>> {
	const owed = await openIntentStore(app.storage.local, sub).count();
	if (owed > 0) {
		return Err(AccountError.OwesWork({ sub, pending: owed }).error);
	}

	const forgotten = await app.device.secrets.delete(
		requireAccountFiling(sub).secret,
	);
	if (forgotten.error !== null) return forgotten;

	// The session goes before the file it holds, so nothing composed over
	// this account survives the account. A session still opening is awaited
	// rather than only dropped: it holds a `sqlite.open` that would land
	// after the unlink and recreate the file (ADR-0321).
	const opening = activity.session;
	activity.session = undefined;
	await opening?.catch(() => undefined);
	await app.storage.forgetMail(sub);
	await sqliteHandle(app.storage.local).batch([
		{ sql: `DELETE FROM label_intents WHERE sub = ?`, parameters: [sub] },
		{ sql: `DELETE FROM intent_counters WHERE sub = ?`, parameters: [sub] },
		{ sql: `DELETE FROM last_pass WHERE sub = ?`, parameters: [sub] },
		{ sql: `DELETE FROM accounts WHERE sub = ?`, parameters: [sub] },
	]);
	return Ok(undefined);
}

/**
 * Everything one account's work needs, composed once and held.
 *
 * **A session for an account this device has not connected is refused.** The
 * mail file's name is derived from the subject, so opening a session for a
 * removed account would create an empty file for a mailbox nobody can read,
 * and every read through it would answer as though the account were merely
 * empty. Asking the registry first turns a stale caller into an error it can
 * report instead of a mailbox that quietly says nothing is there.
 */
function openSession(app: MailApp, sub: string): Promise<MailSession> {
	const activity = accountActivity(app, sub);
	const existing = activity.session;
	if (existing !== undefined) return existing;
	const opening = (async () => {
		await requireConnectedAccount(app, sub);
		const tokens = createTokenManager({
			config: app.config,
			identity: app.identity,
			secrets: app.device.secrets,
			label: requireAccountFiling(sub).secret,
			now: app.now,
		});
		return {
			sub,
			mailbox: openMailbox(await app.storage.mail(sub)),
			intents: openIntentStore(app.storage.local, sub),
			passes: openPassRecord(app.storage.local, sub),
			client: createGmailClient({ config: app.config, tokens }),
			now: app.now,
		};
	})();
	// Evict this open, not whatever is under the key when it fails: a slow
	// failure must not take a healthy session opened after it.
	opening.catch(() => {
		if (activity.session === opening) activity.session = undefined;
	});
	activity.session = opening;
	return opening;
}

/**
 * Deliver and pull, coalescing requests received during a pass into a follow-up.
 * A failure alone never schedules a retry. Only another caller requests a pass.
 * All callers settle after the requested passes, so removal can await delivery.
 */
export function reconcileNow(
	app: MailApp,
	sub: string,
): Promise<ReconcileOutcome> {
	const activity = accountActivity(app, sub);
	if (activity.removal)
		return Promise.reject(new Error('This Gmail account is being removed.'));
	if (activity.sync) {
		activity.sync.request();
		return activity.sync.promise;
	}
	let requested = false;
	const promise = withAccount(app, sub, async () => {
		try {
			const session = await openSession(app, sub);
			const discarded: DiscardedAssertion[] = [];
			let outcome: ReconcileOutcome;
			do {
				requested = false;
				const { delivery, pull } = await reconcileAccount(session);
				discarded.push(...delivery.discarded);
				const pass = await session.passes.record({
					finishedAt: new Date(app.now()).toISOString(),
					discarded,
					failure: delivery.failure ?? pull.failure,
				});
				outcome = { delivery, pull, pass };
			} while (requested);
			return outcome;
		} finally {
			// Clear before returning: a caller arriving during promise settlement
			// must start a new run rather than request an already finished loop.
			activity.sync = undefined;
		}
	});
	activity.sync = {
		request() {
			requested = true;
		},
		promise,
	};
	return promise;
}
