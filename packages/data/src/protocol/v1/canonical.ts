/**
 * RFC 8785 canonical semantic encoding and SHA-256 request hashing.
 *
 * These are private authority mechanics. The wire carries no canonical string
 * and no digest. The authority canonicalizes a validated semantic request to
 * one representation so that exact-retry equality and byte admission agree
 * across the browser, Bun, and Cloudflare runtimes, then hashes those UTF-8
 * bytes to store a small fork-detection witness per replica.
 *
 * The encoder implements the JSON Canonicalization Scheme (JCS):
 * https://www.rfc-editor.org/rfc/rfc8785.html
 *
 * - object members are serialized in ascending UTF-16 code-unit order of their
 *   names (not code-point order, so a surrogate-pair key sorts by its leading
 *   surrogate);
 * - numbers use the ECMAScript Number-to-String representation, which JCS
 *   adopts verbatim, so `JSON.stringify` of a finite number is already
 *   canonical;
 * - strings use ECMAScript minimal JSON escaping, which JCS also adopts; and
 * - there is no insignificant whitespace.
 *
 * Epicenter only ever canonicalizes finite, well-formed JSON values. The
 * encoder is defensive: a non-finite number, a lone UTF-16 surrogate, a sparse
 * or extended array, a symbol/accessor/non-enumerable property, a cyclic or
 * shared reference, or a non-plain object is a caller bug, so it throws rather
 * than inventing a representation the scheme does not define or silently losing
 * data (a lone surrogate would become U+FFFD under UTF-8 encoding).
 */

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

/**
 * Whether a string contains no lone UTF-16 surrogate.
 *
 * A lone surrogate is not valid Unicode and cannot survive UTF-8 encoding
 * (it becomes U+FFFD), so it must be rejected everywhere a string can
 * appear: object keys, payload values, and opaque identities.
 */
export function isWellFormedString(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/**
 * Whether a value is a dense array of data elements with no extra, symbol, or
 * accessor properties. Holes and array-attached properties are rejected because
 * JSON has neither.
 */
export function isDenseDataArray(value: readonly unknown[]): boolean {
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	let indexCount = 0;
	for (const name of Object.getOwnPropertyNames(value)) {
		if (name === 'length') continue;
		const asIndex = Number(name);
		if (
			!Number.isInteger(asIndex) ||
			asIndex < 0 ||
			asIndex >= value.length ||
			String(asIndex) !== name
		) {
			return false;
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!('value' in descriptor)
		) {
			return false;
		}
		indexCount += 1;
	}
	return indexCount === value.length;
}

/**
 * Whether a value is a plain object whose every own property is an enumerable,
 * well-formed-string-keyed data property. Prototypes, symbol keys, accessors,
 * non-enumerable properties, and lone-surrogate keys are rejected.
 */
export function isPlainDataObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	for (const name of Object.getOwnPropertyNames(value)) {
		if (!isWellFormedString(name)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!('value' in descriptor)
		) {
			return false;
		}
	}
	return true;
}

type Leaf = 'ok' | 'bad' | 'container';

function classifyLeaf(value: unknown): Leaf {
	if (value === null || typeof value === 'boolean') return 'ok';
	if (typeof value === 'string')
		return isWellFormedString(value) ? 'ok' : 'bad';
	if (typeof value === 'number') return Number.isFinite(value) ? 'ok' : 'bad';
	// Rejects undefined, symbol, function, and bigint.
	if (typeof value !== 'object') return 'bad';
	return 'container';
}

/**
 * Snapshot one container's child values without invoking accessors or ordinary
 * property gets. `maxChildren` is checked from the single own-key snapshot
 * before any child descriptor is reflected, bounding both deep and wide
 * generative Proxies.
 */
function canonicalChildren(
	node: object,
	maxChildren: number,
): unknown[] | null {
	if (Array.isArray(node)) {
		const keys = Reflect.ownKeys(node);
		// Every real array owns its non-configurable `length`. Checking raw key
		// count first refuses a wide Proxy before reading any child descriptor.
		if (keys.length === 0 || keys.length - 1 > maxChildren) return null;
		const lengthDescriptor = Object.getOwnPropertyDescriptor(node, 'length');
		if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
			return null;
		}
		const length = lengthDescriptor.value;
		if (
			typeof length !== 'number' ||
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > maxChildren ||
			keys.length !== length + 1
		) {
			return null;
		}
		const children = new Array<unknown>(length);
		let indexCount = 0;
		for (const key of keys) {
			if (key === 'length') continue;
			if (typeof key !== 'string') return null;
			const index = Number(key);
			if (
				!Number.isInteger(index) ||
				index < 0 ||
				index >= length ||
				String(index) !== key
			) {
				return null;
			}
			const descriptor = Object.getOwnPropertyDescriptor(node, key);
			if (
				descriptor === undefined ||
				!descriptor.enumerable ||
				!('value' in descriptor)
			) {
				return null;
			}
			children[index] = descriptor.value;
			indexCount += 1;
		}
		return indexCount === length ? children : null;
	}
	const prototype = Object.getPrototypeOf(node);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const keys = Reflect.ownKeys(node);
	if (keys.length > maxChildren) return null;
	const children: unknown[] = [];
	for (const key of keys) {
		if (typeof key !== 'string' || !isWellFormedString(key)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(node, key);
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!('value' in descriptor)
		) {
			return null;
		}
		children.push(descriptor.value);
	}
	return children;
}

/**
 * Non-throwing structural check that a whole value is a canonical JSON data
 * *tree*: finite numbers, well-formed strings, dense data arrays, and plain
 * enumerable string-keyed data objects, with no cycles and no shared references.
 *
 * Wire JSON is a tree. A shared subtree (the same object reached by two paths)
 * is refused for the same reason a cycle is: the canonical encoder emits every
 * occurrence, so a small graph of N shared levels would canonicalize to 2^N
 * bytes. Refusing repeated object identity here closes that expansion at
 * admission instead of teaching the encoder a byte budget.
 *
 * The traversal is iterative with an explicit stack and a single monotonic
 * visited set, so ordinary depth (tens of thousands of levels) cannot exhaust
 * the JS stack and a hostile graph refuses at its first re-encounter rather than
 * expanding. `maxNodes` bounds both a deep generative Proxy that returns a fresh
 * child forever and a wide Proxy that exposes more children than the admitted
 * byte ceiling can encode. Each container's keys are snapshotted once, then its
 * child descriptors are read only when every child fits the remaining budget.
 * Any reflection or proxy-trap failure is caught and reported as `false`; a
 * throwing Proxy therefore rejects, and a transparent Proxy is left for the
 * caller's `structuredClone` to reject (it cannot own one).
 *
 * Unlike `isJsonValue`, it applies no depth or property-count limit, so it can
 * gate a protocol envelope without imposing payload limits on the envelope
 * itself.
 */
export function isCanonicalJson(value: unknown, maxNodes: number): boolean {
	try {
		if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) return false;
		if (classifyLeaf(value) !== 'container') {
			return classifyLeaf(value) === 'ok';
		}
		let visitedNodes = 1;
		const rootChildren = canonicalChildren(
			value as object,
			maxNodes - visitedNodes,
		);
		if (rootChildren === null) return false;
		visitedNodes += rootChildren.length;
		// Every container in a tree is visited exactly once. A container reached a
		// second time is either a cycle (still on the active path) or a shared
		// reference (fully walked earlier); a single monotonic set refuses both, and
		// never deleting also bounds work so a hostile graph refuses at its first
		// re-encounter.
		const seen = new Set<object>([value as object]);
		const stack: Array<{ children: unknown[]; index: number }> = [
			{ children: rootChildren, index: 0 },
		];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			if (frame === undefined) break;
			if (frame.index >= frame.children.length) {
				stack.pop();
				continue;
			}
			const child = frame.children[frame.index];
			frame.index += 1;
			const leaf = classifyLeaf(child);
			if (leaf === 'bad') return false;
			if (leaf === 'ok') continue;
			const container = child as object;
			if (seen.has(container)) return false; // cycle or shared reference
			const children = canonicalChildren(container, maxNodes - visitedNodes);
			if (children === null) return false;
			visitedNodes += children.length;
			seen.add(container);
			stack.push({ children, index: 0 });
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Maximum tree-node work for a value within a canonical byte ceiling. Every
 * JSON node contributes at least one byte to its canonical encoding, so the
 * byte ceiling itself is a conservative node/edge budget, not another protocol
 * limit.
 */
export function maxNodesForCanonicalBytes(maxCanonicalBytes: number): number {
	return maxCanonicalBytes;
}

/**
 * Freeze a value so a sealed admitted request or validated limits cannot be
 * mutated after admission. Iterative with an explicit stack, so freezing a deep
 * structure cannot overflow the JS stack; already-frozen nodes are skipped,
 * which also makes it cycle-safe.
 */
export function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	const stack: object[] = [value];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined || Object.isFrozen(node)) continue;
		Object.freeze(node);
		for (const key of Object.keys(node as Record<string, unknown>)) {
			const child = (node as Record<string, unknown>)[key];
			if (child !== null && typeof child === 'object') stack.push(child);
		}
	}
	return value;
}

/**
 * Serialize a finite, well-formed JSON value to its RFC 8785 canonical string.
 *
 * Object keys are sorted by UTF-16 code unit, which JavaScript's `<` operator
 * compares directly, so no locale-aware collation enters the result. Every
 * structural invariant above is enforced defensively; a violation throws.
 */
export function canonicalize(value: unknown): string {
	type Task =
		| { kind: 'value'; value: unknown }
		| { kind: 'text'; text: string };

	const parts: string[] = [];
	const visited = new Set<object>();
	const stack: Task[] = [{ kind: 'value', value }];
	while (stack.length > 0) {
		const task = stack.pop();
		if (task === undefined) break;
		if (task.kind === 'text') {
			parts.push(task.text);
			continue;
		}

		const current = task.value;
		if (current === null || typeof current === 'boolean') {
			parts.push(JSON.stringify(current));
			continue;
		}
		if (typeof current === 'string') {
			if (!isWellFormedString(current)) {
				throw new TypeError('Canonical JSON rejects lone surrogates');
			}
			parts.push(JSON.stringify(current));
			continue;
		}
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) {
				throw new TypeError('Canonical JSON accepts only finite numbers');
			}
			// JSON.stringify normalizes -0 to "0" and matches the JCS number form.
			parts.push(JSON.stringify(current));
			continue;
		}
		if (typeof current !== 'object') {
			throw new TypeError('Canonical JSON accepts only finite JSON values');
		}
		// Wire JSON is a tree. A container reached twice is a cycle or a shared
		// reference; either would emit the subtree more than once (a graph of N
		// shared levels expands to 2^N bytes), so refuse repeated object identity
		// rather than expand it. The set is monotonic, matching `isCanonicalJson`.
		if (visited.has(current)) {
			throw new TypeError('Canonical JSON rejects cyclic or shared references');
		}
		visited.add(current);

		if (Array.isArray(current)) {
			if (!isDenseDataArray(current)) {
				throw new TypeError('Canonical JSON accepts only dense data arrays');
			}
			const children = current.slice();
			parts.push('[');
			stack.push({ kind: 'text', text: ']' });
			for (let index = children.length - 1; index >= 0; index -= 1) {
				stack.push({ kind: 'value', value: children[index] });
				if (index > 0) stack.push({ kind: 'text', text: ',' });
			}
			continue;
		}

		if (!isPlainDataObject(current)) {
			throw new TypeError('Canonical JSON accepts only plain data objects');
		}
		const record = current as Record<string, unknown>;
		const keys = Object.keys(record).sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		const entries = keys.map((key) => [key, record[key]] as const);
		parts.push('{');
		stack.push({ kind: 'text', text: '}' });
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry === undefined) continue;
			stack.push({ kind: 'value', value: entry[1] });
			stack.push({ kind: 'text', text: ':' });
			stack.push({ kind: 'text', text: JSON.stringify(entry[0]) });
			if (index > 0) stack.push({ kind: 'text', text: ',' });
		}
	}
	return parts.join('');
}

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

function wordAt(words: Uint32Array, index: number): number {
	const word = words[index];
	if (word === undefined) throw new RangeError('SHA-256 word index is invalid');
	return word;
}

/**
 * SHA-256 over the UTF-8 bytes of `input`, returned as lowercase hex.
 *
 * This is a reference-oracle mechanic, not a wire or public hash. ADR-0163
 * makes the request hash server-private fork-detection state: it is "not a
 * public wire field, digest identity, or application concept." The reference
 * authority keeps a synchronous pure implementation so `submit` stays one
 * deterministic `(state, request, limits)` transition with no `crypto` global.
 * The real server authority (Wave 2c) owns its own platform hashing (for
 * example Web Crypto) and may use a different implementation because the hash
 * is not exchanged between peers. Within one authority lifetime, its persisted
 * retry-ledger semantics must nevertheless remain stable across restarts and
 * upgrades. RFC 8785 canonicalization is the shared input law. The v1 barrel is
 * absent from the package `exports` map, so no consumer can freeze this
 * primitive as a public contract.
 */
export function sha256Hex(input: string): string {
	const message = textEncoder.encode(input);
	const bitLength = message.length * 8;
	const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
	const padded = new Uint8Array(paddedLength);
	padded.set(message);
	padded[message.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
	view.setUint32(paddedLength - 4, bitLength >>> 0);

	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;
	const words = new Uint32Array(64);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index += 1)
			words[index] = view.getUint32(offset + index * 4);
		for (let index = 16; index < 64; index += 1) {
			const word15 = wordAt(words, index - 15);
			const word2 = wordAt(words, index - 2);
			const s0 =
				rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
			const s1 =
				rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
			words[index] =
				(wordAt(words, index - 16) + s0 + wordAt(words, index - 7) + s1) >>> 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;
		for (let index = 0; index < 64; index += 1) {
			const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const first =
				(h + s1 + choice + wordAt(K, index) + wordAt(words, index)) >>> 0;
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
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
		h5 = (h5 + f) >>> 0;
		h6 = (h6 + g) >>> 0;
		h7 = (h7 + h) >>> 0;
	}

	return [h0, h1, h2, h3, h4, h5, h6, h7]
		.map((word) => word.toString(16).padStart(8, '0'))
		.join('');
}
