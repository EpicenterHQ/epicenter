/**
 * One account's slice of the durable intent store: the only irreplaceable bytes
 * Local Mail keeps (ADR-0198).
 *
 * It lives in its own SQLite database rather than beside the cache, because the
 * cache is a disposable copy of Gmail that a reset replaces with a full re-pull
 * (ADR-0306), and a triage act a person made offline has to survive that. The
 * separation is mechanical: `reset` on the mailbox holds no handle to this
 * database and cannot reach it.
 *
 * What it holds is deliberately small: a partial map from `(message, label)` to
 * wanted or not wanted, each row carrying the revision it was asserted at. That
 * answers both questions the system asks. Reads: how do this message's effective
 * labels differ from Gmail's facts? Delivery: what is still owed, and is the
 * answer I am holding still the current one?
 *
 * There are exactly two ways a row leaves. `retire` requires the revision a
 * delivery actually proved, and `discardAll` is a person's explicit abandonment.
 * Neither is a guess about what Gmail already holds: an act cannot erase an
 * earlier act, it can only supersede it (ADR-0199).
 */

import type { AppSqliteDatabase } from '@epicenter/device';
import { sqliteHandle } from './handle.ts';

/**
 * One opinion: this message should, or should not, carry this label.
 *
 * The whole of what a caller says. `revision` is allocated by the store and
 * `assertedAt` is passed to `assert` for the batch, so neither belongs to the
 * act; they are what recording it added.
 */
export type LabelAssertion = {
	messageId: string;
	labelId: string;
	want: boolean;
};

/** An assertion as the store holds it: the opinion, plus its place in line. */
export type LabelIntent = LabelAssertion & {
	/** The account-monotonic revision this row was last asserted at. */
	revision: number;
	/** When the person made this act, which is what the outbox ages. */
	assertedAt: string;
};

export type IntentStore = ReturnType<typeof openIntentStore>;

export function openIntentStore(intent: AppSqliteDatabase, sub: string) {
	const { all, batch } = sqliteHandle(intent);

	return {
		sub,

		/**
		 * Record opinions, one fresh revision per pair, in one batch.
		 *
		 * Every opinion the act path passes is stored: this is the last word on
		 * each pair, not a judgement about whether it is worth delivering.
		 */
		async assert(
			assertions: readonly LabelAssertion[],
			assertedAt: string,
		): Promise<number> {
			if (assertions.length === 0) return 0;
			// Reserve revisions and write the assertions in one transaction. A
			// second store cannot read the same counter before this write lands.
			// The live-row floor preserves ordering if the counter is missing;
			// the durable counter prevents reuse after every intent is retired.
			await batch([
				{
					sql: `INSERT INTO intent_counters (sub, next_revision)
					      SELECT ?, COALESCE(MAX(revision), 0) + 1 + ?
					      FROM label_intents WHERE sub = ?
					      ON CONFLICT(sub) DO UPDATE SET
					        next_revision = MAX(intent_counters.next_revision,
					                    excluded.next_revision - ?) + ?`,
					parameters: [
						sub,
						assertions.length,
						sub,
						assertions.length,
						assertions.length,
					],
				},
				...assertions.map((assertion, index) => ({
					sql: `INSERT INTO label_intents
					        (sub, message_id, label_id, want, revision, asserted_at)
					      VALUES (?, ?, ?, ?,
					        (SELECT next_revision - ? FROM intent_counters
					         WHERE sub = ?), ?)
					      ON CONFLICT(sub, message_id, label_id) DO UPDATE SET
					        want = excluded.want,
					        revision = excluded.revision,
					        asserted_at = excluded.asserted_at`,
					parameters: [
						sub,
						assertion.messageId,
						assertion.labelId,
						assertion.want ? 1 : 0,
						assertions.length - index,
						sub,
						assertedAt,
					],
				})),
			]);
			return assertions.length;
		},

		/**
		 * How much is owed, without reading it.
		 *
		 * The one caller is removal, which asks before it deletes anything and
		 * must not open the account's mail file to find out (ADR-0320). Everything
		 * a person is shown about owed work comes from the outbox instead, which
		 * reads the rows and can name them.
		 */
		async count(): Promise<number> {
			const [row] = await all<{ owed: number }>(
				`SELECT count(*) AS owed FROM label_intents WHERE sub = ?`,
				[sub],
			);
			return row?.owed ?? 0;
		},

		/** Everything still owed to Gmail, oldest assertion first. */
		async pending(): Promise<LabelIntent[]> {
			const rows = await all<{
				message_id: string;
				label_id: string;
				want: number;
				revision: number;
				asserted_at: string;
			}>(
				`SELECT message_id, label_id, want, revision, asserted_at FROM label_intents
				 WHERE sub = ? ORDER BY revision`,
				[sub],
			);
			return rows.map((row) => ({
				messageId: row.message_id,
				labelId: row.label_id,
				want: row.want === 1,
				revision: row.revision,
				assertedAt: row.asserted_at,
			}));
		},

		/**
		 * Forget assertions Gmail has now confirmed.
		 *
		 * The revision match is the whole point: a pair re-asserted while the
		 * delivery was in flight carries a newer revision, so this deletes nothing
		 * and the next pass delivers the newer opinion.
		 */
		async retire(retirements: readonly LabelIntent[]): Promise<number> {
			if (retirements.length === 0) return 0;
			const changes = await batch(
				retirements.map((retirement) => ({
					sql: `DELETE FROM label_intents
					      WHERE sub = ? AND message_id = ? AND label_id = ? AND revision = ?`,
					parameters: [
						sub,
						retirement.messageId,
						retirement.labelId,
						retirement.revision,
					] as const,
				})),
			);
			return changes.reduce((total, change) => total + change, 0);
		},

		/**
		 * Abandon every undelivered assertion, and report how many.
		 *
		 * This is the human bound on retrying: nothing ages out and nothing gives
		 * up after N attempts, so the only way an undelivered act stops being owed
		 * without reaching Gmail is somebody saying so (ADR-0199). The revision
		 * counter is untouched, so a later assertion still cannot collide with an
		 * in-flight delivery's number.
		 */
		async discardAll(): Promise<number> {
			const [changes] = await batch([
				{
					sql: `DELETE FROM label_intents WHERE sub = ?`,
					parameters: [sub],
				},
			]);
			return changes ?? 0;
		},
	};
}
