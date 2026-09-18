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
 * A hub holds one fixed log capability for its entire lifetime. A current
 * authority binds that capability to a generation and retires the hub after
 * replacement. Durable checks protect reads and writes; the hub also fences
 * frames already materialized before a synchronous send callback retires it.
 */

import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';

import { AuthorityError, type SyncAuthority } from './authority.js';
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

/** Retirement is permanent; storage unavailability is retryable. */
export type Admission = 'admitted' | 'retired' | 'unavailable';

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
	/** End this lifetime, including queued replies and partial submissions. */
	retire(): void;
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
const log = createLogger('sync-hub');

export function createSyncHub({
	authority,
	/** Entries per read. Bounds one catch-up read, not the catch-up itself. */
	batch = 64,
}: {
	authority: SyncAuthority;
	batch?: number;
}): SyncHub {
	let lifetime:
		| {
				connections: Map<HubConnection, ChunkCollector>;
				pending: { connection: HubConnection; message: Uint8Array }[];
		  }
		| undefined = { connections: new Map(), pending: [] };
	// Synchronous replies wait until the current delivery and cursor complete.
	let dispatchDepth = 0;

	function notifyRetired(connection: HubConnection): void {
		try {
			connection.send(encodeFrame({ kind: 'retired' }));
		} catch (cause) {
			log.debug('A retired connection could not be notified.', cause);
		}
	}

	function retire(): void {
		const retired = lifetime;
		lifetime = undefined;
		// End membership before callbacks can send queued work or join again.
		for (const connection of retired?.connections.keys() ?? [])
			notifyRetired(connection);
	}

	function admission(): Result<void, AuthorityError> {
		if (lifetime === undefined) {
			return AuthorityError.StorageFailed({ cause: 'Hub lifetime retired' });
		}
		const result = authority.admission();
		if (
			result.error?.name === 'GenerationUnavailable' &&
			result.error.current !== undefined &&
			result.error.current > result.error.generation
		)
			retire();
		return result;
	}

	function send(
		connection: HubConnection,
		bytes: Uint8Array,
	): Result<void, AuthorityError> {
		const admitted = admission();
		if (admitted.error !== null) return admitted;
		connection.send(bytes);
		// A synchronous peer can activate a replacement inside send().
		return admission();
	}

	/** A refusal carries no history and must remain sendable when storage fails. */
	function refuse(
		connection: HubConnection,
		submission: number,
		reason: string,
	): void {
		const collector = lifetime?.connections.get(connection);
		if (collector === undefined) return;
		collector.forget(submission);
		connection.send(encodeFrame({ kind: 'refuse', submission, reason }));
	}

	function drain(): void {
		if (dispatchDepth !== 0) return;
		dispatchDepth += 1;
		try {
			for (
				let next = lifetime?.pending.shift();
				next !== undefined;
				next = lifetime?.pending.shift()
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
			const sent = send(
				connection,
				encodeFrame({
					kind: 'snapshot',
					position: snapshot.position,
					chunk: index,
					chunks: chunks.length,
					bytes: chunk,
				}),
			);
			if (sent.error !== null) return sent;
		}
		connection.cursor = snapshot.position;
		return Ok(undefined);
	}

	/** Send everything after this connection's cursor, up to `ceiling`. */
	function deliver(
		connection: HubConnection,
		ceiling?: number,
	): Result<void, AuthorityError> {
		const admitted = admission();
		if (admitted.error !== null) return admitted;
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
					const sent = send(
						connection,
						encodeFrame({
							kind: 'entry',
							seq: entry.seq,
							chunk: index,
							chunks: chunks.length,
							bytes: chunk,
						}),
					);
					if (sent.error !== null) return sent;
				}
				connection.cursor = entry.seq;
			}
			if (entries.length < batch) return Ok(undefined);
		}
	}

	return Object.freeze({
		join(connection): Admission {
			if (admission().error !== null) {
				if (lifetime === undefined) {
					notifyRetired(connection);
					return 'retired';
				}
				return 'unavailable';
			}
			const active = lifetime!;
			let caughtUp = false;
			dispatchDepth += 1;
			try {
				active.connections.set(
					connection,
					createChunkCollector({ limitBytes: BUFFER_CEILING_BYTES }),
				);
				caughtUp =
					send(connection, encodeFrame({ kind: 'admitted' })).error === null &&
					deliver(connection).error === null;
				if (!caughtUp) active.connections.delete(connection);
			} finally {
				dispatchDepth -= 1;
				drain();
			}
			if (lifetime === undefined) return 'retired';
			return caughtUp ? 'admitted' : 'unavailable';
		},

		leave(connection) {
			lifetime?.connections.delete(connection);
		},

		attached: () => lifetime?.connections.size ?? 0,
		retire,

		receive(connection, message) {
			lifetime?.pending.push({ connection, message: new Uint8Array(message) });
			drain();
		},
	});

	function process(connection: HubConnection, message: Uint8Array): void {
		const collector = lifetime?.connections.get(connection);
		if (collector === undefined) return;

		const { data: frame, error } = decodeFrame(message);
		if (error !== null) return;
		const admitted = admission();
		if (admitted.error !== null) {
			if (frame.kind === 'push')
				refuse(connection, frame.submission, admitted.error.message);
			return;
		}
		if (frame.kind === 'offer') return takeOffer(connection, collector, frame);
		if (frame.kind !== 'push') return;

		// The only refusal about CONTENT that survives, and it is about framing
		// rather than about meaning: a submission that changes its chunk count
		// mid-flight, or one that would push the buffered partials past the
		// limit. The authority itself never reads the bytes, so "these are not a
		// valid update" is not a thing anything here can say.
		const { data: whole, error: chunkError } = collector.accept(frame);
		if (chunkError !== null) {
			refuse(connection, frame.submission, chunkError.reason);
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
			refuse(connection, frame.submission, appendError.message);
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
			refuse(connection, frame.submission, deliveryError.message);
			return;
		}
		connection.cursor = seq;
		send(
			connection,
			encodeFrame({ kind: 'ack', submission: frame.submission, seq }),
		);

		for (const other of lifetime?.connections.keys() ?? []) {
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
		send(connection, encodeFrame({ kind: 'wanted', position: head }));
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
