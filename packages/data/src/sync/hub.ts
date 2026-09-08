/**
 * Who is connected, and what each of them has been sent.
 *
 * The whole of the authority's connection behaviour, with no runtime in it. A
 * Durable Object is a thirty-line adapter over this, and the tests drive the
 * same object through a pair of in-process sockets, so what is tested and what
 * is deployed are the same code rather than two things that agree today.
 *
 * ## Catch-up and live relay are one path
 *
 * There is one verb, `deliver`, and it means "everything after your cursor".
 * A device returning from a week offline and a device being handed the update
 * someone typed a moment ago run the same loop with different starting numbers.
 * A second path for the live case is where a transport grows a rule that is
 * true only when it is warm.
 *
 * The log describes exactly one generation of one database, and the address
 * says which (ADR-0292). That is what deleted admission: a replica reaching
 * this hub was addressed at this generation, a generation is created once and
 * never mutated in place, so there is no history it could be holding bytes
 * from and nothing to compare. The document announcement, the bootstrap
 * round-trip, and the retirement arm all went with the question.
 */

import { Err, Ok, type Result } from 'wellcrafted/result';

import type { AuthorityError, SyncAuthority } from './authority.js';
import {
	CHUNK_BYTES,
	type ChunkCollector,
	createChunkCollector,
	decodeFrame,
	encodeFrame,
	intoChunks,
	type OfferFrame,
} from './frames.js';

/**
 * One attached replica, from the hub's point of view.
 *
 * `cursor` is how far this connection has been SENT, which the hub owns and
 * moves. It is not the replica's own durable cursor: the replica moves that one
 * only after bytes commit, so the two differ for exactly as long as a message
 * is in flight, and it is the replica's that survives a crash.
 */
export type HubConnection = {
	send(bytes: Uint8Array): void;
	cursor: number;
};

/**
 * What admission decided (ADR-0292).
 *
 * Two answers, and it used to be four. `bootstrap`, `retired`, and the whole
 * document-announcement handshake existed to answer one question: is this
 * replica's state part of the history this log describes? The generation is in
 * the address now, so a replica addressed here can only be holding this
 * generation's bytes, and the question has no way to be asked wrongly.
 *
 * `admitted` is membership: catch-up ran and the connection now receives
 * relays and may push. `unavailable` is storage trouble reading the log: fail
 * closed, no membership, and the caller closes, because a connection seated
 * without catch-up would receive relays it has no baseline for.
 */
export type Admission = 'admitted' | 'unavailable';

export type SyncHub = {
	/**
	 * A replica attached at its cursor: the one door.
	 *
	 * Catch-up must succeed for membership to survive. Synchronous answers wait
	 * until catch-up finishes; failed admission removes membership before those
	 * answers run. An unregistered connection's pushes land nowhere.
	 */
	join(connection: HubConnection): Admission;
	/** Bytes arrived from a replica. */
	receive(connection: HubConnection, message: Uint8Array): void;
	leave(connection: HubConnection): void;
	attached(): number;
};

/**
 * The ceiling on chunks held for a submission that is still incomplete.
 *
 * Reassembly is in memory, so a peer that opens a submission and never
 * finishes it is asking the other side to hold bytes indefinitely. Past this
 * the partial is dropped and the peer is refused, which it can act on because
 * it still owes the work.
 *
 * A constant rather than an option, for the reason `client.ts` states at its
 * own copy: no caller ever passed one.
 */
const BUFFER_CEILING_BYTES = 64 * 1024 * 1024;

export function createSyncHub({
	authority,
	/** Entries per read. Bounds one catch-up read, not the catch-up itself. */
	batch = 64,
}: {
	authority: SyncAuthority;
	batch?: number;
}): SyncHub {
	const connections = new Map<HubConnection, ChunkCollector>();
	// A synchronous peer may answer inside send(). Finish the current delivery
	// before processing its answer, including every chunk and the cursor write.
	const pending: { connection: HubConnection; message: Uint8Array }[] = [];
	let dispatchDepth = 0;

	function drain(): void {
		if (dispatchDepth !== 0) return;
		dispatchDepth += 1;
		try {
			for (
				let next = pending.shift();
				next !== undefined;
				next = pending.shift()
			) {
				process(next.connection, next.message);
			}
		} finally {
			dispatchDepth -= 1;
		}
	}

	/**
	 * Bring a connection up to the snapshot if it is behind one.
	 *
	 * The snapshot covers everything at or before its position, so a replica
	 * behind it can never be served from the tail: those entries are gone. It
	 * adopts the snapshot instead and its cursor jumps there in one step.
	 *
	 * Adopting is a MERGE, not a replacement. The snapshot preserves struct
	 * identities, so a replica arriving with unsent offline work keeps it and
	 * pushes it afterwards like any other local write.
	 */
	function catchUpToSnapshot(
		connection: HubConnection,
	): Result<void, AuthorityError> {
		const { data: snapshot, error } = authority.snapshot();
		if (error !== null) return Err(error);
		if (snapshot === undefined || connection.cursor >= snapshot.position)
			return Ok(undefined);
		const chunks = intoChunks(snapshot.bytes, CHUNK_BYTES);
		for (const [index, chunk] of chunks.entries()) {
			connection.send(
				encodeFrame({
					kind: 'snapshot',
					position: snapshot.position,
					chunk: index,
					chunks: chunks.length,
					bytes: chunk,
				}),
			);
		}
		connection.cursor = snapshot.position;
		return Ok(undefined);
	}

	/** Send everything after this connection's cursor, up to `ceiling`. */
	function deliver(
		connection: HubConnection,
		ceiling?: number,
	): Result<void, AuthorityError> {
		const caughtUp = catchUpToSnapshot(connection);
		if (caughtUp.error !== null) return caughtUp;
		for (;;) {
			const { data: entries, error } = authority.since(
				connection.cursor,
				batch,
			);
			if (error !== null) return Err(error);
			if (entries.length === 0) return Ok(undefined);
			for (const entry of entries) {
				if (ceiling !== undefined && entry.seq > ceiling) return Ok(undefined);
				const chunks = intoChunks(entry.bytes, CHUNK_BYTES);
				for (const [index, chunk] of chunks.entries()) {
					connection.send(
						encodeFrame({
							kind: 'entry',
							seq: entry.seq,
							chunk: index,
							chunks: chunks.length,
							bytes: chunk,
						}),
					);
				}
				connection.cursor = entry.seq;
			}
			if (entries.length < batch) return Ok(undefined);
		}
	}

	return Object.freeze({
		join(connection): Admission {
			dispatchDepth += 1;
			try {
				connections.set(
					connection,
					createChunkCollector({ limitBytes: BUFFER_CEILING_BYTES }),
				);
				if (deliver(connection).error !== null) {
					connections.delete(connection);
					return 'unavailable';
				}
				return 'admitted';
			} finally {
				dispatchDepth -= 1;
				drain();
			}
		},

		leave(connection) {
			connections.delete(connection);
		},

		attached: () => connections.size,

		receive(connection, message) {
			pending.push({ connection, message: new Uint8Array(message) });
			drain();
		},
	});

	function process(connection: HubConnection, message: Uint8Array): void {
		const collector = connections.get(connection);
		if (collector === undefined) return;

		const { data: frame, error } = decodeFrame(message);
		if (error !== null) return;
		if (frame.kind === 'offer') return takeOffer(connection, collector, frame);
		if (frame.kind !== 'push') return;

		// The only refusal about CONTENT that survives, and it is about framing
		// rather than about meaning: a submission that changes its chunk count
		// mid-flight, or one that would push the buffered partials past the
		// limit. The authority itself never reads the bytes, so "these are not a
		// valid update" is not a thing anything here can say.
		const { data: whole, error: chunkError } = collector.accept(frame);
		if (chunkError !== null) {
			connection.send(
				encodeFrame({
					kind: 'refuse',
					submission: frame.submission,
					reason: chunkError.reason,
				}),
			);
			return;
		}
		if (whole === undefined) return;

		const { data: seq, error: appendError } = authority.append(whole);
		if (appendError !== null) {
			// Storage failed, and it is said out loud on the socket naming the
			// submission. A throw here would be swallowed by `workerd` without
			// closing the socket, and the client would hold the work forever
			// believing it was in transit. That is the entire reason a refusal is
			// a frame, and it stays true for a failure the server did not choose.
			connection.send(
				encodeFrame({
					kind: 'refuse',
					submission: frame.submission,
					reason: appendError.message,
				}),
			);
			return;
		}

		// Anything this connection has not been sent yet goes out BEFORE its
		// ack, so an ack is always exactly one past what the replica holds. The
		// replica checks that, and a check that can be met by construction is
		// worth arranging rather than asserting and hoping.
		const { error: deliveryError } = deliver(connection, seq - 1);
		if (deliveryError !== null) {
			// The append is durable, but eliding its bytes would certify a gap.
			// Keep the submission owed; a retry may safely append it again.
			connection.send(
				encodeFrame({
					kind: 'refuse',
					submission: frame.submission,
					reason: deliveryError.message,
				}),
			);
			return;
		}
		connection.cursor = seq;
		connection.send(
			encodeFrame({ kind: 'ack', submission: frame.submission, seq }),
		);

		for (const other of connections.keys()) {
			if (other !== connection) deliver(other);
		}
		askForSnapshot(connection);
		return;
	}

	/**
	 * Ask a connection for a snapshot, when it is the one that can give one.
	 *
	 * Only a connection at the head qualifies, so the request goes to a replica
	 * that will pass the accept condition rather than to one that will be
	 * refused. Asking is all the authority does; it cannot produce a snapshot
	 * itself without understanding the bytes, which is the point.
	 */
	function askForSnapshot(connection: HubConnection): void {
		const { data: wanted, error } = authority.shouldSnapshot();
		if (error !== null || !wanted) return;
		const { data: head, error: headError } = authority.head();
		if (headError !== null || head === 0) return;
		if (connection.cursor !== head) return;
		connection.send(encodeFrame({ kind: 'wanted', position: head }));
	}

	function takeOffer(
		connection: HubConnection,
		collector: ChunkCollector,
		frame: OfferFrame,
	): void {
		const { data: whole, error } = collector.accept(frame);
		if (error !== null || whole === undefined) return;

		// The half of the accept condition only the hub can check, and the half
		// that separates this from the client-posted baseline an earlier design
		// died on. `connection.cursor` is the authority's OWN record of what it
		// has sent this socket, not a claim the replica makes about itself.
		//
		// `>=` rather than `===`, because entries keep arriving: a replica asked
		// for a snapshot at 815 may have been sent 816 by the time its offer
		// lands, and its snapshot still accounts for everything through 815,
		// which is all it is used for. Requiring equality refused good snapshots
		// under ordinary traffic.
		if (connection.cursor < frame.position) return;

		// Snapshot maintenance is best effort. A position is not a submission ID,
		// so a rejected offer must never emit a push refusal. The hub asks again
		// while the tail remains large enough to replace.
		authority.replaceSnapshot(frame.position, whole);
	}
}
