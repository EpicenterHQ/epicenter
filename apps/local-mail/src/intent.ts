import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { accountDirPath, ensureAccountDir, secureDbFiles } from './paths.ts';

/**
 * `intent.db`: the durable half of an account's local state, and the only
 * irreplaceable bytes Local Mail keeps. It sits beside the mirror
 * (`<dataDir>/<accountEmail>/`) rather than inside it, because the mirror is a
 * disposable copy of Gmail that gets deleted and rebuilt whenever its shape
 * changes, and a triage act the user made offline must survive that.
 *
 * What it holds is deliberately small: a partial map from `(message_id,
 * label_id)` to "wanted" or "not wanted", each row carrying the sequence number
 * it was asserted at. That is enough to answer both questions the system asks:
 *
 * - Reads: how do this message's effective labels differ from Gmail's facts?
 * - Delivery: what is still owed to Gmail, and is the answer I am holding still
 *   the current one?
 *
 * It is NOT a queue, an action log, a payload table, a retry counter, a
 * dead-letter table, a schedule, or a standing policy. The primary key is the
 * design: re-asserting a pair overwrites its `want` and takes a fresh `seq`, so
 * archive then unarchive then archive is one row, and asking for what a message
 * already has is not an assertion at all but the removal of one (see
 * `withdraw`). Nothing here talks to Gmail; `reconcile.ts` is the only writer to
 * the provider, and it is the only caller of `pending` and `retire`.
 *
 * `seq` comes from a counter in `_meta`, not from `max(seq) + 1`: retirement
 * empties the table, and a counter that restarts would let an in-flight delivery
 * retire a newer assertion that happened to reuse its number. It is the whole
 * mechanism behind "an older delivery cannot retire a newer assertion", so it
 * has to be monotonic for the life of the account, not the life of the rows.
 *
 * Durability is `synchronous = FULL`, unlike the mirror's `NORMAL`. The mirror
 * answers a lost commit by re-pulling from Gmail; this file has no such answer.
 */

/** One row of the map: this message should (or should not) carry this label. */
export type LabelIntent = {
	messageId: string;
	labelId: string;
	/** `true`: the label belongs on the message. `false`: it does not. */
	want: boolean;
	/** The account-monotonic sequence this row was last asserted at. */
	seq: number;
};

/** An opinion to record. `seq` is allocated by the store, never by the caller. */
export type LabelAssertion = Omit<LabelIntent, 'seq'>;

/** A pair to remove (the act path cancelling) or to retire (delivery landing,
 * which additionally has to match `seq`). */
export type LabelIntentPair = Pick<LabelIntent, 'messageId' | 'labelId'>;

export function intentDbPath(dataDir: string, accountEmail: string): string {
	return join(accountDirPath(dataDir, accountEmail), 'intent.db');
}

export type IntentDb = ReturnType<typeof openIntentDb>;

type IntentDbLocation = { dataDir: string; accountEmail: string };

/**
 * Open (creating if needed) one account's durable intent store. Cheap enough to
 * call on any path that needs it: the file is a few pages, and every surface
 * that reads effective labels needs the schema to exist before it can attach it
 * (see `db.ts`).
 */
export function openIntentDb({ dataDir, accountEmail }: IntentDbLocation) {
	ensureAccountDir(dataDir, accountEmail);
	const path = intentDbPath(dataDir, accountEmail);
	const db = new Database(path, { create: true });
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA busy_timeout = 5000;');
	// The mirror runs NORMAL because Gmail can rebuild it. Nothing can rebuild
	// this file, so it pays the fsync.
	db.exec('PRAGMA synchronous = FULL;');
	db.exec(`
		CREATE TABLE IF NOT EXISTS label_intents (
			message_id TEXT    NOT NULL,
			label_id   TEXT    NOT NULL,
			want       INTEGER NOT NULL,
			seq        INTEGER NOT NULL,
			PRIMARY KEY (message_id, label_id)
		);
		CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
	`);
	secureDbFiles(path);

	const readSeqStmt = db.query<{ value: string }, []>(
		`SELECT value FROM _meta WHERE key = 'next_seq'`,
	);
	const writeSeqStmt = db.query<never, [string]>(
		`INSERT INTO _meta (key, value) VALUES ('next_seq', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const upsertStmt = db.query<never, [string, string, number, number]>(
		`INSERT INTO label_intents (message_id, label_id, want, seq)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(message_id, label_id) DO UPDATE SET
		   want = excluded.want,
		   seq = excluded.seq`,
	);
	const deletePairStmt = db.query<never, [string, string]>(
		`DELETE FROM label_intents WHERE message_id = ? AND label_id = ?`,
	);
	const retireStmt = db.query<never, [string, string, number]>(
		`DELETE FROM label_intents
		 WHERE message_id = ? AND label_id = ? AND seq = ?`,
	);
	const pendingStmt = db.query<
		{ message_id: string; label_id: string; want: number; seq: number },
		[]
	>(`SELECT message_id, label_id, want, seq FROM label_intents ORDER BY seq`);

	const maxSeqStmt = db.query<{ seq: number | null }, []>(
		`SELECT max(seq) AS seq FROM label_intents`,
	);

	/**
	 * The next sequence to hand out. The counter in `_meta` is the source, and it
	 * survives the table emptying; the `max(seq)` floor is there so a lost or
	 * unreadable counter can never hand out a number a live row already holds,
	 * which is the one thing that would let a stale delivery retire a newer wish.
	 */
	function nextSeq(): number {
		const stored = Number(readSeqStmt.get()?.value);
		const counter = Number.isSafeInteger(stored) && stored > 0 ? stored : 1;
		return Math.max(counter, (maxSeqStmt.get()?.seq ?? 0) + 1);
	}

	return {
		path,

		/**
		 * Record opinions, one fresh sequence per pair, in one transaction. The
		 * caller has already decided that each pair diverges from what Gmail's
		 * facts say (`assert.ts`); this only stores the decision.
		 */
		assert(assertions: LabelAssertion[]): number {
			if (assertions.length === 0) return 0;
			const tx = db.transaction(() => {
				let seq = nextSeq();
				for (const { messageId, labelId, want } of assertions) {
					upsertStmt.run(messageId, labelId, want ? 1 : 0, seq);
					seq += 1;
				}
				writeSeqStmt.run(String(seq));
				return assertions.length;
			});
			return tx.immediate();
		},

		/**
		 * Drop assertions outright: the user asked for what Gmail already has, so
		 * there is nothing to deliver. This is how an inverse act cancels a write
		 * that has not left the machine, and it is why undo before the next
		 * reconcile costs Gmail nothing.
		 */
		withdraw(pairs: LabelIntentPair[]): number {
			if (pairs.length === 0) return 0;
			const tx = db.transaction(() => {
				let removed = 0;
				for (const { messageId, labelId } of pairs) {
					removed += deletePairStmt.run(messageId, labelId).changes;
				}
				return removed;
			});
			return tx.immediate();
		},

		/** Everything still owed to Gmail, oldest assertion first. */
		pending(): LabelIntent[] {
			return pendingStmt.all().map((row) => ({
				messageId: row.message_id,
				labelId: row.label_id,
				want: row.want === 1,
				seq: row.seq,
			}));
		},

		/**
		 * Forget assertions Gmail has now confirmed. The `seq` match is the whole
		 * point: a pair re-asserted while the delivery was in flight carries a
		 * newer sequence, so this deletes nothing and the next pass delivers the
		 * newer opinion. Returns how many rows were actually retired.
		 */
		retire(retirements: LabelIntent[]): number {
			if (retirements.length === 0) return 0;
			const tx = db.transaction(() => {
				let retired = 0;
				for (const { messageId, labelId, seq } of retirements) {
					retired += retireStmt.run(messageId, labelId, seq).changes;
				}
				return retired;
			});
			return tx.immediate();
		},

		close(): void {
			db.close();
		},
	};
}
