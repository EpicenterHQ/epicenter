import type { Result } from 'wellcrafted/result';
import type { MailSession } from './accounts.ts';
import type { GmailClientError } from './gmail-client.ts';
import type { LabelIntent } from './intent-store.ts';
import type { DiscardedAssertion } from './outbox.ts';
import type { GmailMessage } from './schema.ts';
import { type SyncOutcome, syncMailbox } from './sync.ts';

/**
 * The reconciler: one pass per account, and the only thing in Local Mail that
 * writes to Gmail (ADR-0199). A pass is always the same two phases in the same
 * order.
 *
 *     drain  ->  pull
 *
 * Drain delivers the durable assertions in the intent store, folding each accepted
 * response into the cache and retiring the assertion it proved. Pull is the
 * existing sync pass, unchanged. The order is the point: delivering after a pull
 * would leave a window where the cache says one thing, the intent store says
 * another, and Gmail has heard neither.
 *
 * **A pass is somebody's own two hands, and `reconcileNow` in `accounts.ts` is
 * the only way to ask for one.** Local Mail does not reconcile in the
 * background: it reconciles when the application opens, when a person records
 * triage, and when a person presses Retry. So there is no scheduler, no worker,
 * and nothing that can start a pass while another is running except a second
 * gesture, which `reconcileNow` coalesces into a follow-up pass. This module is the pass itself and holds none of that.
 *
 * This used to require a `ReconcileClaim` that only a claim module could mint,
 * back when the writers were a CLI watch loop, an MCP server, and a desktop
 * host. One entry point in one process is a stronger guarantee than a token
 * every call site had to remember to take, so the token is gone.
 *
 * Failure handling has exactly two shapes:
 *
 * - The provider refuses the request (400/404). That names the request, not
 *   necessarily every assertion inside it, so a rejected group is retried one
 *   assertion at a time and only the individually rejected one is resolved. A
 *   resolved assertion is retired and reported in this pass's `discarded` list.
 * - Anything else (auth, throttling, network, 5xx) is systemic. Delivery stops
 *   where it is, every undelivered assertion stays exactly as it was, and the
 *   next pass tries again.
 *
 * **Both shapes end up written down.** The account run records what its passes did in
 * `last_pass` before it returns, so a failure is still on screen after the
 * window that saw it was closed and reopened (ADR-0327). The return value is
 * the same facts for the caller that is still there; the record is what a
 * person comes back to. What a failure means for a person, which is whether
 * pressing Retry could help, is decided in `outbox.ts`.
 *
 * Assertions are handled independently: one message's rejection never stops
 * another's, and within a message the trash transition and the label change are
 * separate deliveries, ordered so each still means what the user meant (see the
 * drain loop).
 *
 * A group Gmail refuses for being too large is not special-cased: the same
 * split retry that handles one impossible label delivers each assertion on its
 * own, so an accumulation past Gmail's 100-label-per-direction request cap
 * still lands.
 */

export type DeliveryOutcome = {
	/** Assertions the drain phase held at its start. */
	pending: number;
	/** Assertions Gmail confirmed and the store retired. */
	delivered: number;
	/** Assertions retired without delivery because Gmail refused them
	 * individually. Carried on the pass record, so the outbox can say so. */
	discarded: DiscardedAssertion[];
	/**
	 * Assertions still owed to Gmail when the pass ended: everything a systemic
	 * failure stopped short of, plus anything re-asserted mid-delivery.
	 */
	retained: number;
	/**
	 * The systemic failure that stopped delivery, if one did.
	 *
	 * The variant is kept, not flattened to a name and a message, because a
	 * caller asking "is this account's sign-in expired" has to be able to test
	 * it against a closed union. Its sibling `SyncOutcome['failure']` is typed
	 * the same way, so `delivery.failure ?? pull.failure` stays checkable.
	 */
	failure: GmailClientError | null;
};

export type ReconcilePassOutcome = {
	delivery: DeliveryOutcome;
	pull: SyncOutcome;
};

/** Everything one message's pending assertions ask for, in one place: the label
 * set to modify, and whether trash was asserted in either direction. */
type MessageDelivery = {
	messageId: string;
	labels: LabelIntent[];
	trash: LabelIntent | null;
};

/**
 * Group pending assertions by message, preserving assertion order so the oldest
 * act is delivered first. `TRASH` is pulled out of the label set here because
 * Gmail routes it through its own endpoints rather than a label delta; it is an
 * ordinary label at every other layer, and only delivery has to know.
 */
function groupByMessage(pending: LabelIntent[]): MessageDelivery[] {
	const byMessage = new Map<string, MessageDelivery>();
	for (const intent of pending) {
		let delivery = byMessage.get(intent.messageId);
		if (!delivery) {
			delivery = { messageId: intent.messageId, labels: [], trash: null };
			byMessage.set(intent.messageId, delivery);
		}
		if (intent.labelId === 'TRASH') delivery.trash = intent;
		else delivery.labels.push(intent);
	}
	return [...byMessage.values()];
}

/** A 400 or 404 names this message or label, not the connection: the assertion
 * cannot ever be satisfied, so it is resolved rather than retried forever.
 * Narrowing to the `Http` variant is what gives the caller a status to report. */
function unachievableStatus(
	error: GmailClientError,
): { status: number; reason: string } | null {
	if (error.name !== 'Http') return null;
	if (error.status !== 400 && error.status !== 404) return null;
	return { status: error.status, reason: error.message };
}

/**
 * Deliver everything the intent store holds. Snapshots the pending set first,
 * so an assertion made while this pass is running is neither delivered from a
 * stale read nor retired by it: retirement matches on the revision in the
 * snapshot, and a re-assertion has a newer one.
 */
async function drain(deps: MailSession): Promise<DeliveryOutcome> {
	const pending = await deps.intents.pending();
	if (pending.length === 0) {
		return {
			pending: pending.length,
			delivered: 0,
			discarded: [],
			retained: pending.length,
			failure: null,
		};
	}

	const log = deps.log ?? (() => {});
	let delivered = 0;
	const discarded: DiscardedAssertion[] = [];
	let failure: DeliveryOutcome['failure'] = null;

	/**
	 * Deliver a set of assertions through one Gmail call, and answer whether the
	 * pass may continue.
	 *
	 * On success the returned message is folded into the cache BEFORE the
	 * assertions are retired, so the fact lands before the overlay standing in for
	 * it disappears; a crash between the two redelivers, and label writes are
	 * idempotent.
	 *
	 * On a per-target refusal the rejection is about the REQUEST, not necessarily
	 * about every assertion in it: one label id Gmail will not accept would
	 * otherwise take the whole group down with it. So a rejected group of more
	 * than one is retried an assertion at a time, and only the assertion that is
	 * individually rejected is resolved. `send` takes the subset for exactly this
	 * reason.
	 */
	async function deliver(
		send: (
			subset: LabelIntent[],
		) => Promise<Result<GmailMessage, GmailClientError>>,
		covered: LabelIntent[],
	): Promise<boolean> {
		const { data: message, error } = await send(covered);
		if (error) {
			const refusal = unachievableStatus(error);
			if (!refusal) {
				failure = error;
				return false;
			}
			if (covered.length > 1) {
				log(
					`delivery refused for ${covered[0]?.messageId}; retrying its ${covered.length} assertions one at a time: ${error.message}`,
				);
				for (const assertion of covered) {
					if (!(await deliver(send, [assertion]))) return false;
				}
				return true;
			}
			log(`delivery refused for ${covered[0]?.messageId}: ${error.message}`);
			for (const assertion of covered) {
				// Retire first: only a row that actually left the store is reported as
				// discarded, so a pair re-asserted mid-flight (whose revision no longer
				// matches) is not announced as dropped when it is in fact still owed.
				if ((await deps.intents.retire([assertion])) === 1) {
					discarded.push({
						messageId: assertion.messageId,
						labelId: assertion.labelId,
						want: assertion.want,
						...refusal,
					});
				}
			}
			return true;
		}
		// An absent `labelIds` is an EMPTY label set, not "no answer". Gmail's JSON
		// encoding omits empty repeated fields, so a message whose last label the
		// caller just removed comes back without the key at all; `schema.ts` marks
		// it optional because a thin `history.list` message really does lack it, not
		// because a mutation response may decline to say.
		//
		// Skipping the fold here would leave the cache asserting labels Gmail no
		// longer has while the assertion that proved otherwise is retired one line
		// below. The pull normally papers over that, but the pull is exactly what
		// fails when anything is wrong, so the stale fact would resurface in the
		// inbox and the user would watch their archive come back.
		await deps.mailbox.patchMessageLabels(
			message.id,
			message.labelIds ?? [],
			new Date(deps.now()).toISOString(),
		);
		delivered += await deps.intents.retire(covered);
		return true;
	}

	for (const { messageId, labels, trash } of groupByMessage(pending)) {
		// Order within a message is not the order the user clicked in; it is the
		// order that makes every one of their assertions mean what they meant.
		//
		// Trash is a state a message is IN, not a label alongside the others.
		// While a message sits in Trash it carries none of the labels a modify
		// would touch, and untrashing restores whatever it had before. So an
		// untrash must happen FIRST, or a modify sent beforehand is a no-op that
		// the untrash then overwrites: "restore this and archive it" would deliver
		// both assertions, retire both, and leave the message back in the inbox.
		// Trashing must happen LAST for the mirror image of the same reason, since
		// label work aimed at a message already in Trash is thrown away.
		//
		// Each step is its own delivery with its own retirement, so a systemic
		// failure between them leaves the rest owed rather than lost.
		const deliverTrash = (pair: LabelIntent) =>
			deliver(
				() =>
					pair.want
						? deps.client.trashMessage(messageId)
						: deps.client.untrashMessage(messageId),
				// Always one assertion, so this never splits; Gmail's trash endpoints
				// take no label set to be partly wrong about.
				[pair],
			);

		if (trash && !trash.want && !(await deliverTrash(trash))) break;

		if (labels.length > 0) {
			const proceed = await deliver(
				(subset) =>
					deps.client.modifyMessage(messageId, {
						addLabelIds: subset.filter((i) => i.want).map((i) => i.labelId),
						removeLabelIds: subset.filter((i) => !i.want).map((i) => i.labelId),
					}),
				labels,
			);
			if (!proceed) break;
		}

		if (trash?.want && !(await deliverTrash(trash))) break;
	}

	return {
		pending: pending.length,
		delivered,
		discarded,
		// Read back rather than subtracted: a pair re-asserted mid-pass is still
		// owed even though its predecessor was delivered, and the store is the
		// only thing that knows.
		retained: (await deps.intents.pending()).length,
		failure,
	};
}

/**
 * Deliver pending assertions, then refresh cached facts even if delivery failed.
 * The account run owns admission, follow-up passes, and durable reporting.
 * Call reconcileNow so another writer cannot race this pass for the account.
 */
export async function reconcileAccount(
	deps: MailSession,
): Promise<ReconcilePassOutcome> {
	const delivery = await drain(deps);
	const pull = await syncMailbox(deps);
	return { delivery, pull };
}
