import type { Result } from 'wellcrafted/result';
import type { GmailClientError } from './gmail-client.ts';
import type { IntentDb, LabelIntent } from './intent.ts';
import type { GmailMessage } from './schema.ts';
import { type SyncDeps, type SyncOutcome, syncMailbox } from './sync.ts';

/**
 * The reconciler: one pass per account, and the only thing in Local Mail that
 * writes to Gmail. A pass is always the same two phases in the same order.
 *
 *     drain  ->  pull
 *
 * Drain delivers the durable assertions in `intent.db`, folding each accepted
 * response into the mirror and retiring the assertion it proved. Pull is the
 * existing sync pass, unchanged. The order is the point: delivering after a pull
 * would leave a window where the mirror says one thing, the intent store says
 * another, and Gmail has heard neither.
 *
 * Who may run a pass is the account lock (`lock.ts`), which the caller holds
 * around this call. That is the same lock the sync loop already took, widened
 * from "one puller" to "one writer": a delivery landing between two pages of a
 * pull was previously possible and is now structurally excluded.
 *
 * Failure handling has exactly two shapes, and no state is persisted for either:
 *
 * - The provider says this specific target is impossible or gone (400/404). The
 *   assertion can never succeed, so it is retired. Nothing is written down about
 *   why; a dead-letter row would be state nobody reads.
 * - Anything else (auth, throttling, network, 5xx) is systemic. Delivery stops
 *   where it is, every undelivered assertion stays exactly as it was, and the
 *   next pass tries again. No attempt counter, because the retry policy is "the
 *   next pass", not a function of how many passes came before.
 *
 * Assertions are handled independently: one message's rejection never stops
 * another's, and within a message the label change and the trash move are
 * separate deliveries.
 */

/** Gmail models trash as its own endpoints rather than a label delta, so this
 * one label id routes differently AT DELIVERY. Everywhere else (the act path,
 * the read overlay, the intent store) it is an ordinary label. */
const TRASH = 'TRASH';

export type ReconcileDeps = SyncDeps & { intent: IntentDb };

export type DeliveryOutcome = {
	/** Assertions the drain phase held at its start. */
	pending: number;
	/** Assertions Gmail confirmed and the store retired. */
	delivered: number;
	/** Assertions retired without delivery: the target is impossible or gone. */
	unachievable: number;
	/**
	 * Assertions still owed to Gmail when the pass ended: everything a systemic
	 * failure stopped short of, plus anything re-asserted mid-delivery, plus
	 * everything skipped in read-only mode.
	 */
	retained: number;
	/** The systemic failure that stopped delivery, if one did. */
	failure: { name: string; message: string } | null;
};

export type ReconcileOutcome = {
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

/** Group pending assertions by message, preserving assertion order so the
 * oldest act is delivered first. */
function groupByMessage(pending: LabelIntent[]): MessageDelivery[] {
	const byMessage = new Map<string, MessageDelivery>();
	for (const intent of pending) {
		let delivery = byMessage.get(intent.messageId);
		if (!delivery) {
			delivery = { messageId: intent.messageId, labels: [], trash: null };
			byMessage.set(intent.messageId, delivery);
		}
		if (intent.labelId === TRASH) delivery.trash = intent;
		else delivery.labels.push(intent);
	}
	return [...byMessage.values()];
}

/** A 400 or 404 names this message or label, not the connection: the assertion
 * cannot ever be satisfied, so it is resolved rather than retried forever. */
function isUnachievable(error: GmailClientError): boolean {
	return (
		error.name === 'Http' && (error.status === 400 || error.status === 404)
	);
}

/**
 * Deliver everything the intent store holds. Snapshots the pending set first,
 * so an assertion made while this pass is running is neither delivered from a
 * stale read nor retired by it: retirement matches on the sequence in the
 * snapshot, and a re-assertion has a newer one.
 */
async function drain(
	deps: ReconcileDeps,
	{ readOnly }: { readOnly: boolean },
): Promise<DeliveryOutcome> {
	const pending = deps.intent.pending();
	if (readOnly || pending.length === 0) {
		return {
			pending: pending.length,
			delivered: 0,
			unachievable: 0,
			retained: pending.length,
			failure: null,
		};
	}

	const log = deps.log ?? (() => {});
	let delivered = 0;
	let unachievable = 0;
	let failure: DeliveryOutcome['failure'] = null;

	/**
	 * Deliver one Gmail call's worth of assertions. Folds the returned message
	 * into the mirror BEFORE retiring, so the fact lands before the overlay that
	 * was standing in for it disappears; a crash between the two redelivers, and
	 * label writes are idempotent. Returns false when the failure was systemic
	 * and the pass must stop.
	 */
	async function deliver(
		call: Promise<Result<GmailMessage, GmailClientError>>,
		covered: LabelIntent[],
	): Promise<boolean> {
		const { data: message, error } = await call;
		if (error) {
			if (!isUnachievable(error)) {
				failure = { name: error.name, message: error.message };
				return false;
			}
			log(`delivery refused for ${covered[0]?.messageId}: ${error.message}`);
			unachievable += deps.intent.retire(covered);
			return true;
		}
		if (message.labelIds) {
			deps.db.patchMessageLabels(
				message.id,
				message.labelIds,
				new Date(deps.now()).toISOString(),
			);
		}
		delivered += deps.intent.retire(covered);
		return true;
	}

	for (const { messageId, labels, trash } of groupByMessage(pending)) {
		if (labels.length > 0) {
			const proceed = await deliver(
				deps.client.modifyMessage(messageId, {
					addLabelIds: labels.filter((i) => i.want).map((i) => i.labelId),
					removeLabelIds: labels.filter((i) => !i.want).map((i) => i.labelId),
				}),
				labels,
			);
			if (!proceed) break;
		}
		if (trash) {
			const proceed = await deliver(
				trash.want
					? deps.client.trashMessage(messageId)
					: deps.client.untrashMessage(messageId),
				[trash],
			);
			if (!proceed) break;
		}
	}

	return {
		pending: pending.length,
		delivered,
		unachievable,
		// Read back rather than subtracted: a pair re-asserted mid-pass is still
		// owed even though its predecessor was delivered, and the store is the
		// only thing that knows.
		retained: deps.intent.pending().length,
		failure,
	};
}

/**
 * One reconcile pass for one account: deliver what is owed, then refresh the
 * facts. The pull runs even when delivery failed, because a failure to write is
 * not a reason to stop reading, and it runs even in read-only mode, where the
 * drain is skipped entirely and every assertion is retained.
 */
export async function reconcileAccount(
	deps: ReconcileDeps,
	{ forceFull, readOnly }: { forceFull: boolean; readOnly: boolean },
): Promise<ReconcileOutcome> {
	const delivery = await drain(deps, { readOnly });
	const pull = await syncMailbox(deps, { forceFull });
	return { delivery, pull };
}

/** A sleep that resolves early when the signal aborts, so Ctrl-C is instant. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Run passes until the signal aborts, for a headless owner (`local-mail
 * reconcile --watch`). The first pass honors `forceFull`; every later pass is
 * incremental, since the cursor has advanced. The desktop host runs its own loop
 * instead, because it also has to answer a local act's wake, which a fixed
 * interval cannot.
 */
export async function runReconcileLoop(
	deps: ReconcileDeps,
	opts: {
		forceFull: boolean;
		readOnly: boolean;
		intervalMs: number;
		/** Aborting the signal stops the loop after the current pass or sleep. */
		signal: AbortSignal;
		/** Called after each pass with its outcome and 1-based pass number. */
		onPass: (outcome: ReconcileOutcome, pass: number) => void;
	},
): Promise<void> {
	let pass = 0;
	while (!opts.signal.aborted) {
		const outcome = await reconcileAccount(deps, {
			forceFull: opts.forceFull && pass === 0,
			readOnly: opts.readOnly,
		});
		pass += 1;
		opts.onPass(outcome, pass);
		if (opts.signal.aborted) break;
		await interruptibleSleep(opts.intervalMs, opts.signal);
	}
}
