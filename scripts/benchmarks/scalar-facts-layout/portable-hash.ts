/**
 * A portable streaming SHA-256, byte-identical to the V1 kernel's `sha256Hex`
 * over the same concatenated UTF-8 input.
 *
 * The trace and its auxiliary owner traces hash a million framed records in one
 * streaming pass, so they cannot materialize one giant string and call
 * `sha256Hex` once, and they must not depend on Bun's `CryptoHasher` (absent in a
 * browser) or Node's `Buffer`. This module isolates that single portability
 * concern: it uses only `TextEncoder` and typed arrays, so trace generation,
 * framing, and incremental hashing stay portable to browser runtimes exactly as
 * the frozen pilot requires. Bun owns only the local runner and SQLite lifecycle.
 *
 * The block transform is the same SHA-256 the kernel implements; because SHA-256
 * is a standard streaming hash, updating this hasher with the same bytes the
 * kernel would concatenate yields the identical digest. `portable-hash.test.ts`
 * proves that equivalence against the kernel's `sha256Hex` directly, so the two
 * implementations can never silently drift.
 */

const textEncoder = new TextEncoder();

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number): number =>
	(value >>> bits) | (value << (32 - bits));

/**
 * An incremental SHA-256 hasher over UTF-8 text chunks.
 *
 * `update` accepts any number of string chunks; the digest depends only on the
 * concatenation of their UTF-8 bytes, never on the chunk boundaries. `digestHex`
 * returns the lowercase hex digest and finalizes the hasher; further `update` or
 * `digestHex` calls throw, so a finalized hasher cannot be silently reused.
 */
export class Sha256Stream {
	private h0 = 0x6a09e667;
	private h1 = 0xbb67ae85;
	private h2 = 0x3c6ef372;
	private h3 = 0xa54ff53a;
	private h4 = 0x510e527f;
	private h5 = 0x9b05688c;
	private h6 = 0x1f83d9ab;
	private h7 = 0x5be0cd19;
	/** A partial 64-byte block awaiting more bytes before it can be transformed. */
	private readonly block = new Uint8Array(64);
	private blockLength = 0;
	private totalBytes = 0;
	private finalized = false;
	private readonly words = new Uint32Array(64);

	update(chunk: string): this {
		if (this.finalized) throw new Error('Sha256Stream was already finalized');
		const bytes = textEncoder.encode(chunk);
		this.totalBytes += bytes.length;
		let offset = 0;
		// Top off any partial block first, transform whole 64-byte blocks in place,
		// then keep the trailing remainder for the next call.
		if (this.blockLength > 0) {
			const need = 64 - this.blockLength;
			const take = Math.min(need, bytes.length);
			this.block.set(bytes.subarray(0, take), this.blockLength);
			this.blockLength += take;
			offset = take;
			if (this.blockLength === 64) {
				this.transform(this.block, 0);
				this.blockLength = 0;
			}
		}
		while (offset + 64 <= bytes.length) {
			this.transform(bytes, offset);
			offset += 64;
		}
		if (offset < bytes.length) {
			this.block.set(bytes.subarray(offset), 0);
			this.blockLength = bytes.length - offset;
		}
		return this;
	}

	digestHex(): string {
		if (this.finalized) throw new Error('Sha256Stream was already finalized');
		this.finalized = true;
		const bitLength = this.totalBytes * 8;
		// One 0x80 byte, zero padding, then the 64-bit big-endian bit length. The
		// tail is one block when the length byte plus the 8-byte length fit, else two.
		const tail = new Uint8Array(this.blockLength < 56 ? 64 : 128);
		tail.set(this.block.subarray(0, this.blockLength), 0);
		tail[this.blockLength] = 0x80;
		const view = new DataView(tail.buffer);
		view.setUint32(tail.length - 8, Math.floor(bitLength / 0x1_0000_0000));
		view.setUint32(tail.length - 4, bitLength >>> 0);
		for (let offset = 0; offset < tail.length; offset += 64) {
			this.transform(tail, offset);
		}
		return [
			this.h0,
			this.h1,
			this.h2,
			this.h3,
			this.h4,
			this.h5,
			this.h6,
			this.h7,
		]
			.map((word) => (word >>> 0).toString(16).padStart(8, '0'))
			.join('');
	}

	private transform(source: Uint8Array, base: number): void {
		const words = this.words;
		for (let index = 0; index < 16; index += 1) {
			const at = base + index * 4;
			words[index] =
				(((source[at] ?? 0) << 24) |
					((source[at + 1] ?? 0) << 16) |
					((source[at + 2] ?? 0) << 8) |
					(source[at + 3] ?? 0)) >>>
				0;
		}
		for (let index = 16; index < 64; index += 1) {
			const w15 = words[index - 15] ?? 0;
			const w2 = words[index - 2] ?? 0;
			const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
			const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
			words[index] =
				((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
		}
		let a = this.h0;
		let b = this.h1;
		let c = this.h2;
		let d = this.h3;
		let e = this.h4;
		let f = this.h5;
		let g = this.h6;
		let h = this.h7;
		for (let index = 0; index < 64; index += 1) {
			const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const first =
				(h + s1 + choice + (K[index] ?? 0) + (words[index] ?? 0)) >>> 0;
			const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const second = (s0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + first) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (first + second) >>> 0;
		}
		this.h0 = (this.h0 + a) >>> 0;
		this.h1 = (this.h1 + b) >>> 0;
		this.h2 = (this.h2 + c) >>> 0;
		this.h3 = (this.h3 + d) >>> 0;
		this.h4 = (this.h4 + e) >>> 0;
		this.h5 = (this.h5 + f) >>> 0;
		this.h6 = (this.h6 + g) >>> 0;
		this.h7 = (this.h7 + h) >>> 0;
	}
}

/** Portable UTF-8 byte length, matching the kernel's `utf8ByteLength`. */
export function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}
