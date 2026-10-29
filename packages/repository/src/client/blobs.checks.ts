/**
 * The blob store's conformance checks: what every `BlobStore` promises,
 * as plain async functions that throw on the first broken promise, so the
 * same checks run under `bun test` (`blobs.test.ts`) and inside a browser
 * worker against OPFS (`browser-tests/objects.worker.ts`). Each check gets
 * a fresh, empty store.
 */
import type { BlobStore } from './blobs.js';

/** Bytes that differ from one `seed` to the next, so each names its own object. */
export const bytesOf = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);

/** The SHA-256 of `bytes` by the platform's own digest, independent of the store's hasher. */
export async function oidOf(bytes: Uint8Array) {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A stream of `bytes` in chunks of `size`, as a file or a recording arrives. */
export function streamOf(bytes: Uint8Array, size = 64 * 1024) {
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(at, at + size));
			at += size;
		},
	});
}

/** A stream that gives `chunks` chunks of `bytes` and then fails, as a dropped upload or a revoked file would. */
function failingStream(bytes: Uint8Array, chunks: number) {
	let given = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (given === chunks) return controller.error(new Error('the source failed'));
			controller.enqueue(bytes.slice(given * 1024, (given + 1) * 1024));
			given++;
		},
	});
}

function check(holds: boolean, what: string) {
	if (!holds) throw new Error(`Broken promise: ${what}`);
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const bytesIn = async (handle: Blob | null) => (handle === null ? null : new Uint8Array(await handle.arrayBuffer()));

async function sealed(store: BlobStore<Blob>, stream: ReadableStream<Uint8Array>) {
	const { data, error } = await store.seal(stream);
	if (error !== null) throw new Error(`The seal failed: ${error.message}`);
	return data;
}

export const BLOB_STORE_CHECKS: Record<string, (store: BlobStore<Blob>) => Promise<void>> = {
	async 'a seal names the bytes by their SHA-256 and a read gives them back'(store) {
		const bytes = bytesOf(300_000, 1);
		const { oid, size } = await sealed(store, streamOf(bytes, 7_919));
		check(oid === (await oidOf(bytes)), 'the oid is the SHA-256 of every chunk, in order');
		check(size === bytes.length, 'the size is the byte count');
		check(await store.has(oid), 'a sealed object is here');
		const read = await bytesIn(await store.read(oid));
		check(read !== null && same(read, bytes), 'a read gives back the sealed bytes');
	},
	async 'no bytes seal to the empty oid'(store) {
		const { oid, size } = await sealed(store, streamOf(new Uint8Array(0)));
		check(oid === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'the empty oid');
		check(size === 0, 'size zero');
		check((await bytesIn(await store.read(oid)))?.length === 0, 'a read gives no bytes');
	},
	async 'sealing the same bytes twice is one object, and a handle read before stays readable'(store) {
		const bytes = bytesOf(50_000, 2);
		const first = await sealed(store, streamOf(bytes));
		const handle = await store.read(first.oid);
		const second = await sealed(store, streamOf(bytes, 1_000));
		check(second.oid === first.oid && second.size === first.size, 'the same oid and size');
		const read = await bytesIn(handle);
		check(read !== null && same(read, bytes), 'the earlier handle still reads the bytes');
	},
	async 'a source that fails mid-seal stores nothing'(store) {
		const bytes = bytesOf(10_000, 3);
		const { error } = await store.seal(failingStream(bytes, 3));
		check(error?.name === 'Failed', 'the seal fails');
		check(!(await store.has(await oidOf(bytes.slice(0, 3 * 1024)))), 'no object for the bytes that arrived');
		// The store still seals afterwards.
		const { oid } = await sealed(store, streamOf(bytes));
		check(await store.has(oid), 'a later seal of the whole stores it');
	},
	async 'an oid that is not here, or is not an oid, reads as nothing'(store) {
		const absent = await oidOf(bytesOf(10, 4));
		check((await store.read(absent)) === null && !(await store.has(absent)), 'an absent oid');
		for (const name of ['', '../escape', absent.toUpperCase(), `${absent}.tmp`, absent.slice(1)])
			check((await store.read(name)) === null && !(await store.has(name)), `not an oid: ${JSON.stringify(name)}`);
	},
	async 'evict lets an object go, and evicting one that is not here does nothing'(store) {
		const kept = await sealed(store, streamOf(bytesOf(1_000, 5)));
		const gone = await sealed(store, streamOf(bytesOf(1_000, 6)));
		await store.evict(gone.oid);
		check(!(await store.has(gone.oid)) && (await store.read(gone.oid)) === null, 'the evicted object is gone');
		check(await store.has(kept.oid), 'the other stays');
		await store.evict(gone.oid);
		await store.evict('not an oid');
		// Sealed again, it is back.
		await sealed(store, streamOf(bytesOf(1_000, 6)));
		check(await store.has(gone.oid), 'sealing the bytes again brings it back');
	},
};
