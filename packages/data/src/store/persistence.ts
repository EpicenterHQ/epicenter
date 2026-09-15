/**
 * The store's local-persistence debt: accepted work the durable engine has not
 * confirmed yet (ADR-0238).
 *
 * Each store owns one controller. It holds the ordered queue of durable
 * operations the live document has accepted, hands the WHOLE queue to the
 * runtime's storage port as one atomic batch, and mirrors what the engine has
 * confirmed so the sync sender can read durable facts without touching
 * storage. A failed flush retains everything, in order, and reports
 * `blocked`; a later enqueue or an explicit `flush()` retries. Nothing here
 * ever invalidates the live document.
 */

import * as Y from '@y/y';
import { defineErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { copyBytes, SNAPSHOT_FOLD_THRESHOLD } from './log.js';

/** One unsent entry, at the local position that orders it. */
export type OutboxEntry = { id: number; bytes: Uint8Array };

export type DurableOp =
	| {
			kind: 'append';
			/**
			 * One monotone sequence, never reused.
			 *
			 * Never reused is the load-bearing half. The fold used to renumber the
			 * chain from 1, so a position recorded against it silently came to
			 * mean a different update, which is why owed work had to live in a
			 * relation of its own. Stable ids make it a column.
			 */
			id: number;
			bytes: Uint8Array;
			/** The authority's log position, or `undefined` while it has none. */
			authoritySeq: number | undefined;
	  }
	| {
			/**
			 * The authority took responsibility through `throughId` and put those
			 * bytes at `authoritySeq`.
			 *
			 * One submission lands as ONE log entry, so every covered append takes
			 * the same position. This is both halves of what the client used to do
			 * in two calls, `advance` and `acknowledge`.
			 */
			kind: 'ack';
			throughId: number;
			authoritySeq: number;
	  }
	| {
			/**
			 * Owed appends collapse into one resendable row (ADR-0301).
			 *
			 * An acknowledged row folds by whole-document re-encode; an owed row
			 * cannot, because the authority has never seen those bytes and a whole
			 * document is not a delta it could be offered. Owed rows merge instead,
			 * which keeps an offline device's chain bounded by the threshold rather
			 * than by how long it stayed offline.
			 */
			kind: 'mergeOwed';
			/** The owed rows these bytes replace. */
			replaces: readonly number[];
			/**
			 * The new row, and it is ABOVE every existing id on purpose.
			 *
			 * An acknowledgement stamps `id <= throughId`. A merged row that
			 * inherited the lowest id it replaced would be stamped by an
			 * acknowledgement for a submission that did not carry all of its bytes,
			 * marking unsent work as sent and losing it in silence. Above the range,
			 * no earlier acknowledgement can name it, so a merge that races a
			 * submission costs a redelivery the authority absorbs by idempotence.
			 */
			id: number;
			bytes: Uint8Array;
	  };

/**
 * Everything the durable engine held at open, materialized once.
 *
 * `outbox` and `cursor` are DERIVED here rather than stored: owed work is
 * every append the authority gave no position, and the cursor is the highest
 * position any append carries. The port computes both while it has the file
 * open, so the store never asks storage a second question.
 */
export type DurableSnapshot = {
	/** The database document's chain, oldest first. */
	updates: Uint8Array[];
	/** Appends with no authority position, in id order. */
	outbox: OutboxEntry[];
	/**
	 * The highest authority position any append carries, or 0.
	 *
	 * A derived cursor cannot outrun the bytes it accounts for, because it is
	 * computed from them. It can only LAG, which is safe: a re-received entry
	 * is applied again, and an update is idempotent.
	 */
	cursor: number;
	/** The highest id any append carries, so the store mints from here. */
	lastId: number;
};

/**
 * The runtime-native durable engine: apply one batch atomically, or not at
 * all.
 *
 * `commit` may be synchronous (a Durable Object's storage, the memory record) or
 * asynchronous (IndexedDB). The atomicity requirement is absolute either way:
 * a batch that half-commits would let a cursor outrun the bytes it accounts
 * for, which is exactly the corruption ADR-0231 exists to prevent. Ordering
 * within the batch is the queue's order.
 *
 * One verb, because there is one document (ADR-0295). The two readers this
 * used to carry, `readDocument` and `listDocuments`, served a manager that
 * hydrated a row's own document on demand and enumerated every chain a store
 * held; a store holds one chain, and it is loaded whole at open.
 */
export type DurablePort = {
	commit(ops: readonly DurableOp[]): void | Promise<void>;
};

export type PersistenceStatus = 'saved' | 'pending' | 'blocked';

/**
 * The public face of the local-persistence debt (ADR-0238).
 *
 * `saved` means no accepted work remains only in memory. `pending` means work
 * is waiting for, or participating in, a requested flush. `blocked` means the
 * latest flush failed and edits may be lost on restart; a later edit or an
 * explicit `flush()` retries.
 */
export type PersistenceCapability = {
	get(): PersistenceStatus;
	/** Hear when the status changes. Never fires initially. */
	subscribe(listener: () => void): () => void;
	/**
	 * Request one attempt over everything outstanding. Resolves when the
	 * controller settles, whatever the outcome; the outcome is `get()`'s
	 * answer.
	 */
	flush(): Promise<void>;
};

const PersistenceError = defineErrors({
	/**
	 * A flush failed and the work is retained in memory.
	 *
	 * Logged, never returned: the caller that triggered the flush already got
	 * its `Ok`, because acceptance and durability are two steps (ADR-0238).
	 * The status is the channel; this is the diagnostic behind it.
	 */
	FlushFailed: ({ cause, retained }: { cause: unknown; retained: number }) => ({
		message: `A durable flush failed; ${retained} operation(s) retained in memory`,
		cause,
		retained,
	}),
	/**
	 * A subscriber threw while being told about persistence. Logged, never
	 * returned: it is the subscriber's own bug, and one broken listener must
	 * not cost the others their notification.
	 */
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: 'A persistence subscriber threw while being notified',
		cause,
	}),
});

export type PersistenceController = {
	/** Finish an already admitted write while the public owner closes. */
	save(): Promise<boolean>;
	/** End the retired in-memory queue without submitting or retrying its work. */
	discard(): Promise<void>;
	close(): Promise<void>;
	append(bytes: Uint8Array, authoritySeq: number | undefined): void;
	acknowledge(throughId: number, authoritySeq: number): void;
	coalesce(): OutboxEntry | undefined;
	onSendable(listener: () => void): () => void;
	persistence: PersistenceCapability;
	durableCursor(): number;
};

export function createPersistenceController({
	port,
	loaded,
	log,
	assertUsable,
}: {
	port: DurablePort;
	loaded: DurableSnapshot;
	log: Logger;
	assertUsable(): void;
}): PersistenceController {
	/** Accepted ops the durable engine has not confirmed, in order. */
	let queue: DurableOp[] = [];
	/** One drain owns every commit, including native synchronous adapters. */
	let running: Promise<void> | undefined;
	/** A new request permits one retry after an in-flight failure. */
	let requested = false;

	// The durable mirror: what the engine has confirmed, advanced only on a
	// successful flush. Reading it never touches storage, which is what lets
	// the sync sender stay synchronous over an asynchronous engine.
	let outbox: OutboxEntry[] = [...loaded.outbox];
	let cursor = loaded.cursor;
	let nextId = loaded.lastId + 1;
	let lastCoalescedId = 0;
	// This session already received these acknowledgements. A restart forgets
	// this floor and recovers any retirement that did not reach storage.
	let acknowledgedThroughId = 0;
	let closed = false;
	let discarded = false;
	const sendableListeners = new Set<() => void>();

	const statusListeners = new Set<() => void>();

	function status(): PersistenceStatus {
		if (running !== undefined) return 'pending';
		if (queue.length > 0) return 'blocked';
		return 'saved';
	}

	let lastStatus: PersistenceStatus = status();

	/**
	 * Tell every listener, and let none of them cost another its notification.
	 *
	 * Copied before iteration, because a listener is allowed to unsubscribe
	 * while being told. A throw is contained and logged: the work this reports
	 * on has already been accepted by the live document, so a broken listener
	 * is that listener's bug.
	 */
	function notify(listeners: ReadonlySet<() => void>): void {
		for (const listener of [...listeners]) {
			if (!listeners.has(listener)) continue;
			try {
				listener();
			} catch (cause) {
				log.error(PersistenceError.SubscriberThrew({ cause }).error);
			}
		}
	}

	function notifyStatus(): void {
		const next = status();
		if (next === lastStatus) return;
		lastStatus = next;
		notify(statusListeners);
	}

	/**
	 * Advance the durable mirror over a batch the engine confirmed, and wake the
	 * transport if any of it is now owed to the authority.
	 */
	function succeeded(batch: readonly DurableOp[]): void {
		for (const op of batch) {
			switch (op.kind) {
				case 'append': {
					// Owed exactly when the authority has no position for it, which
					// is the same test the port runs against the column.
					if (op.authoritySeq === undefined) {
						outbox.push({ id: op.id, bytes: op.bytes });
					} else if (op.authoritySeq > cursor) {
						cursor = op.authoritySeq;
					}
					break;
				}
				case 'ack':
					// One op, both halves: the covered work stops being owed, and the
					// position it landed at becomes the cursor. They were always one
					// fact reported twice.
					outbox = outbox.filter((entry) => entry.id > op.throughId);
					if (op.authoritySeq > cursor) cursor = op.authoritySeq;
					break;
				case 'mergeOwed': {
					// Still owed, still in order: the replacement carries the bytes of
					// everything it replaces and takes a higher id, so appending it
					// after the filter keeps the mirror sorted without a sort.
					const replaced = new Set(op.replaces);
					outbox = outbox.filter((entry) => !replaced.has(entry.id));
					outbox.push({ id: op.id, bytes: op.bytes });
					break;
				}
			}
		}
	}

	function maintain(): void {
		if (queue.length > 0) return;
		const owed = outbox.filter(
			(entry) => entry.id > lastCoalescedId && entry.id > acknowledgedThroughId,
		);
		if (owed.length < SNAPSHOT_FOLD_THRESHOLD) return;
		queue.push({
			kind: 'mergeOwed',
			id: nextId++,
			replaces: owed.map((entry) => entry.id),
			bytes: merge(owed),
		});
	}

	function merge(entries: readonly OutboxEntry[]): Uint8Array {
		if (entries.length === 1) return copyBytes(entries[0]!.bytes);
		return new Uint8Array(
			Y.mergeUpdatesV2(
				entries.map((entry) =>
					copyBytes(entry.bytes),
				) as Uint8Array<ArrayBuffer>[],
			),
		);
	}

	function enqueue(ops: readonly DurableOp[]): void {
		if (discarded || ops.length === 0) return;
		queue.push(...ops);
		void flush();
	}

	function failed(batch: readonly DurableOp[], cause: unknown): void {
		// Everything comes back, in order, ahead of whatever arrived meanwhile.
		// The live document already holds this work; only the durable copy is
		// behind, and the status says so.
		queue = [...batch, ...queue];
		log.error(
			PersistenceError.FlushFailed({ cause, retained: queue.length }).error,
		);
	}

	/** One completion path makes durability independent of adapter timing. */
	function flush(): Promise<void> {
		if (discarded) return running ?? Promise.resolve();
		if (running !== undefined) {
			requested = true;
			return running;
		}
		if (queue.length === 0) return Promise.resolve();
		// Publish ownership before invoking the port or notifying subscribers.
		running = Promise.resolve().then(async () => {
			try {
				while (queue.length > 0) {
					requested = false;
					const batch = queue;
					queue = [];
					try {
						await port.commit(batch);
					} catch (cause) {
						if (discarded) return;
						failed(batch, cause);
						if (requested) continue;
						break;
					}
					if (discarded) return;
					succeeded(batch);
					if (
						!closed &&
						batch.some(
							(op) =>
								op.kind === 'mergeOwed' ||
								(op.kind === 'append' && op.authoritySeq === undefined),
						)
					) {
						notify(sendableListeners);
					}
					maintain();
				}
			} finally {
				// Release ownership in the same continuation as the last commit.
				// A chained finalizer would leave a microtask gap that strands edits.
				running = undefined;
				notifyStatus();
			}
		});
		notifyStatus();
		return running;
	}

	return {
		async save() {
			await flush();
			return !discarded && status() === 'saved';
		},
		discard() {
			discarded = true;
			closed = true;
			queue = [];
			outbox = [];
			requested = false;
			sendableListeners.clear();
			statusListeners.clear();
			return running ?? Promise.resolve();
		},
		close() {
			closed = true;
			sendableListeners.clear();
			statusListeners.clear();
			// close may be called inside the transaction whose update has not
			// reached enqueue yet. Drain after that synchronous stack completes.
			return Promise.resolve().then(flush);
		},
		append(bytes, authoritySeq) {
			enqueue([{ kind: 'append', id: nextId++, bytes, authoritySeq }]);
		},
		acknowledge(throughId, authoritySeq) {
			acknowledgedThroughId = Math.max(acknowledgedThroughId, throughId);
			enqueue([{ kind: 'ack', throughId, authoritySeq }]);
		},
		coalesce() {
			const entries = outbox.filter(
				(entry) => entry.id > acknowledgedThroughId,
			);
			const last = entries.at(-1);
			if (last === undefined) return undefined;
			lastCoalescedId = Math.max(lastCoalescedId, last.id);
			return { id: last.id, bytes: merge(entries) };
		},
		onSendable(listener) {
			sendableListeners.add(listener);
			return () => {
				sendableListeners.delete(listener);
			};
		},
		persistence: Object.freeze({
			get() {
				assertUsable();
				return status();
			},
			subscribe(listener: () => void): () => void {
				assertUsable();
				statusListeners.add(listener);
				return () => statusListeners.delete(listener);
			},
			flush() {
				assertUsable();
				return flush();
			},
		}),
		durableCursor: () => cursor,
	};
}
