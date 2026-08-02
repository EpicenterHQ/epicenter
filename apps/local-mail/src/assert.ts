import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { IntentDb, LabelAssertion } from './intent.ts';
import { GMAIL_SYSTEM_LABEL_IDS } from './schema.ts';

/**
 * The act path: what happens the moment a human (or an agent) triages a
 * message. It is entirely local. Archive, mark read, star, apply a label, and
 * move to trash all desugar to the same thing here, a per-message label
 * assertion recorded in the durable intent store, and nothing on this path
 * touches Gmail. `reconcile.ts` is the only Gmail writer, and it runs later.
 *
 * Two rules give the surfaces their behaviour for free:
 *
 * - Labels resolve to Gmail label ids HERE, because a name is a display string
 *   the user can rename while an assertion waits; what is stored is the
 *   immutable id. Gmail's SYSTEM ids are protocol constants and resolve without
 *   the mirror, so archive, read, star, and trash keep working before the first
 *   pull and across a mirror rebuild. Only custom labels are mailbox data, and
 *   only they are looked up.
 * - EVERY valid opinion is recorded, at a fresh sequence, even when the mirror
 *   already agrees with it. Nothing here reads Gmail's facts to decide whether
 *   an act is worth keeping, and nothing here deletes an assertion.
 *
 * That second rule is the one worth defending, because skipping or cancelling
 * on mirror agreement looks free and is not. The mirror lags: it does not carry
 * a change the reconciler has sent but not yet pulled back, and it can be stale
 * against Gmail for a whole poll interval. An act judged redundant against those
 * facts is a user choice dropped silently. So undo before delivery REPLACES the
 * pending assertion (a fresh sequence, which also invalidates the retirement of
 * the delivery it raced) rather than erasing it, and the worst case is one
 * redundant label modify, which Gmail accepts as a no-op. A wasted request is a
 * bounded, visible cost; a lost intent is neither.
 *
 * Ids are snapshotted by the caller, not resolved later: the surfaces pass the
 * concrete message ids the user acted on, so a message that arrives into the
 * same thread or view afterwards is untouched.
 */

/** The cap on how many messages one act covers. Deliberately not Gmail's
 * per-request limit: nothing here is a request. It exists so a mistyped bulk act
 * cannot queue an unbounded drain, and it is refused with the count rather than
 * silently truncated. */
const MAX_MESSAGES_PER_ACT = 500;

/**
 * Gmail's own per-request ceiling: `messages.modify` accepts at most 100 label
 * ids in `addLabelIds` and 100 in `removeLabelIds` (Gmail API reference,
 * verified 2026-08-01). Enforced here, in the core rather than only in the MCP
 * tool schema, so no surface can record an act whose shape Gmail would refuse.
 *
 * Scope, precisely: this bounds ONE act, not the total pending for a message.
 * Two acts of 60 labels each leave 120 pending for the same message, and the
 * drain groups them into one request Gmail will refuse. That case is already
 * handled where it happens rather than pre-empted here: a refused group is
 * retried one assertion at a time, so every one of them still lands (see
 * `reconcile.ts`). The cost is one wasted request in a case that needs an
 * account with a hundred custom labels to reach at all.
 */
const MAX_LABELS_PER_DIRECTION = 100;

export const AssertLabelsError = defineErrors({
	ReadOnly: () => ({
		message:
			'Refusing to write: read-only mode is set (LOCAL_MAIL_READ_ONLY), so triage is disabled. query, status, and reconcile stay available.',
	}),
	NoMessageIds: () => ({
		message: 'At least one Gmail message id is required.',
	}),
	TooManyMessageIds: ({ count }: { count: number }) => ({
		message: `One act covers at most ${MAX_MESSAGES_PER_ACT} messages, got ${count}.`,
		count,
	}),
	EmptyLabelMutation: () => ({
		message: 'At least one label must be added or removed.',
	}),
	TooManyLabels: ({
		direction,
		count,
	}: {
		direction: 'added' | 'removed';
		count: number;
	}) => ({
		message: `Gmail accepts at most ${MAX_LABELS_PER_DIRECTION} labels ${direction} in one change, got ${count}.`,
		direction,
		count,
	}),
	UnknownLabel: ({ label }: { label: string }) => ({
		message: `Unknown Gmail label "${label}". Gmail's system labels (INBOX, UNREAD, STARRED, TRASH, CATEGORY_*) always resolve; a custom label has to exist in the local copy first, so create it in Gmail and reconcile.`,
		label,
	}),
	/** One act cannot both want and not want the same label. Resolving it by
	 * list order would make the outcome depend on how the caller happened to
	 * spell it, so it is refused instead. */
	ContradictoryLabel: ({ label }: { label: string }) => ({
		message: `Label "${label}" is asked to be both added and removed by the same act.`,
		label,
	}),
});
export type AssertLabelsError = InferErrors<typeof AssertLabelsError>;

export type AssertLabelsInput = {
	/** Concrete message ids, snapshotted by the surface at act time. */
	ids: string[];
	/** Gmail label ids or exact names to put on those messages. */
	addLabels: string[];
	/** Gmail label ids or exact names to take off those messages. */
	removeLabels: string[];
};

export type AssertLabelsOutcome = {
	/** `(message, label)` pairs this act recorded, each at a fresh sequence.
	 * Always `ids.length * (addLabels.length + removeLabels.length)`: an act
	 * that agrees with the mirror is still recorded, so this is a count of what
	 * was asked for, not of what looked worth keeping. */
	asserted: number;
};

/**
 * The mirror, narrowed to the one question the act path asks of it. Naming the
 * capability rather than the whole mirror is the point: an act resolves custom
 * label names and writes to the intent store, and this type is what says it can
 * do nothing else to Gmail's disposable copy. Every caller holds a full
 * `ReconcileDeps` and hands it straight over; the narrowing lives here, in the
 * type, so no call site has to restate it.
 */
export type LabelDirectory = {
	findLabelByIdOrExactName(
		label: string,
	): { id: string; name: string | null } | null;
};

export type AssertDeps = {
	db: LabelDirectory;
	intent: IntentDb;
	/** The act's clock. Injected like every other clock here, and stamped onto
	 * each assertion so a status surface can report how long the oldest
	 * undelivered change has waited. */
	now: () => number;
};

/**
 * Resolve label ids and exact names. No Gmail call: the act path is offline by
 * construction.
 *
 * A system label id needs no lookup at all. Gmail assigns those, they are the
 * same in every account, and asking the mirror for them made triage depend on a
 * disposable file: with an empty label table (before the first pull, or right
 * after a rebuild) archiving was refused as an unknown label even though
 * `INBOX` could not be more concrete. Custom labels are genuinely mailbox data,
 * so they still resolve against the mirror and an unknown one is still refused.
 */
function resolveLabelIds(
	directory: LabelDirectory,
	labels: string[],
): Result<string[], AssertLabelsError> {
	const resolved: string[] = [];
	for (const label of labels) {
		if (GMAIL_SYSTEM_LABEL_IDS.has(label)) {
			resolved.push(label);
			continue;
		}
		const row = directory.findLabelByIdOrExactName(label);
		if (!row) return AssertLabelsError.UnknownLabel({ label });
		resolved.push(row.id);
	}
	return Ok(resolved);
}

/**
 * Record one triage act. Returns how much it recorded; there is no per-id
 * outcome because no id can fail: the act is a local write, and delivery is
 * somebody else's pass.
 */
export function assertMessageLabels({
	deps,
	input,
	readOnly,
}: {
	deps: AssertDeps;
	input: AssertLabelsInput;
	/**
	 * Required so every adapter decides explicitly whether triage is allowed.
	 * The core owns this invariant, not the CLI, MCP, or HTTP surface.
	 */
	readOnly: boolean;
}): Result<AssertLabelsOutcome, AssertLabelsError> {
	if (readOnly) return AssertLabelsError.ReadOnly();
	if (input.ids.length === 0) return AssertLabelsError.NoMessageIds();
	if (input.ids.length > MAX_MESSAGES_PER_ACT) {
		return AssertLabelsError.TooManyMessageIds({ count: input.ids.length });
	}
	if (input.addLabels.length === 0 && input.removeLabels.length === 0) {
		return AssertLabelsError.EmptyLabelMutation();
	}
	if (input.addLabels.length > MAX_LABELS_PER_DIRECTION) {
		return AssertLabelsError.TooManyLabels({
			direction: 'added',
			count: input.addLabels.length,
		});
	}
	if (input.removeLabels.length > MAX_LABELS_PER_DIRECTION) {
		return AssertLabelsError.TooManyLabels({
			direction: 'removed',
			count: input.removeLabels.length,
		});
	}

	const { data: resolved, error } = resolveLabelIds(deps.db, [
		...input.addLabels,
		...input.removeLabels,
	]);
	if (error) return { data: null, error };
	const wanted = resolved.slice(0, input.addLabels.length);
	const unwanted = resolved.slice(input.addLabels.length);

	// Checked after resolution, so naming the same label by id in one list and
	// by display name in the other is caught too.
	const contradiction = wanted.find((id) => unwanted.includes(id));
	if (contradiction) {
		return AssertLabelsError.ContradictoryLabel({ label: contradiction });
	}

	const opinions: [labelId: string, want: boolean][] = [
		...wanted.map((id): [string, boolean] => [id, true]),
		...unwanted.map((id): [string, boolean] => [id, false]),
	];

	const assertions: LabelAssertion[] = [];
	for (const messageId of input.ids) {
		for (const [labelId, want] of opinions) {
			assertions.push({ messageId, labelId, want });
		}
	}

	return Ok({
		asserted: deps.intent.assert(
			assertions,
			new Date(deps.now()).toISOString(),
		),
	});
}
