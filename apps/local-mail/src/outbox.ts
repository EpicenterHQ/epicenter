/**
 * The outbox: what this machine still owes Gmail, and what happened the last
 * time it tried to deliver it (ADR-0327).
 *
 * **Two owners, one view.** The intent store owns owed work: a row exists
 * because a person acted, and it leaves only when Gmail agrees or the person
 * abandons it (ADR-0199). This module owns the other half, which is what the
 * attempt said: `last_pass` holds one row per account, and that row is
 * overwritten by every pass. The outbox is the projection of the two, and it is
 * durable all the way down: everything here answers the same after a reload as
 * before one. Whether a pass is running this second is a fact about the surface
 * running it, so the surface says that beside this rather than through it.
 *
 * Keeping them apart is what stops the same fact being stored twice. "Three
 * changes waiting" is counted from the intent store at read time and is never
 * written down, so a pass that crashes between delivering and recording cannot
 * leave a stale number on screen; the worst it leaves is a stale explanation
 * beside a count that is already right.
 *
 * **One row per account, not a log.** A pass outcome answers "can my triage
 * reach Gmail right now", and only the latest answer can. A log would need a
 * retention rule, a reader, and an interface, and nothing has asked for one;
 * this is the same objection that kept a dead-letter table out of delivery,
 * applied to the record that replaced it.
 *
 * **Which is why an individually refused assertion is written here after all.**
 * `discarded` used to ride out on the pass's return value and be announced in a
 * toast, which was honest while the window ran the pass and stops being honest
 * once the host does (ADR-0323). It is stored as part of the last pass rather
 * than as rows of its own, so it inherits that row's lifetime: the next pass
 * replaces it, and nothing accumulates.
 */

import type { AppSqliteDatabase } from '@epicenter/device';
import { sqliteHandle } from './handle.ts';
import {
	type IntentStore,
	type LabelAssertion,
	openIntentStore,
} from './intent-store.ts';
import type { Mailbox } from './mailbox.ts';
import type { SyncFailure } from './sync.ts';

/**
 * One assertion Gmail refused on its own terms.
 *
 * It names what was dropped in the vocabulary the person acted in (this
 * message, this label, wanted or not) plus Gmail's own status and words, so the
 * outbox can say what happened instead of a change quietly vanishing. The
 * assertion itself is retired, because it can never succeed.
 */
export type DiscardedAssertion = LabelAssertion & {
	/** Gmail's HTTP status, 400 or 404. */
	status: number;
	/** Gmail's own explanation, as returned. */
	reason: string;
};

/**
 * What a failure means for the work still waiting behind it. Three answers,
 * because there are three different things a person can do about one.
 *
 * Nothing here schedules anything: the next pass is a person opening the
 * application, acting, or pressing Retry. What the kind decides is what that
 * person is told about pressing it.
 *
 * - `signin`: Google stopped honouring the grant. Retrying cannot help, so the
 *   outbox offers Sign in instead.
 * - `retry`: the network, a throttle, a 5xx, a lock held by another writer.
 *   The same request later succeeds, so Retry is worth pressing.
 * - `refused`: Gmail understood the request and said no. Retrying reproduces
 *   the refusal, and the outbox says so rather than inviting it.
 */
export type OutboxFailureKind = 'signin' | 'retry' | 'refused';

export type OutboxFailure = {
	kind: OutboxFailureKind;
	/** The variant the library reported, kept so a reader can be specific. */
	name: string;
	message: string;
};

/**
 * Classify what stopped a pass.
 *
 * The default is `retry`, and that is deliberate: an unfamiliar failure that is
 * actually permanent costs a person some pointless attempts, while an
 * unfamiliar failure wrongly called permanent costs them their triage sitting
 * still with nothing trying to move it.
 */
function classifyFailure(failure: SyncFailure): OutboxFailure {
	const shared = { name: failure.name, message: failure.message };
	if (
		failure.name === 'ReauthRequired' ||
		failure.name === 'CredentialMissing'
	) {
		return { kind: 'signin', ...shared };
	}
	// Gmail answers 401 for an access token this client refreshes on its own, so
	// a 401 reaching here means the refresh itself did not help. 403 is a scope
	// or permission answer, and the retryable rate-limit 403s never arrive as
	// `Http`: `gmail-client.ts` backs off and reports `Throttled` instead.
	if (
		failure.name === 'Http' &&
		(failure.status === 401 || failure.status === 403)
	) {
		return { kind: 'signin', ...shared };
	}
	if (
		failure.name === 'Http' &&
		failure.status >= 400 &&
		failure.status < 500
	) {
		return { kind: 'refused', ...shared };
	}
	return { kind: 'retry', ...shared };
}

/** What one pass said, as it was written down. */
export type PassOutcome = {
	finishedAt: string;
	/** Assertions Gmail confirmed and the store retired in this pass. */
	delivered: number;
	/** Assertions still owed when the pass ended. */
	waiting: number;
	discarded: DiscardedAssertion[];
	failure: OutboxFailure | null;
};

/** What a pass has to say about itself, before the record decides the rest. */
export type PassReport = {
	finishedAt: string;
	delivered: number;
	waiting: number;
	discarded: readonly DiscardedAssertion[];
	failure: SyncFailure | null;
};

export type PassRecord = ReturnType<typeof openPassRecord>;

/**
 * One account's slice of `last_pass`.
 *
 * It lives in the durable file beside the work it is about, so a window opening
 * after a crash reads the same explanation the window that failed would have
 * shown (ADR-0327).
 */
export function openPassRecord(local: AppSqliteDatabase, sub: string) {
	const { all, run } = sqliteHandle(local);

	type Row = {
		finished_at: string;
		delivered: number;
		waiting: number;
		discarded: string;
		failure_kind: string | null;
		failure_name: string | null;
		failure_message: string | null;
	};

	function toOutcome(row: Row): PassOutcome {
		return {
			finishedAt: row.finished_at,
			delivered: row.delivered,
			waiting: row.waiting,
			// A row this application wrote, so a parse failure is a corrupt file
			// rather than a case to handle. An empty list is the honest fallback:
			// refusals are the least load-bearing thing in the row, and losing the
			// failure and the counts with them would be worse.
			discarded: parseDiscarded(row.discarded),
			failure:
				row.failure_kind === null
					? null
					: {
							kind: row.failure_kind as OutboxFailureKind,
							name: row.failure_name ?? row.failure_kind,
							message: row.failure_message ?? '',
						},
		};
	}

	return {
		/** What the last pass said, or `null` when none has ever finished. */
		async read(): Promise<PassOutcome | null> {
			const [row] = await all<Row>(
				`SELECT finished_at, delivered, waiting, discarded, failure_kind,
				        failure_name, failure_message
				 FROM last_pass WHERE sub = ?`,
				[sub],
			);
			return row === undefined ? null : toOutcome(row);
		},

		/**
		 * Write down what this pass did, replacing whatever the last one said.
		 *
		 * One row per account and no history, because the question it answers is
		 * "can my triage reach Gmail" and only the latest attempt answers it. A
		 * log would need a retention rule and a reader, and nothing has asked for
		 * one; this is the objection that kept a dead-letter table out of
		 * delivery, applied to the record that replaced it.
		 */
		async record(report: PassReport): Promise<PassOutcome> {
			const failure =
				report.failure === null ? null : classifyFailure(report.failure);
			await run(
				`INSERT INTO last_pass
				   (sub, finished_at, delivered, waiting, discarded, failure_kind,
				    failure_name, failure_message)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(sub) DO UPDATE SET
				   finished_at = excluded.finished_at,
				   delivered = excluded.delivered,
				   waiting = excluded.waiting,
				   discarded = excluded.discarded,
				   failure_kind = excluded.failure_kind,
				   failure_name = excluded.failure_name,
				   failure_message = excluded.failure_message`,
				[
					sub,
					report.finishedAt,
					report.delivered,
					report.waiting,
					JSON.stringify(report.discarded),
					failure?.kind ?? null,
					failure?.name ?? null,
					failure?.message ?? null,
				],
			);
			return {
				finishedAt: report.finishedAt,
				delivered: report.delivered,
				waiting: report.waiting,
				discarded: [...report.discarded],
				failure,
			};
		},
	};
}

function parseDiscarded(stored: string): DiscardedAssertion[] {
	try {
		const parsed: unknown = JSON.parse(stored);
		return Array.isArray(parsed) ? (parsed as DiscardedAssertion[]) : [];
	} catch {
		return [];
	}
}

/**
 * What the outbox says, in the four words a person can act on.
 *
 * `clear` is the normal state and the sentence a person actually wants: nothing
 * owed, nothing wrong. Every other value is work that has not landed, plus
 * whether anything is known to be stopping it.
 *
 * There is no `syncing` here and no `retrying`. Both were facts about a running
 * worker rather than about the work, and this is a durable read: the surface
 * that is running a pass knows it is, and says so beside this.
 */
export type OutboxStatus = 'clear' | 'waiting' | 'signin' | 'failed';

/**
 * One waiting act, named the way the person made it.
 *
 * The assertion itself, plus the two things a list of them needs: when it was
 * made, and what it is about. `seq` is not here, because it is the store's own
 * bookkeeping for retiring a row and nothing a person is shown depends on it.
 */
export type OutboxEntry = LabelAssertion & {
	assertedAt: string;
	/** The subject line from this device's copy, or `null` if it holds none. */
	subject: string | null;
};

export type Outbox = {
	status: OutboxStatus;
	/** Everything owed to Gmail, oldest act first. Capped; `waiting` is the total. */
	entries: OutboxEntry[];
	waiting: number;
	oldestAssertedAt: string | null;
	/** What the last pass said, which is why `status` is what it is. */
	lastPass: PassOutcome | null;
};

export type OutboxDeps = {
	intents: IntentStore;
	mailbox: Mailbox;
	passes: PassRecord;
};

/** Read the outbox: owed work, the last pass, and the status the two imply. */
export async function readOutbox(
	{ intents, mailbox, passes }: OutboxDeps,
	{ limit = 50 }: { limit?: number } = {},
): Promise<Outbox> {
	const [waiting, lastPass] = await Promise.all([
		intents.pending(),
		passes.read(),
	]);
	const shown = waiting.slice(0, limit);
	// The count comes from the durable file and the subjects come from the
	// disposable copy, so a copy that is empty, mid-rebuild, or unreadable costs
	// a person some subject lines and never their own undelivered work
	// (ADR-0306). Reporting nothing waiting because there is no cache would hide
	// that work at exactly the moment it is most easily lost.
	const subjects = await mailbox
		.subjectsOf(shown.map((one) => one.messageId))
		.catch(() => new Map<string, string | null>());
	return {
		status: outboxStatus(waiting.length, lastPass),
		entries: shown.map((one) => ({
			messageId: one.messageId,
			labelId: one.labelId,
			want: one.want,
			assertedAt: one.assertedAt,
			subject: subjects.get(one.messageId) ?? null,
		})),
		waiting: waiting.length,
		oldestAssertedAt: waiting[0]?.assertedAt ?? null,
		lastPass,
	};
}

/**
 * Which of these accounts cannot move without a person, from the durable file
 * alone.
 *
 * The switcher marks a stuck account so a person choosing one is not surprised
 * (ADR-0327), and that is the whole question it asks, so it does not open every
 * account's mail file to ask it. `readOutbox` would, for subject lines nothing
 * on the switcher shows.
 */
export async function readBlockedAccounts(
	local: AppSqliteDatabase,
	subs: readonly string[],
): Promise<Set<string>> {
	const blocked = new Set<string>();
	await Promise.all(
		subs.map(async (sub) => {
			const failure = (await openPassRecord(local, sub).read())?.failure;
			if (failure === undefined || failure === null) return;
			// A refusal only blocks a person when something is stuck behind it; an
			// expired sign-in blocks them either way, because every act from now on
			// would pile up silently.
			if (failure.kind === 'signin') blocked.add(sub);
			else if (
				failure.kind === 'refused' &&
				(await openIntentStore(local, sub).count()) > 0
			) {
				blocked.add(sub);
			}
		}),
	);
	return blocked;
}

/**
 * A failure outranks a count.
 *
 * A sign-in that expired is reported even with nothing waiting, because it is
 * the state where an account outlives its credential and every act made from
 * now on would silently pile up (ADR-0320). Any other failure with nothing left
 * to deliver is not reported at all: what failed was a pull, the next open
 * repeats it, and there is no person's work stuck behind it.
 *
 * `failed` covers both remaining kinds, and `lastPass.failure.kind` is what
 * separates "pressing Retry may work" from "pressing Retry will not". That is a
 * difference in what a person is told, not in what the work is.
 */
function outboxStatus(
	waiting: number,
	lastPass: PassOutcome | null,
): OutboxStatus {
	if (lastPass?.failure?.kind === 'signin') return 'signin';
	if (waiting === 0) return 'clear';
	return lastPass?.failure == null ? 'waiting' : 'failed';
}
