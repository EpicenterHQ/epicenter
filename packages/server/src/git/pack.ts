/**
 * Git packfiles (version 2), written for the translator's commits and read
 * for the receiver's checks.
 *
 * Reading inflates each entry with `node:zlib`, whose `info` result reports
 * how many input bytes the entry's stream used; a pack gives no compressed
 * lengths, and `DecompressionStream` refuses the bytes that follow a stream.
 * Both delta kinds resolve: `ofs-delta`, which the receiver advertises, and
 * a `ref-delta` whose base is in the same pack. A thin pack (a delta against
 * an object the server holds) is refused: the receiver advertises `no-thin`.
 *
 * What a pack inflates to is capped (`MAX_INFLATED_BYTES`): every entry's
 * inflated bytes and every delta's result count against one budget, each
 * checked before it is inflated or allocated, so a small pack that declares
 * gigabytes of zeros is refused rather than read.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { type ObjectKind, objectId, type PackObject } from './objects.js';

const KIND_CODE: Record<ObjectKind, number> = {
	commit: 1,
	tree: 2,
	blob: 3,
	tag: 4,
};
const CODE_KIND: Record<number, ObjectKind> = {
	1: 'commit',
	2: 'tree',
	3: 'blob',
	4: 'tag',
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

/**
 * The most a pushed pack may inflate to, entries and delta results
 * together. A push is at most 64 MiB compressed (`MAX_PUSH_BYTES`); notes
 * compress about fourfold, so this admits any honest push of that size.
 */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;

function entryHeader(code: number, size: number): Uint8Array {
	const out = [(code << 4) | (size & 15)];
	let rest = Math.floor(size / 16);
	while (rest > 0) {
		out[out.length - 1] = (out[out.length - 1] as number) | 128;
		out.push(rest & 127);
		rest = Math.floor(rest / 128);
	}
	return Uint8Array.from(out);
}

/** A pack holding `objects`, undeltified. */
export function writePack(objects: readonly PackObject[]): Uint8Array {
	const head = Buffer.alloc(12);
	head.write('PACK', 0, 'ascii');
	head.writeUInt32BE(2, 4);
	head.writeUInt32BE(objects.length, 8);
	const parts: Uint8Array[] = [head];
	for (const o of objects)
		parts.push(
			entryHeader(KIND_CODE[o.kind], o.bytes.length),
			deflateSync(o.bytes),
		);
	const content = Buffer.concat(parts);
	return Buffer.concat([content, createHash('sha1').update(content).digest()]);
}

/** How many objects a pack says it holds; 0 for no pack. */
export function packCount(pack: Uint8Array): number {
	if (pack.length < 12) return 0;
	return Buffer.from(
		pack.buffer,
		pack.byteOffset,
		pack.byteLength,
	).readUInt32BE(8);
}

function applyDelta(
	base: Uint8Array,
	delta: Uint8Array,
	spend: (bytes: number) => void,
): Uint8Array {
	let at = 0;
	const varint = () => {
		let value = 0;
		let shift = 1;
		let byte: number;
		do {
			byte = delta[at++] as number;
			value += (byte & 127) * shift;
			shift *= 128;
		} while (byte & 128);
		return value;
	};
	if (varint() !== base.length) throw new Error('delta base size mismatch');
	const size = varint();
	spend(size);
	const out = new Uint8Array(size);
	let written = 0;
	while (at < delta.length) {
		const op = delta[at++] as number;
		if (op & 128) {
			let offset = 0;
			let length = 0;
			for (let i = 0; i < 4; i++)
				if (op & (1 << i)) offset += (delta[at++] as number) * 2 ** (8 * i);
			for (let i = 0; i < 3; i++)
				if (op & (16 << i)) length += (delta[at++] as number) * 2 ** (8 * i);
			if (length === 0) length = 0x10000;
			if (offset + length > base.length || written + length > out.length)
				throw new Error('delta copy out of range');
			out.set(base.subarray(offset, offset + length), written);
			written += length;
		} else if (op) {
			if (written + op > out.length)
				throw new Error('delta insert out of range');
			out.set(delta.subarray(at, at + op), written);
			written += op;
			at += op;
		} else throw new Error('delta opcode 0');
	}
	if (written !== out.length) throw new Error('delta result size mismatch');
	return out;
}

type Entry = {
	offset: number;
	code: number;
	data: Uint8Array;
	baseOffset?: number;
	baseOid?: string;
	resolved?: PackObject;
};

/**
 * Every object in `pack`, by id. An empty input is an empty pack. Throws
 * when the pack is malformed, or inflates past `maxBytes`.
 */
export function readPack(
	pack: Uint8Array,
	{ maxBytes = MAX_INFLATED_BYTES }: { maxBytes?: number } = {},
): Map<string, PackObject> {
	const objects = new Map<string, PackObject>();
	if (pack.length === 0) return objects;
	let left = maxBytes;
	const tooLarge = () =>
		new Error(
			`its objects inflate past ${mib(maxBytes)}; push fewer changes at once`,
		);
	const spend = (bytes: number) => {
		if (bytes > left) throw tooLarge();
		left -= bytes;
	};
	const buf = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
	if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK')
		throw new Error('not a pack');
	const version = buf.readUInt32BE(4);
	if (version !== 2 && version !== 3)
		throw new Error(`pack version ${version}`);
	const trailer = buf.subarray(buf.length - 20);
	if (
		!createHash('sha1')
			.update(buf.subarray(0, buf.length - 20))
			.digest()
			.equals(trailer)
	)
		throw new Error('pack checksum mismatch');
	const count = buf.readUInt32BE(8);
	const end = buf.length - 20;
	const entries: Entry[] = [];
	const byOffset = new Map<number, Entry>();
	let at = 12;
	for (let i = 0; i < count; i++) {
		if (at >= end) throw new Error('pack ends early');
		const offset = at;
		let byte = buf[at++] as number;
		const code = (byte >> 4) & 7;
		let size = byte & 15;
		let shift = 16;
		while (byte & 128) {
			byte = buf[at++] as number;
			size += (byte & 127) * shift;
			shift *= 128;
		}
		const entry: Entry = { offset, code, data: new Uint8Array() };
		if (code === OFS_DELTA) {
			byte = buf[at++] as number;
			let back = byte & 127;
			while (byte & 128) {
				byte = buf[at++] as number;
				back = (back + 1) * 128 + (byte & 127);
			}
			entry.baseOffset = offset - back;
		} else if (code === REF_DELTA) {
			entry.baseOid = buf.toString('hex', at, at + 20);
			at += 20;
		} else if (CODE_KIND[code] === undefined)
			throw new Error(`unknown pack entry type ${code}`);
		// The declared size is checked first; the inflation is capped too, in case the header understates it.
		if (size > left) throw tooLarge();
		let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
		try {
			inflated = inflateSync(buf.subarray(at, end), {
				info: true,
				maxOutputLength: Math.max(1, left),
			}) as unknown as typeof inflated;
		} catch (cause) {
			if (cause instanceof RangeError) throw tooLarge();
			throw cause;
		}
		if (inflated.buffer.length !== size)
			throw new Error('pack entry size mismatch');
		spend(size);
		entry.data = inflated.buffer;
		at += inflated.engine.bytesWritten;
		entries.push(entry);
		byOffset.set(offset, entry);
	}
	if (at !== end) throw new Error('pack has trailing bytes');

	const resolve = (entry: Entry, depth = 0): PackObject | null => {
		if (entry.resolved) return entry.resolved;
		if (depth > 5000) throw new Error('delta chain too deep');
		let kind = CODE_KIND[entry.code];
		let data = entry.data;
		if (entry.code === OFS_DELTA || entry.code === REF_DELTA) {
			const baseEntry =
				entry.code === OFS_DELTA
					? byOffset.get(entry.baseOffset as number)
					: undefined;
			const base = baseEntry
				? resolve(baseEntry, depth + 1)
				: (objects.get(entry.baseOid as string) ?? null);
			if (base === null) return null;
			kind = base.kind;
			data = applyDelta(base.bytes, entry.data, spend);
		}
		const object = {
			oid: objectId(kind as ObjectKind, data),
			kind: kind as ObjectKind,
			bytes: data,
		};
		entry.resolved = object;
		objects.set(object.oid, object);
		return object;
	};
	let pending = entries;
	while (pending.length > 0) {
		const next = pending.filter((entry) => resolve(entry) === null);
		if (next.length === pending.length)
			throw new Error(
				`${pending.length} deltas name a base outside the pack (a thin pack)`,
			);
		pending = next;
	}
	return objects;
}
