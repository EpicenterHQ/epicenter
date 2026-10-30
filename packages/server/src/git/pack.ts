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
 * Two budgets bound a read. Work: every entry's inflated bytes and every
 * delta's result count against `maxBytes` (`MAX_INFLATED_BYTES`), each
 * checked before it is inflated or allocated, so a small pack that declares
 * gigabytes of zeros is refused rather than read. Memory: `maxHeldBytes`
 * caps the bytes held at once. A first pass finds each entry and which
 * entries deltas build on; the second resolves them in order, and keeps an
 * object's bytes only while a later delta needs them, or when the caller
 * reads them (anything but a blob larger than `keepBlobBytes`). A blob let
 * go keeps its id and size. The receiver reads only commits, trees and LFS
 * pointers, so a push of large notes holds little more than its trees.
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

/** An object read from a pack. `bytes` is null for a blob `readPack` let go. */
export type PackedObject = {
	oid: string;
	kind: ObjectKind;
	size: number;
	bytes: Uint8Array | null;
};

/** Where one entry sits in the pack, from the first pass. */
type Entry = {
	offset: number;
	code: number;
	/** Its inflated size, from its header. */
	size: number;
	/** Where its deflated data starts, and how long it runs. */
	start: number;
	length: number;
	baseOffset?: number;
	baseOid?: string;
};

/**
 * Every object in `pack`, by id. An empty input is an empty pack. Throws
 * when the pack is malformed, inflates past `maxBytes`, or needs more than
 * `maxHeldBytes` at once.
 */
export function readPack(
	pack: Uint8Array,
	{
		maxBytes = MAX_INFLATED_BYTES,
		maxHeldBytes = Number.POSITIVE_INFINITY,
		keepBlobBytes = Number.POSITIVE_INFINITY,
	}: {
		/** The most a pack may inflate to, entries and delta results together. */
		maxBytes?: number;
		/** The most bytes held at once. */
		maxHeldBytes?: number;
		/** The largest blob whose bytes are kept; larger ones keep their id and size. */
		keepBlobBytes?: number;
	} = {},
): Map<string, PackedObject> {
	const objects = new Map<string, PackedObject>();
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
	let held = 0;
	const hold = (bytes: number) => {
		if (held + bytes > maxHeldBytes)
			throw new Error(
				`its objects need more than ${mib(maxHeldBytes)} in memory at once; push fewer or smaller files at once`,
			);
		held += bytes;
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

	// First pass: where each entry is, and how many deltas build on it.
	const entries: Entry[] = [];
	const usesOfOffset = new Map<number, number>();
	const usesOfOid = new Map<string, number>();
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
		const entry: Entry = { offset, code, size, start: 0, length: 0 };
		if (code === OFS_DELTA) {
			byte = buf[at++] as number;
			let back = byte & 127;
			while (byte & 128) {
				byte = buf[at++] as number;
				back = (back + 1) * 128 + (byte & 127);
			}
			entry.baseOffset = offset - back;
			usesOfOffset.set(
				entry.baseOffset,
				(usesOfOffset.get(entry.baseOffset) ?? 0) + 1,
			);
		} else if (code === REF_DELTA) {
			entry.baseOid = buf.toString('hex', at, at + 20);
			at += 20;
			usesOfOid.set(entry.baseOid, (usesOfOid.get(entry.baseOid) ?? 0) + 1);
		} else if (CODE_KIND[code] === undefined)
			throw new Error(`unknown pack entry type ${code}`);
		// The declared size is checked first; the inflation is capped too, in case the header understates it.
		if (size > left) throw tooLarge();
		hold(size);
		const inflated = inflate(at, Math.max(1, Math.min(left, maxHeldBytes)));
		held -= size;
		if (inflated.buffer.length !== size)
			throw new Error('pack entry size mismatch');
		spend(size);
		entry.start = at;
		entry.length = inflated.engine.bytesWritten;
		at += entry.length;
		entries.push(entry);
	}
	if (at !== end) throw new Error('pack has trailing bytes');

	function inflate(from: number, maxOutputLength: number) {
		try {
			return inflateSync(buf.subarray(from, end), {
				info: true,
				maxOutputLength,
			}) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
		} catch (cause) {
			if (cause instanceof RangeError) throw tooLarge();
			throw cause;
		}
	}

	// Second pass: resolve in order, keeping bytes only while they are needed.
	const byOffset = new Map<number, PackedObject>();
	/** How many deltas still need each object's bytes. */
	const uses = new Map<PackedObject, number>();
	const keeps = (object: PackedObject) =>
		object.kind !== 'blob' || object.size <= keepBlobBytes;
	const release = (object: PackedObject) => {
		const remaining = (uses.get(object) ?? 0) - 1;
		uses.set(object, remaining);
		if (remaining > 0 || keeps(object) || object.bytes === null) return;
		held -= object.size;
		object.bytes = null;
	};
	const settle = (entry: Entry, kind: ObjectKind, data: Uint8Array) => {
		const object: PackedObject = {
			oid: objectId(kind, data),
			kind,
			size: data.length,
			bytes: data,
		};
		const needed =
			(usesOfOffset.get(entry.offset) ?? 0) + (usesOfOid.get(object.oid) ?? 0);
		uses.set(object, needed);
		if (needed === 0 && !keeps(object)) {
			held -= data.length;
			object.bytes = null;
		}
		byOffset.set(entry.offset, object);
		objects.set(object.oid, object);
	};
	/** Resolve `entry`, or return false when its base is not read yet. */
	const resolve = (entry: Entry, data: Uint8Array | null): boolean => {
		const delta = entry.code === OFS_DELTA || entry.code === REF_DELTA;
		const base = !delta
			? null
			: entry.code === OFS_DELTA
				? byOffset.get(entry.baseOffset as number)
				: objects.get(entry.baseOid as string);
		if (delta && !base) return false;
		let own = data;
		if (own === null) {
			hold(entry.size);
			own = inflate(entry.start, Math.max(1, entry.size)).buffer;
		}
		if (!delta || !base) {
			settle(entry, CODE_KIND[entry.code] as ObjectKind, own);
			return true;
		}
		if (base.bytes === null) throw new Error('delta base let go too early');
		const result = applyDelta(base.bytes, own, (bytes) => {
			spend(bytes);
			hold(bytes);
		});
		held -= own.length;
		release(base);
		settle(entry, base.kind, result);
		return true;
	};
	let waiting: { entry: Entry; data: Uint8Array }[] = [];
	for (const entry of entries)
		if (!resolve(entry, null)) {
			// A ref-delta whose base comes later in the pack: keep its data.
			hold(entry.size);
			waiting.push({
				entry,
				data: inflate(entry.start, Math.max(1, entry.size)).buffer,
			});
		}
	while (waiting.length > 0) {
		const next = waiting.filter(({ entry, data }) => !resolve(entry, data));
		if (next.length === waiting.length)
			throw new Error(
				`${waiting.length} deltas name a base outside the pack (a thin pack)`,
			);
		waiting = next;
	}
	return objects;
}
