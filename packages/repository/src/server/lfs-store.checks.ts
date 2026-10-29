/** What every `LfsStore` promises, as checks each adapter's test runs (`lfs-store.test.ts`). */
import type { LfsStore } from './lfs-store.js';

const bytes = new TextEncoder().encode('LFS bytes across several chunks');

async function hash(data: Uint8Array) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
}

const stream = (data: Uint8Array) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(data.slice(0, 7));
			controller.enqueue(data.slice(7));
			controller.close();
		},
	});
const check = (yes: boolean, reason: string) => {
	if (!yes) throw new Error(reason);
};

export const LFS_STORE_CHECKS: Record<
	string,
	(store: LfsStore) => Promise<void>
> = {
	async 'stores the empty object at its SHA-256'(store) {
		const name = await hash(new Uint8Array());
		const result = await store.put(name, 0, stream(new Uint8Array()));
		check(
			result.error === null && result.data === 'stored',
			'stored empty object',
		);
		check((await store.get(name))?.size === 0, 'empty size');
	},
	async 'stores exact bytes at their hash and reads them back'(store) {
		const name = await hash(bytes);
		check(!(await store.has(name)), 'absent before put');
		const put = await store.put(name, bytes.length, stream(bytes));
		check(put.error === null && put.data === 'stored', 'stored');
		check(await store.has(name), 'present after put');
		const read = await store.get(name);
		check(read?.size === bytes.length, 'read size');
		check(
			read !== null &&
				new Uint8Array(await new Response(read.body).arrayBuffer()).every(
					(byte, i) => byte === bytes[i],
				),
			'read bytes',
		);
	},
	async 'rejects wrong bytes, short bodies, and long bodies without storing'(
		store,
	) {
		for (const body of [
			new TextEncoder().encode('wrong'),
			bytes.slice(0, -1),
			new Uint8Array([...bytes, 0]),
		]) {
			const name = await hash(bytes);
			const result = await store.put(name, bytes.length, stream(body));
			check(result.error?.name === 'Mismatch', 'mismatch');
			check(!(await store.has(name)), 'nothing stored');
		}
	},
	async 'a second put preserves the first bytes'(store) {
		const name = await hash(bytes);
		await store.put(name, bytes.length, stream(bytes));
		const result = await store.put(
			name,
			bytes.length,
			stream(new TextEncoder().encode('different')),
		);
		check(result.error === null && result.data === 'present', 'present');
		const read = await store.get(name);
		check(
			read !== null &&
				(await new Response(read.body).arrayBuffer()).byteLength ===
					bytes.length,
			'unchanged',
		);
	},
	async 'a source error leaves no object'(store) {
		const name = await hash(bytes);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(bytes.slice(0, 5));
				controller.error(new Error('source failed'));
			},
		});
		const result = await store.put(name, bytes.length, body);
		check(result.error?.name === 'Failed', 'failed');
		check(!(await store.has(name)), 'nothing stored');
	},
};
