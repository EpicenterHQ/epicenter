import type { PortableArtifactRecord } from '@epicenter/data/portable';
import type { RecordAddress } from '@epicenter/data/protocol/v1';

export const PORTABLE_RECORD_STREAM_PAGE_LIMIT = 16;
export const PORTABLE_RECORD_STREAM_FRAME_BYTES = 32 * 1024 * 1024;

const BASE64 =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type PortableMaterializerWireRecord = Omit<
	PortableArtifactRecord,
	'documentUpdateV2'
> & {
	documentUpdateV2Base64: string | null;
};

export type PortableMaterializerRecordFrame = {
	records: PortableMaterializerWireRecord[];
};

function bytesToBase64(bytes: Uint8Array): string {
	let encoded = '';
	for (let offset = 0; offset < bytes.byteLength; offset += 3) {
		const first = bytes[offset] ?? 0;
		const second = bytes[offset + 1];
		const third = bytes[offset + 2];
		encoded += BASE64[first >> 2];
		encoded += BASE64[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
		encoded +=
			second === undefined
				? '='
				: BASE64[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
		encoded += third === undefined ? '=' : BASE64[third & 0x3f];
	}
	return encoded;
}

function base64Value(character: string): number {
	const value = BASE64.indexOf(character);
	if (value === -1)
		throw new Error('portable record frame contains malformed base64');
	return value;
}

function base64ToBytes(value: string): Uint8Array {
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
			value,
		)
	) {
		throw new Error('portable record frame contains malformed base64');
	}
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	const bytes = new Uint8Array((value.length / 4) * 3 - padding);
	let output = 0;
	for (let offset = 0; offset < value.length; offset += 4) {
		const first = base64Value(value[offset] ?? '');
		const second = base64Value(value[offset + 1] ?? '');
		const third =
			value[offset + 2] === '=' ? 0 : base64Value(value[offset + 2] ?? '');
		const fourth =
			value[offset + 3] === '=' ? 0 : base64Value(value[offset + 3] ?? '');
		const packed = (first << 18) | (second << 12) | (third << 6) | fourth;
		if (output < bytes.byteLength) bytes[output++] = packed >> 16;
		if (output < bytes.byteLength) bytes[output++] = packed >> 8;
		if (output < bytes.byteLength) bytes[output++] = packed;
	}
	if (bytesToBase64(bytes) !== value) {
		throw new Error('portable record frame contains non-canonical base64');
	}
	return bytes;
}

function toWireRecord(
	record: PortableArtifactRecord,
): PortableMaterializerWireRecord {
	return {
		address: record.address,
		scalar: record.scalar,
		documentUpdateV2Base64:
			record.documentUpdateV2 === null
				? null
				: bytesToBase64(record.documentUpdateV2),
		blobSha256: record.blobSha256,
	};
}

function fromWireRecord(value: unknown): PortableArtifactRecord {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('portable record frame is not recognized');
	}
	const candidate = value as Partial<PortableMaterializerWireRecord>;
	const keys = Object.keys(value).sort();
	if (keys.join(',') !== 'address,blobSha256,documentUpdateV2Base64,scalar') {
		throw new Error('portable record frame is not recognized');
	}
	if (
		candidate.documentUpdateV2Base64 !== null &&
		typeof candidate.documentUpdateV2Base64 !== 'string'
	) {
		throw new Error('portable record frame is not recognized');
	}
	return {
		address: candidate.address as RecordAddress,
		scalar: candidate.scalar as PortableArtifactRecord['scalar'],
		documentUpdateV2:
			candidate.documentUpdateV2Base64 === null
				? null
				: base64ToBytes(candidate.documentUpdateV2Base64),
		blobSha256: candidate.blobSha256 as string | null,
	};
}

/** Decode and validate one newline-delimited internal record page. */
export function decodePortableMaterializerRecordFrame(
	line: string,
): PortableArtifactRecord[] {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error('portable record frame is not valid JSON');
	}
	if (
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).join(',') !== 'records' ||
		!Array.isArray(
			(value as Partial<PortableMaterializerRecordFrame>).records,
		) ||
		(value as PortableMaterializerRecordFrame).records.length === 0 ||
		(value as PortableMaterializerRecordFrame).records.length >
			PORTABLE_RECORD_STREAM_PAGE_LIMIT
	) {
		throw new Error('portable record frame must contain 1..16 records');
	}
	return (value as PortableMaterializerRecordFrame).records.map(fromWireRecord);
}

/** Encode one bounded internal record page, including its newline delimiter. */
export function encodePortableMaterializerRecordFrame(
	records: readonly PortableArtifactRecord[],
): Uint8Array {
	if (
		records.length === 0 ||
		records.length > PORTABLE_RECORD_STREAM_PAGE_LIMIT
	) {
		throw new RangeError('portable record frame must contain 1..16 records');
	}
	const frame = encoder.encode(
		`${JSON.stringify({ records: records.map(toWireRecord) })}\n`,
	);
	if (frame.byteLength > PORTABLE_RECORD_STREAM_FRAME_BYTES) {
		throw new RangeError('portable record frame exceeds its byte bound');
	}
	return frame;
}

function join(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
	const joined = new Uint8Array(byteLength);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}

/** Decode newline-delimited pages independently of transport chunk boundaries. */
export async function* decodePortableMaterializerRecordStream(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<PortableArtifactRecord[]> {
	const reader = stream.getReader();
	let parts: Uint8Array[] = [];
	let frameBytes = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			let start = 0;
			for (;;) {
				const newline = result.value.indexOf(0x0a, start);
				const end = newline === -1 ? result.value.byteLength : newline;
				const part = result.value.slice(start, end);
				frameBytes += part.byteLength;
				if (frameBytes > PORTABLE_RECORD_STREAM_FRAME_BYTES) {
					throw new Error('portable record frame exceeds its byte bound');
				}
				if (part.byteLength !== 0) parts.push(part);
				if (newline === -1) break;
				if (frameBytes === 0) {
					throw new Error('portable record stream has an empty frame');
				}
				yield decodePortableMaterializerRecordFrame(
					decoder.decode(join(parts, frameBytes)),
				);
				parts = [];
				frameBytes = 0;
				start = newline + 1;
			}
		}
		if (frameBytes !== 0) {
			throw new Error('portable record stream has an unterminated frame');
		}
	} finally {
		reader.releaseLock();
	}
}
