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
 * - The provider refuses the request (400/404). That names the request, not
 *   necessarily every assertion inside it, so a rejected group is retried one
 *   assertion at a time and only the individually rejected one is resolved. A
 *   resolved assertion is retired and reported in this pass's `discarded` list,
 *   which is the whole record of it: nothing about the refusal is written to
 *   disk, because a dead-letter row would be state nobody reads back.
 * - Anything else (auth, throttling, network, 5xx) is systemic. Delivery stops
 *   where it is, every undelivered assertion stays exactly as it was, and the
 *   next pass tries again. No attempt counter, because the retry policy is "the
 *   next pass", not a function of how many passes came before.
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

export type ReconcileDeps = SyncDeps & { intent: IntentDb };

/**
 * One assertion Gmail refused on its own terms, reported for THIS pass and
 * nowhere else. It names what was dropped in the vocabulary the user acted in
 * (this message, this label, wanted or not) plus Gmail's own status and words,
 * so a surface can say what happened instead of a change quietly vanishing.
 *
 * It is not persisted. Writing it down would be the dead-letter table this
 * design refuses: nothing would ever read it back, and a durable "failed" row
 * is exactly the kind of state that starts needing its own lifecycle. The
 * assertion is retired because it can never succeed; the explanation rides out
 * with the pass that discovered it.
 */
export type DiscardedAssertion = {
	messageId: string;
	labelId: string;
	/** The presence that was wanted: `true` on the message, `false` off it. */
	want: boolean;
	/** Gmail's HTTP status, 400 or 404. */
	status: number;
	/** Gmail's own explanation, as returned. */
	reason: string;
};

export type DeliveryOutcome = {
	/** Assertions the drain phase held at its start. */
	pending: number;
	/** Assertions Gmail confirmed and the store retired. */
	delivered: number;
	/** Assertions retired without delivery because Gmail refused them
	 * individually. Ephemeral: this array is the only record of them. */
	discarded: DiscardedAssertion[];
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
	 * On success the returned message is folded into the mirror BEFORE the
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
				failure = { name: error.name, message: error.message };
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
				// discarded, so a pair re-asserted mid-flight (whose sequence no longer
				// matches) is not announced as dropped when it is in fact still owed.
				if (deps.intent.retire([assertion]) === 1) {
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
