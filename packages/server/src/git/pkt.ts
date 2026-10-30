/**
 * Git's pkt-line framing (`gitprotocol-common`): four hex digits of length
 * (the four included), then the payload; `0000` is a flush.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FLUSH = encoder.encode('0000');

/** One pkt-line holding `payload`. */
export function pktLine(payload: string | Uint8Array): Uint8Array {
	const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
	const out = new Uint8Array(bytes.length + 4);
	out.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, '0')));
	out.set(bytes, 4);
	return out;
}

/**
 * The pkt-lines before the first flush, as text, and the bytes after it
 * (a push's pack). A body with no flush yields every line and no rest.
 */
export function readCommandLines(body: Uint8Array): {
	lines: string[];
	rest: Uint8Array;
} {
	const lines: string[] = [];
	let at = 0;
	while (at + 4 <= body.length) {
		const length = Number.parseInt(
			decoder.decode(body.subarray(at, at + 4)),
			16,
		);
		if (!Number.isInteger(length) || (length > 0 && length < 4))
			throw new Error(`malformed pkt-line at byte ${at}`);
		if (length === 0) return { lines, rest: body.subarray(at + 4) };
		if (at + length > body.length)
			throw new Error(`truncated pkt-line at byte ${at}`);
		lines.push(decoder.decode(body.subarray(at + 4, at + length)));
		at += length;
	}
	return { lines, rest: body.subarray(at) };
}
