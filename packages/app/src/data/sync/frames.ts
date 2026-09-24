/**
 * The wire, which is framing and nothing else.
 *
 * Every frame is binary. Nothing here knows what an update means, what a row
 * is, or what Yjs is; a payload is a run of bytes with a position in a
 * submission or in the authority's log. That is deliberate and it is the whole
 * reason chunking is safe to do at this layer: splitting bytes cannot be wrong
 * about semantics it does not have.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * Cloudflare's documented cap on one Durable Object SQLite value.
 *
 * The wall that makes chunking necessary, and it has nothing to do with
 * hydration cost or with Yjs. A WebSocket accepts 32 MiB, so an update between
 * these two numbers is one `workerd` swallows on the way to storage.
 *
 * **The documented number is not the enforced one.** Bisected to the byte in a
 * live Durable Object, the engine stores up to 2,199,994 bytes and refuses
 * 2,199,995 with `SQLITE_TOOBIG` (`evidence/workerd/`). So this constant sits
 * about 102 KB under the wall rather than on it. Chunking here is still the
 * right choice, because the documented limit is the one Cloudflare is entitled
 * to enforce and the headroom also absorbs the row's other columns, but the
 * reason is "a policy with margin", not "the exact edge". A margin nobody
 * measured is how a limit gets quoted for years at the wrong value.
 */
export const DO_SQLITE_VALUE_CAP = 2_097_152;

/**
 * How many payload bytes one chunk carries.
 *
 * Equal to the documented cap. Verified at the boundary rather than at a
 * comfortable 3 MB, because a limit tested with a wide margin tells you the
 * margin and not the limit.
 */
export const CHUNK_BYTES = DO_SQLITE_VALUE_CAP;

export const FrameError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This is not a frame: ${reason}`,
		reason,
	}),
});
export type FrameError = InferErrors<typeof FrameError>;

/** A client offering bytes it authored. The authority assigns the position. */
export type PushFrame = {
	kind: 'push';
	/** Client-scoped and monotonic, so an ack can name what it answers. */
	submission: number;
	chunk: number;
	chunks: number;
	bytes: Uint8Array;
};

/**
 * The authority took responsibility, at this position.
 *
 * The mechanism that makes a refusal visible. `workerd` swallows a throw in
 * `webSocketMessage` without closing the socket, so a client with no ack cannot
 * distinguish "stored" from "vanished", and a client that cannot distinguish
 * them will drop the work either way.
 *
 * **This is an entry frame with the payload elided.** It names a position in
 * the same log an `entry` names, and the replica that receives it moves its
 * cursor there while supplying the bytes from its own outbox, because it
 * authored them and holds them already. The elision is what makes the frame
 * nine bytes instead of the update it stands for.
 *
 * The position is only trustworthy because the hub delivers everything below it
 * to the same socket first, and a socket delivers in order. A replica must
 * therefore verify that the position really is the next one before recording
 * it. That check is not defensive tidiness: a poison entry pins a replica's
 * cursor while the log moves on, so an ack for a submission still in flight can
 * name a position the replica never received through.
 */
export type AckFrame = { kind: 'ack'; submission: number; seq: number };

/** The authority refused, and said so rather than dropping it in silence. */
export type RefuseFrame = {
	kind: 'refuse';
	submission: number;
	reason: string;
};

/** One entry of the authority's log, on its way to a replica. */
export type EntryFrame = {
	kind: 'entry';
	seq: number;
	chunk: number;
	chunks: number;
	bytes: Uint8Array;
};

/**
 * A client offering its whole state as the new snapshot, at the position it
 * has read through.
 *
 * The authority accepts it only when that position is both its own head AND
 * what it has sent this connection, which is a condition it can check with one
 * integer comparison and no understanding of the bytes.
 */
export type OfferFrame = {
	kind: 'offer';
	position: number;
	chunk: number;
	chunks: number;
	bytes: Uint8Array;
};

/**
 * The snapshot, on its way to a replica that is behind it.
 *
 * Carries the position it was taken at, and adopting it moves the replica's
 * cursor there in one jump. That jump is the ONE place the contiguity check is
 * allowed to skip, which is why it is a frame of its own rather than an entry
 * with a flag: a gap that arrives as an ordinary entry still has to be refused.
 */
export type SnapshotFrame = {
	kind: 'snapshot';
	position: number;
	chunk: number;
	chunks: number;
	bytes: Uint8Array;
};

/** The authority asking a current replica to supply a new snapshot. */
export type WantedFrame = { kind: 'wanted'; position: number };

export type Frame =
	| PushFrame
	| AckFrame
	| RefuseFrame
	| EntryFrame
	| OfferFrame
	| SnapshotFrame
	| WantedFrame
	| { kind: 'admitted' }
	| { kind: 'retired' };

const PUSH = 1;
const ACK = 2;
const REFUSE = 3;
const ENTRY = 4;
const OFFER = 5;
const SNAPSHOT = 6;
const WANTED = 7;
// Admission belongs to the authenticated generation in the connection address.
const ADMITTED = 10;
const RETIRED = 11;
// Opcode 8 carried `boundary` for one unreleased build and is retired; a
// decoder treats it as unknown. Do not reuse it.
//
// Opcode 9 carried `document`, the authority naming the history its log
// described, and is retired with the identity itself: the generation is in the
// address now, so there is nothing to announce (ADR-0292). Do not reuse it
// either. A decoder meeting one ignores it, which is what lets a deployment
// roll forward past a peer that has not.

/** `u8 kind` plus three `u32` fields, ahead of the payload. */
const DATA_HEADER_BYTES = 13;

export function encodeFrame(frame: Frame): Uint8Array {
	switch (frame.kind) {
		case 'admitted':
			return new Uint8Array([ADMITTED]);
		case 'retired':
			return new Uint8Array([RETIRED]);
		case 'push':
			return encodeData(
				PUSH,
				frame.submission,
				frame.chunk,
				frame.chunks,
				frame.bytes,
			);
		case 'entry':
			return encodeData(
				ENTRY,
				frame.seq,
				frame.chunk,
				frame.chunks,
				frame.bytes,
			);
		case 'offer':
			return encodeData(
				OFFER,
				frame.position,
				frame.chunk,
				frame.chunks,
				frame.bytes,
			);
		case 'snapshot':
			return encodeData(
				SNAPSHOT,
				frame.position,
				frame.chunk,
				frame.chunks,
				frame.bytes,
			);
		case 'wanted': {
			const buffer = new Uint8Array(5);
			const view = new DataView(buffer.buffer);
			view.setUint8(0, WANTED);
			view.setUint32(1, frame.position);
			return buffer;
		}
		case 'ack': {
			const buffer = new Uint8Array(9);
			const view = new DataView(buffer.buffer);
			view.setUint8(0, ACK);
			view.setUint32(1, frame.submission);
			view.setUint32(5, frame.seq);
			return buffer;
		}
		case 'refuse': {
			const reason = new TextEncoder().encode(frame.reason);
			const buffer = new Uint8Array(5 + reason.length);
			const view = new DataView(buffer.buffer);
			view.setUint8(0, REFUSE);
			view.setUint32(1, frame.submission);
			buffer.set(reason, 5);
			return buffer;
		}
	}
}

function encodeData(
	kind: number,
	position: number,
	chunk: number,
	chunks: number,
	bytes: Uint8Array,
): Uint8Array {
	const buffer = new Uint8Array(DATA_HEADER_BYTES + bytes.length);
	const view = new DataView(buffer.buffer);
	view.setUint8(0, kind);
	view.setUint32(1, position);
	view.setUint32(5, chunk);
	view.setUint32(9, chunks);
	buffer.set(bytes, DATA_HEADER_BYTES);
	return buffer;
}

export function decodeFrame(input: Uint8Array): Result<Frame, FrameError> {
	if (input.length === 0) return FrameError.Malformed({ reason: 'empty' });
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const kind = view.getUint8(0);
	if (kind === ADMITTED || kind === RETIRED) {
		if (input.length !== 1)
			return FrameError.Malformed({
				reason: `admission frame is ${input.length} bytes`,
			});
		return Ok({ kind: kind === ADMITTED ? 'admitted' : 'retired' });
	}

	if (kind === WANTED) {
		if (input.length < 5) {
			return FrameError.Malformed({
				reason: `wanted is ${input.length} bytes`,
			});
		}
		return Ok({ kind: 'wanted', position: view.getUint32(1) });
	}

	if (kind === ACK || kind === REFUSE) {
		if (input.length < 5) {
			return FrameError.Malformed({
				reason: `control frame is ${input.length} bytes`,
			});
		}
		const submission = view.getUint32(1);
		if (kind === REFUSE) {
			return Ok({
				kind: 'refuse',
				submission,
				reason: new TextDecoder().decode(input.subarray(5)),
			});
		}
		if (input.length < 9) {
			return FrameError.Malformed({ reason: `ack is ${input.length} bytes` });
		}
		return Ok({ kind: 'ack', submission, seq: view.getUint32(5) });
	}

	if (kind !== PUSH && kind !== ENTRY && kind !== OFFER && kind !== SNAPSHOT) {
		return FrameError.Malformed({ reason: `unknown kind ${kind}` });
	}
	if (input.length < DATA_HEADER_BYTES) {
		return FrameError.Malformed({
			reason: `data frame is ${input.length} bytes`,
		});
	}
	const position = view.getUint32(1);
	const chunk = view.getUint32(5);
	const chunks = view.getUint32(9);
	if (chunks === 0 || chunk >= chunks) {
		return FrameError.Malformed({ reason: `chunk ${chunk} of ${chunks}` });
	}
	// Copied rather than viewed. A `subarray` keeps the whole received message
	// alive for as long as any chunk of it is buffered, which on the authority
	// is until the last chunk arrives.
	const bytes = input.slice(DATA_HEADER_BYTES);
	switch (kind) {
		case PUSH:
			return Ok({ kind: 'push', submission: position, chunk, chunks, bytes });
		case ENTRY:
			return Ok({ kind: 'entry', seq: position, chunk, chunks, bytes });
		case OFFER:
			return Ok({ kind: 'offer', position, chunk, chunks, bytes });
		default:
			return Ok({ kind: 'snapshot', position, chunk, chunks, bytes });
	}
}

/**
 * Split one update into chunks that each fit the storage cap.
 *
 * Framing, not bounding. An earlier design bounded the coalesce buffer by size
 * instead, which fixed nothing: a single paste is 4.77 MB in ONE transaction,
 * so there is no seam for a coalescing bound to cut at, while a week of fully
 * offline field edits coalesces to 99 KB and never approaches the cap at all.
 *
 * An empty update yields one empty chunk rather than none, so that "how many
 * chunks did you send" and "how many did I receive" always agree.
 */
export function intoChunks(
	bytes: Uint8Array,
	limit = CHUNK_BYTES,
): Uint8Array[] {
	if (bytes.length <= limit) return [bytes];
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += limit) {
		chunks.push(bytes.subarray(at, Math.min(at + limit, bytes.length)));
	}
	return chunks;
}

/** Concatenate chunks back into the update they were cut from. */
export function reassemble(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}

/**
 * Collect the chunks of one submission until it is whole.
 *
 * In memory rather than in storage, and that is the ack doing its job: a
 * partial submission that is lost to eviction is one the client never hears an
 * ack for, so the client still owes it and re-offers it. Storing partials
 * durably would mean the log could hold an entry that is real but truncated,
 * and a truncated entry is the poison pill this design spends a Yjs call to
 * avoid.
 */
export type ChunkCollector = {
	/** Add one chunk. Returns the whole update once the last one lands. */
	accept(
		frame: PushFrame | EntryFrame | OfferFrame | SnapshotFrame,
	): Result<Uint8Array | undefined, FrameError>;
	/** How many bytes are held for submissions that are still incomplete. */
	bufferedBytes(): number;
	forget(position: number): void;
};

export function createChunkCollector({
	limitBytes,
}: {
	/** Refuse to buffer more than this across all in-flight submissions. */
	limitBytes: number;
}): ChunkCollector {
	const partials = new Map<
		number,
		{ chunks: Uint8Array[]; held: number; filled: number }
	>();
	let buffered = 0;

	return {
		accept(frame) {
			const position =
				frame.kind === 'push'
					? frame.submission
					: frame.kind === 'entry'
						? frame.seq
						: frame.position;
			if (frame.chunks === 1) return Ok(frame.bytes);

			const partial = partials.get(position) ?? {
				chunks: new Array<Uint8Array>(frame.chunks),
				held: 0,
				filled: 0,
			};
			if (partial.chunks.length !== frame.chunks) {
				partials.delete(position);
				buffered -= partial.held;
				return FrameError.Malformed({
					reason: `submission ${position} changed from ${partial.chunks.length} chunks to ${frame.chunks}`,
				});
			}
			if (buffered + frame.bytes.length > limitBytes) {
				partials.delete(position);
				buffered -= partial.held;
				return FrameError.Malformed({
					reason: `buffering ${buffered + frame.bytes.length} bytes exceeds ${limitBytes}`,
				});
			}
			// Counted rather than probed with `every`, which SKIPS the holes of a
			// sparse array and so reports a submission complete on its first chunk.
			// A re-sent chunk replaces its slot without counting twice.
			const previous = partial.chunks[frame.chunk];
			if (previous === undefined) {
				partial.filled += 1;
			} else {
				partial.held -= previous.length;
				buffered -= previous.length;
			}
			partial.chunks[frame.chunk] = frame.bytes;
			partial.held += frame.bytes.length;
			buffered += frame.bytes.length;
			partials.set(position, partial);

			if (partial.filled < frame.chunks) return Ok(undefined);
			partials.delete(position);
			buffered -= partial.held;
			return Ok(reassemble(partial.chunks));
		},
		bufferedBytes: () => buffered,
		forget(position) {
			const partial = partials.get(position);
			if (partial === undefined) return;
			buffered -= partial.held;
			partials.delete(position);
		},
	};
}
