/**
 * A Git pack (version 2, no deltas): what one receive-pack request carries,
 * so a store writes a flush's objects in one request. Each object is its
 * type and size, then its content zlib-deflated; the pack ends with the
 * SHA-1 of everything before it.
 */
import { type GitObject, sha1 } from '../core/hash.js';

const TYPES = { commit: 1, tree: 2, blob: 3 } as const;

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The pack holding `objects`, in order. */
export async function encodePack(objects: GitObject[]): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	const head = new Uint8Array(12);
	head.set([0x50, 0x41, 0x43, 0x4b]); // "PACK"
	const view = new DataView(head.buffer);
	view.setUint32(4, 2);
	view.setUint32(8, objects.length);
	parts.push(head);
	for (const { kind, bytes } of objects) {
		// Type in bits 4 to 6 of the first byte, the size in 4 bits and then 7 bits a byte, low first.
		const header: number[] = [];
		let size = bytes.length;
		let byte = (TYPES[kind] << 4) | (size & 0x0f);
		size = Math.floor(size / 16);
		while (size > 0) {
			header.push(byte | 0x80);
			byte = size & 0x7f;
			size = Math.floor(size / 128);
		}
		header.push(byte);
		parts.push(new Uint8Array(header), await deflate(bytes));
	}
	const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.length;
	}
	const digest = sha1(body);
	const pack = new Uint8Array(body.length + 20);
	pack.set(body);
	for (let i = 0; i < 20; i++) pack[body.length + i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
	return pack;
}
