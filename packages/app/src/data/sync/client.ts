/**
 * The client half of the transport: coalesce, send, wait for the ack.
 *
 * It owns no socket and no reconnect policy. A caller hands it a socket that
 * can `send`, feeds it whatever arrives, and tells it when the socket is gone.
 * That keeps every timing rule in this file testable without a network, which
 * matters more than usual here: a previous cursor rule on this branch "worked"
 * in a simulation where nothing was ever delivered.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import { type DataDocument, syncEngineOf } from '../store/store.js';
import {
	CHUNK_BYTES,
	createChunkCollector,
	decodeFrame,
	encodeFrame,
	intoChunks,
} from './frames.js';

export const SyncClientError = defineErrors({
	/**
	 * The authority refused bytes this replica authored.
	 *
	 * Terminal for the submission and deliberately loud. The work is still held,
	 * so nothing is lost, but a replica whose writes the authority will not take
	 * is not syncing and must not look like it is.
	 */
	Refused: ({ reason }: { reason: string }) => ({
		message: `The authority refused this replica's update: ${reason}`,
		reason,
	}),
	/**
	 * An entry arrived that is not the next one.
	 *
	 * The log is a total order and a replica reads it in order, so a jump means
	 * something was dropped. Applying past it would make the loss permanent and
	 * silent, which is precisely the failure mode that has to stay impossible.
	 */
	Gap: ({ expected, received }: { expected: number; received: number }) => ({
		message: `Expected entry ${expected} and received ${received}`,
		expected,
		received,
	}),
	/**
	 * An entry arrived that this replica cannot apply.
	 *
	 * The poison pill, seen from the only place it is ever visible. The cursor
	 * does not move, so the replica is stuck here and will be stuck here on every
	 * reconnect, forever, until someone neutralises that position in the
	 * authority's log. Naming the position is what makes that a one-row repair
	 * rather than an unexplained device that stopped syncing.
	 */
	/**
	 * The frames arriving no longer add up to anything this replica can use.
	 *
	 * Chunks that contradict their own count, or a partial left behind by a dead
	 * socket colliding with a later frame at the same position. It is silent by
	 * nature: the reassembly simply never completes, so the replica stops moving
	 * while every layer reports success. Recovery is the reconnect a gap needs.
	 */
	BrokenStream: ({ reason }: { reason: string }) => ({
		message: `This replica cannot reassemble what it is being sent: ${reason}`,
		reason,
	}),
	Unapplyable: ({ seq, cause }: { seq: number; cause: unknown }) => ({
		message: `Entry ${seq} could not be applied, and this replica is stuck at ${seq - 1}`,
		seq,
		cause,
	}),
});
export type SyncClientError = InferErrors<typeof SyncClientError>;

/** Whatever carries bytes. A `WebSocket` satisfies this. */
export type SyncSocket = { send(bytes: Uint8Array): void };

export type SyncClientStatus = {
	/** How far through the authority's log this replica has read. */
	cursor: number;
	/** Whether a submission is out and waiting for its position. */
	inFlight: boolean;
	/**
	 * Which submission is out, or undefined when none is.
	 *
	 * `inFlight` alone cannot tell a stalled client from a busy one. Only one
	 * submission is ever out, and the next starts the moment the previous is
	 * acknowledged, so under sustained local work `inFlight` is continuously
	 * true while everything is perfectly healthy. A watchdog needs to know that
	 * the SAME submission is still out, which is what this number says.
	 */
	inFlightSubmission: number | undefined;
	/** Bytes this replica owes the authority, at the last coalesce. */
	owed: number;
	lastError: SyncClientError | undefined;
	/**
	 * Whether the document is holding updates whose dependencies never arrived.
	 *
	 * Reads as an alarm rather than as a state. Entries are applied in log order
	 * and the log is causally complete, so after a contiguous read this is false;
	 * true means the transport delivered something it should not have been able
	 * to, and no other layer will say so.
	 */
	unresolvedDependencies: boolean;
	/**
	 * Whether this replica is stuck and needs to be reconnected.
	 *
	 * A gap means an entry was dropped, and the cursor deliberately does not move
	 * past it, so every later entry is also a gap and the replica silently stops
	 * syncing forever. It set an error and waited for someone to notice, which a
	 * randomised schedule showed nobody does: a device wedged at position 108
	 * kept receiving 118, 119, 121 and rejecting all of them.
	 *
	 * Recovery is a reconnect, which asks the authority for everything after this
	 * replica's own cursor and is the same catch-up any returning device runs.
	 * The caller owns the socket, so the caller has to do it; this is how it
	 * finds out.
	 */
	needsResync: boolean;
};

export type SyncClient = {
	/** The position to ask the authority to start from. Goes in the URL. */
	cursor(): number;
	/** A socket is live. Anything owed goes out now. */
	attach(socket: SyncSocket): void;
	/** The socket is gone. Whatever was in flight is owed again. */
	detach(): void;
	/** Local work happened. Sends after the idle interval. */
	nudge(): void;
	/** Send whatever is owed, now. */
	flush(): Result<void, SyncClientError>;
	/** Bytes arrived from the authority. */
	receive(message: Uint8Array): Result<void, SyncClientError>;
	status(): SyncClientStatus;
	dispose(): void;
};

/** Cancelable delayed work, injected so tests do not wait in real time. */
export type Schedule = (task: () => void, delayMs: number) => () => void;

const defaultSchedule: Schedule = (task, delayMs) => {
	const handle = setTimeout(task, delayMs);
	return () => clearTimeout(handle);
};

/**
 * The ceiling on chunks held for a submission that is still incomplete.
 *
 * Reassembly is in memory, so a peer that opens a submission and never
 * finishes it asks the other side to hold bytes indefinitely. Past this the
 * partial is dropped and the peer is refused, which it can act on because it
 * still owes the work.
 *
 * A constant rather than an option. It was one here and on `createSyncHub`,
 * threaded through `createSyncConnection` on the way, and across the life of
 * the three files no caller ever passed it.
 */
const BUFFER_CEILING_BYTES = 64 * 1024 * 1024;

export function createSyncClient({
	store,
	/**
	 * How long local work waits before it is sent.
	 *
	 * The whole 30x. One update per transaction grew the authority's log to
	 * 1,261 MB over a decade in simulation and roughly a second of coalescing
	 * brought that to 40 MB, which is what made refusing compaction affordable
	 * (`evidence/bench/never-compact.ts`). It is an idle timer rather than a
	 * fixed batch because it is the same interval an editor debounces on anyway.
	 */
	idleMs = 1_000,
	schedule = defaultSchedule,
}: {
	store: DataDocument;
	idleMs?: number;
	schedule?: Schedule;
}): SyncClient {
	// The delivery machinery behind the store's public capability: the client
	// log, applyRemote, and the dependency alarm. Only the transport drives
	// these, which is the whole reason they are not on `DataDocument` itself.
	const engine = syncEngineOf(store);
	// Rebuilt on every attach rather than held for the life of the client. A
	// collector keyed by position outliving its socket is how a partial left by a
	// dead connection collides with a later frame at the same number.
	let collector = createChunkCollector({ limitBytes: BUFFER_CEILING_BYTES });
	/**
	 * The live connection, and the one submission it may have outstanding.
	 *
	 * Nested rather than adjacent, because a submission cannot outlive the
	 * socket that would answer it. As two variables they had one lifetime and
	 * three sites clearing it, and one of the three cleared only half: `dispose`
	 * dropped the socket and left the submission behind. That leftover is
	 * harmless, and it is harmless only because a fourth variable, `disposed`,
	 * makes the sender unreachable afterwards. A flag standing in for an
	 * invariant is what produces exactly that kind of remainder, so the
	 * invariant is in the type instead: there is no way to be holding a
	 * submission with no socket to answer it.
	 */
	let connection:
		| {
				socket: SyncSocket;
				outstanding: { submission: number; throughId: number } | undefined;
		  }
		| undefined;
	let nextSubmission = 1;
	let cursor = engine.cursor();
	let owed = 0;
	let lastError: SyncClientError | undefined;
	let needsResync = false;
	let cancelIdle: (() => void) | undefined;
	let disposed = false;

	function clearIdle(): void {
		cancelIdle?.();
		cancelIdle = undefined;
	}

	function send(): Result<void, SyncClientError> {
		// One submission at a time. Two in flight would make an ack ambiguous
		// about which appends it retires, and the durable outbox is the only
		// record that work is still owed (ADR-0302).
		// Two conditions, and they mean different things. No connection is "this
		// cannot be sent"; an outstanding submission is "this must not be sent
		// yet". Both answer Ok, because `send` is called on every state change
		// that could make a send possible, and "nothing to do" is its ordinary
		// outcome rather than a failure to report.
		if (connection === undefined || connection.outstanding !== undefined) {
			return Ok(undefined);
		}

		const entry = engine.coalesce();
		if (entry === undefined) {
			owed = 0;
			return Ok(undefined);
		}
		owed = entry.bytes.length;

		const submission = nextSubmission;
		nextSubmission += 1;
		const sending = connection;
		sending.outstanding = { submission, throughId: entry.id };
		const chunks = intoChunks(entry.bytes, CHUNK_BYTES);
		for (const [index, chunk] of chunks.entries()) {
			if (connection !== sending) return Ok(undefined);
			sending.socket.send(
				encodeFrame({
					kind: 'push',
					submission,
					chunk: index,
					chunks: chunks.length,
					bytes: chunk,
				}),
			);
		}
		return Ok(undefined);
	}

	/** Report a reassembly failure and ask to be reconnected. */
	function brokenStream(reason: string): Result<void, SyncClientError> {
		const broken = SyncClientError.BrokenStream({ reason });
		lastError = broken.error;
		needsResync = true;
		return broken;
	}

	function apply(
		seq: number,
		bytes: Uint8Array,
	): Result<void, SyncClientError> {
		// Already applied. Re-delivery is not an error, it is a design property
		// the transport leans on in three places: a crash between committing
		// bytes and advancing the cursor re-sends, a reconnect re-sends whatever
		// was in flight, and a hibernating Durable Object wakes holding a
		// position that is BEHIND what it really sent and deliberately re-sends
		// from there. Reporting a gap here made the recovery path look like data
		// loss, and a randomised schedule hit it within a few dozen rounds.
		if (seq <= cursor) return Ok(undefined);
		if (seq !== cursor + 1) {
			// Never applied, and the cursor never moves. The caller's repair is to
			// reconnect from `cursor`, which is a catch-up and the same code path
			// the authority already runs.
			const gap = SyncClientError.Gap({ expected: cursor + 1, received: seq });
			lastError = gap.error;
			needsResync = true;
			return gap;
		}
		// Bytes and bookmark in ONE transaction (ADR-0231). The old shape was
		// bytes-first-cursor-after in two commits, and the crash between them
		// manufactured a replica durably holding another document's bytes while
		// presenting a fresh install's dial, which admission would greet and
		// merge across the break. Atomicity keeps re-delivery free (a crash
		// leaves neither); the membership stamp is already durable, because a
		// frame like this one is dropped until it is.
		const { error } = engine.applyRemote(bytes, { advanceTo: seq });
		if (error !== null) {
			// The cursor does not move, so nothing is skipped and nothing is lost.
			// But this replica is now stuck at this position on every reconnect
			// forever, which is the whole poison-pill failure, and it has to be
			// LOUD. Swallowing it here was worse than the pill: the device simply
			// stopped syncing and every layer reported success.
			const stuck = SyncClientError.Unapplyable({ seq, cause: error });
			lastError = stuck.error;
			return stuck;
		}
		cursor = seq;
		return Ok(undefined);
	}

	/**
	 * Take the authority's snapshot, and move this replica's cursor to it.
	 *
	 * The ONE place a cursor may jump. Everywhere else a position that is not
	 * the next one is refused, because a gap in the log is data nobody will ever
	 * mention again; here the jump is safe for a reason that has nothing to do
	 * with trust: the snapshot covers every position at or before it, so there
	 * is nothing in the skipped range that these bytes do not already carry.
	 *
	 * It MERGES rather than replaces. The snapshot preserves struct identities,
	 * so unsent offline work survives and goes out afterwards like any other
	 * local write.
	 */
	function adopt(
		position: number,
		bytes: Uint8Array,
	): Result<void, SyncClientError> {
		if (position <= cursor) return Ok(undefined);
		const { error } = engine.applyRemote(bytes, { advanceTo: position });
		if (error !== null) {
			const stuck = SyncClientError.Unapplyable({
				seq: position,
				cause: error,
			});
			lastError = stuck.error;
			return stuck;
		}
		cursor = position;
		return Ok(undefined);
	}

	/**
	 * Answer a request for a snapshot with this replica's whole state: the one
	 * database document, as one update (ADR-0295).
	 *
	 * Refused unless this replica is exactly at the position asked for, and
	 * unless it is holding no update whose dependencies never arrived. Both
	 * would produce a snapshot missing data, and a snapshot replaces history
	 * rather than adding to it, so what it misses is gone for everybody.
	 *
	 * The encode is synchronous, and that is what makes this whole function a
	 * straight line. It used to be a promise, so the position had to be
	 * re-checked inside the callback: state that moved between the guard and
	 * the encode would stamp newer content with an older position. Nothing can
	 * move between two statements, so the guard above is the only guard needed.
	 */
	function offerSnapshot(position: number): Result<void, SyncClientError> {
		if (connection === undefined || position !== cursor) return Ok(undefined);
		if (engine.hasUnresolvedDependencies()) return Ok(undefined);
		let bytes: Uint8Array;
		try {
			bytes = engine.encodeSnapshot();
		} catch {
			// Best effort by design: a snapshot that could not be built is not
			// owed, and the authority re-asks while the tail keeps growing. The
			// one throw here is a disposed store, which is not this function's
			// to report.
			return Ok(undefined);
		}
		const sending = connection;
		const chunks = intoChunks(bytes, CHUNK_BYTES);
		for (const [index, chunk] of chunks.entries()) {
			if (connection !== sending) return Ok(undefined);
			sending.socket.send(
				encodeFrame({
					kind: 'offer',
					position,
					chunk: index,
					chunks: chunks.length,
					bytes: chunk,
				}),
			);
		}
		return Ok(undefined);
	}

	return Object.freeze({
		cursor: () => cursor,

		attach(next: SyncSocket) {
			// Whatever was in flight was never acknowledged, so it is owed again.
			// The authority may well have stored it; a second copy costs log bytes
			// and changes nothing, because an update is idempotent. Replacing the
			// whole connection is what says that, rather than two assignments that
			// have to agree.
			connection = { socket: next, outstanding: undefined };
			// A new socket starts a new reassembly. Whatever the old one left half
			// delivered is being re-sent from this replica's cursor anyway, and
			// keeping it could only collide.
			collector = createChunkCollector({ limitBytes: BUFFER_CEILING_BYTES });
			// A fresh socket asks from this replica's own cursor, which is exactly
			// the repair a gap needs.
			needsResync = false;
			send();
		},

		detach() {
			connection = undefined;
			collector = createChunkCollector({ limitBytes: BUFFER_CEILING_BYTES });
			clearIdle();
		},

		nudge() {
			if (disposed || cancelIdle !== undefined) return;
			cancelIdle = schedule(() => {
				cancelIdle = undefined;
				send();
			}, idleMs);
		},

		flush() {
			clearIdle();
			return send();
		},

		receive(message: Uint8Array): Result<void, SyncClientError> {
			const { data: frame, error } = decodeFrame(message);
			if (error !== null) return Ok(undefined);

			switch (frame.kind) {
				case 'ack': {
					const outstanding = connection?.outstanding;
					if (
						outstanding === undefined ||
						frame.submission !== outstanding.submission
					) {
						return Ok(undefined);
					}
					// An ack is an entry frame with the payload elided: it names a
					// position, and this replica is expected to move its cursor there
					// while supplying the bytes from its own outbox. That elision is
					// only sound while the position really is the next one. The
					// authority relays to every other socket before it answers this one
					// and a socket delivers in order, so it is, by construction. This
					// is a check rather than an assumption because the construction can
					// fail: an entry this replica could not apply pins the cursor while
					// the log moves on, and the ack for a submission still in flight
					// then names a position the replica never received through.
					//
					// A position that skipped entries must not be recorded as if it had
					// not. There is no way to take half of what follows: `acknowledge`
					// retires the owed rows and moves the cursor in one write, because
					// the cursor IS `MAX(authoritySeq)` (ADR-0301). So this refuses the
					// whole ack. The rows stay owed, `attach` clears the stale
					// `outstanding`, the reconnect catches up from the real cursor, the
					// submission re-sends, and the authority absorbs one duplicate
					// entry that the next fold reclaims. That is the same recovery a
					// lost ack, a dead socket, and an entry gap already use.
					//
					// `!==` rather than `>`, so a position at or below the cursor is
					// refused too. It reaches here when a snapshot jumped the cursor
					// past this submission while it was in flight. Stamping below
					// `MAX(authoritySeq)` cannot move the cursor, so acting on it was
					// harmless, but "harmless" was a property of the fold's arithmetic
					// rather than of anything stated here.
					if (frame.seq !== cursor + 1) {
						const gap = SyncClientError.Gap({
							expected: cursor + 1,
							received: frame.seq,
						});
						lastError = gap.error;
						needsResync = true;
						return gap;
					}
					cursor = frame.seq;
					// One call for what used to be two. Moving the cursor and
					// retiring the owed appends were the same fact reported twice:
					// these bytes reached the log, at this position.
					engine.acknowledge(outstanding.throughId, frame.seq);
					if (connection !== undefined) connection.outstanding = undefined;
					owed = 0;
					// Work authored while that submission was out is still owed.
					send();
					return Ok(undefined);
				}
				case 'refuse': {
					// Only if it answers the submission actually in flight. The ack
					// path has always checked this and the refusal path did not, so a
					// refusal aimed at a snapshot offer, which carries a position
					// rather than a submission number, was read as a refusal of an
					// unrelated push and cleared it.
					if (
						connection?.outstanding === undefined ||
						frame.submission !== connection.outstanding.submission
					) {
						return Ok(undefined);
					}
					const refused = SyncClientError.Refused({ reason: frame.reason });
					lastError = refused.error;
					// The outbox is NOT cleared. The authority has taken no
					// responsibility for these bytes, so this replica keeps holding
					// them, and a refusal that repeats is visible rather than a write
					// that quietly disappeared.
					connection.outstanding = undefined;
					return refused;
				}
				case 'entry': {
					const { data: whole, error: chunkError } = collector.accept(frame);
					// A reassembly failure is NOT nothing. It means this replica's view
					// of the stream is broken, and returning Ok here left it stalled
					// with no error, no `needsResync`, and every layer reporting
					// success. Recovery is the same reconnect a gap needs.
					if (chunkError !== null) return brokenStream(chunkError.reason);
					if (whole === undefined) return Ok(undefined);
					return apply(frame.seq, whole);
				}
				case 'snapshot': {
					const { data: whole, error: chunkError } = collector.accept(frame);
					if (chunkError !== null) return brokenStream(chunkError.reason);
					if (whole === undefined) return Ok(undefined);
					return adopt(frame.position, whole);
				}
				case 'wanted':
					return offerSnapshot(frame.position);
				case 'admitted':
				case 'retired':
					// The connection driver owns admission and lifetime retirement.
					return Ok(undefined);
				case 'push':
				case 'offer':
					// A client never receives either. Ignored rather than thrown on,
					// because a throw here would be swallowed by the socket runtime.
					return Ok(undefined);
			}
		},

		status: () => ({
			cursor,
			inFlight: connection?.outstanding !== undefined,
			inFlightSubmission: connection?.outstanding?.submission,
			owed,
			lastError,
			unresolvedDependencies: engine.hasUnresolvedDependencies(),
			needsResync,
		}),

		dispose() {
			disposed = true;
			clearIdle();
			connection = undefined;
		},
	});
}
