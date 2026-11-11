/**
 * A whole database, through the real object, well past the value cap.
 *
 * ADR-0293 sends a generation's entire state as one request body and serves it
 * back the same way, and ADR-0295 sizes a database by its authority rather
 * than by its device. Both claims live or die inside `workerd`, and `bun test`
 * cannot run a Durable Object, so this is where the transfer is actually
 * exercised: 8 MB is nearly four times the enforced 2,199,995-byte SQLite value
 * cap, so it cannot pass without the authority chunking on the way in and
 * joining on the way out.
 *
 * What it catches is the failure with no smaller test: a chunking bug that
 * silently truncates a person's whole database on import or on bootstrap.
 *
 * **Compared by digest rather than by `toEqual`.** That is a measurement, not
 * a style choice. A byte-for-byte `expect(back).toEqual(state)` on two 8 MB
 * typed arrays exhausts the isolate outright ("Ineffective mark-compacts near
 * heap limit"), and it walls between 7.75 MB and 7.87 MB in this
 * configuration. The server path is not what runs out: the same 8 MB import
 * and bootstrap pass when the assertion does not hold both copies and build a
 * diff over them. A digest is exact, constant-space, and the reason this test
 * can be the size it needs to be.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'http://example.com';
const DATA_ID = 'so.epicenter.storeprobe';
const collection = `/api/data/v1/${DATA_ID}/generations`;

/**
 * Roughly a two-and-a-half thousand note vault at ADR-0294's measured 3.2 KB
 * encoded mean, and nearly four value caps.
 */
const SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Deterministic, so a truncation is a position rather than noise. */
function largeState(bytes: number): Uint8Array {
	return Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + 7) % 256);
}

async function digest(bytes: Uint8Array | ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest(
		'SHA-256',
		bytes as unknown as ArrayBuffer,
	);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function request(
	principal: string,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return SELF.fetch(`${ORIGIN}${path}`, {
		...init,
		headers: { authorization: `Bearer device:${principal}` },
	});
}

describe('a database larger than the value cap survives the round trip', () => {
	it('stores and serves 8 MB with its bytes intact', async () => {
		const principal = `large-${crypto.randomUUID()}`;
		const state = largeState(SNAPSHOT_BYTES);
		expect(state.byteLength).toBeGreaterThan(3 * 2_199_995);
		const expected = await digest(state);

		const created = await request(principal, collection, {
			method: 'POST',
			body: state as unknown as BodyInit,
		});
		expect(created.status).toBe(200);
		const { generation, position } = (await created.json()) as {
			generation: number;
			position: number;
		};
		expect(position).toBe(1);

		const fetched = await request(principal, `${collection}/${generation}`);
		expect(fetched.status).toBe(200);
		const back = await fetched.arrayBuffer();

		// Length first, so a truncation reads as a number rather than as a
		// digest mismatch that says nothing about how much is missing.
		expect(back.byteLength).toBe(SNAPSHOT_BYTES);
		expect(await digest(back)).toBe(expected);
	});
});
