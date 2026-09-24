/**
 * One frozen authority capture over HTTP. The body keeps updates opaque and in
 * log order; the receiving application validates their meaning before opening.
 */
import {
	CURRENT_GENERATION_HEADER,
	LOG_POSITION_HEADER,
} from './generations-route.js';

type CurrentDownload = {
	generation: number;
	head: number;
	snapshot: { position: number; bytes: Uint8Array };
	tail: readonly { seq: number; bytes: Uint8Array }[];
};

const CONTENT_TYPE = 'application/vnd.epicenter.current.v1';
// "ECUR", version 1, then an f64 snapshot position and u32-length-prefixed updates.
// Positions use f64 to preserve every positive safe integer supported by SQL.
const MAGIC = new Uint8Array([69, 67, 85, 82, 1]);
const HEADER_BYTES = MAGIC.length + 8;

function positiveInteger(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(
			'Current download requires positive safe integer positions',
		);
}

/** Serve the snapshot and every accepted update through this capture's head. */
export function createCurrentDownloadResponse(
	capture: CurrentDownload,
): Response {
	positiveInteger(capture.generation);
	positiveInteger(capture.head);
	positiveInteger(capture.snapshot.position);
	if (capture.head - capture.snapshot.position !== capture.tail.length)
		throw new Error('Current download does not cover its captured head');
	const updates = [capture.snapshot.bytes];
	for (const [index, entry] of capture.tail.entries()) {
		if (entry.seq !== capture.snapshot.position + index + 1)
			throw new Error('Current download contains a log gap');
		updates.push(entry.bytes);
	}
	let length = HEADER_BYTES;
	for (const bytes of updates) {
		if (bytes.byteLength === 0 || bytes.byteLength > 0xffff_ffff)
			throw new Error('Current download contains an invalid update length');
		length += 4 + bytes.byteLength;
	}
	const body = new Uint8Array(length);
	body.set(MAGIC);
	const view = new DataView(body.buffer);
	view.setFloat64(MAGIC.length, capture.snapshot.position);
	let offset = HEADER_BYTES;
	for (const bytes of updates) {
		view.setUint32(offset, bytes.byteLength);
		offset += 4;
		body.set(bytes, offset);
		offset += bytes.byteLength;
	}
	return new Response(body, {
		headers: {
			'content-type': CONTENT_TYPE,
			'cache-control': 'no-store',
			'access-control-expose-headers': `${CURRENT_GENERATION_HEADER}, ${LOG_POSITION_HEADER}`,
			[CURRENT_GENERATION_HEADER]: String(capture.generation),
			[LOG_POSITION_HEADER]: String(capture.head),
		},
	});
}

/** Refuse incomplete, malformed, or historical snapshot-only responses. */
export async function readCurrentDownload(
	response: Response,
): Promise<CurrentDownload> {
	if (!response.ok)
		throw new Error(`Current data download returned ${response.status}`);
	if (response.headers.get('content-type') !== CONTENT_TYPE)
		throw new Error('Current data download has an unsupported content type');
	function header(name: string) {
		const text = response.headers.get(name);
		if (!text || !/^[1-9][0-9]*$/.test(text))
			throw new Error(`Current data download has an invalid ${name} header`);
		const value = Number(text);
		positiveInteger(value);
		return value;
	}
	const generation = header(CURRENT_GENERATION_HEADER);
	const head = header(LOG_POSITION_HEADER);
	const body = new Uint8Array(await response.arrayBuffer());
	if (
		body.byteLength < HEADER_BYTES ||
		MAGIC.some((byte, index) => body[index] !== byte)
	)
		throw new Error('Current data download has an invalid format');
	const view = new DataView(body.buffer);
	const position = view.getFloat64(MAGIC.length);
	positiveInteger(position);
	if (position > head)
		throw new Error('Current data download starts beyond its captured head');
	let offset = HEADER_BYTES;
	function update() {
		if (offset + 4 > body.byteLength)
			throw new Error('Current data download is truncated');
		const length = view.getUint32(offset);
		offset += 4;
		if (length === 0 || offset + length > body.byteLength)
			throw new Error('Current data download has an incomplete update');
		const bytes = body.subarray(offset, offset + length);
		offset += length;
		return bytes;
	}
	const snapshot = { position, bytes: update() };
	const tail = [];
	for (let seq = position + 1; seq <= head; seq++)
		tail.push({ seq, bytes: update() });
	if (offset !== body.byteLength)
		throw new Error('Current data download extends beyond its captured head');
	return { generation, head, snapshot, tail };
}
