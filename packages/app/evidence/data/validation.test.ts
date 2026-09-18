/**
 * Why the authority validates nothing: the record of a mechanism that was cut.
 *
 * **Nothing measured here is in the transport.** `src/sync/authority.ts` makes
 * no Yjs call at all and never reads the bytes it stores. This file is kept
 * because the argument for that is a measurement, and deleting the measurement
 * would leave only an assertion, one that "surely the server should check the
 * update is valid" would overturn in an afternoon.
 *
 * The design memo said the authority calls `encodeStateVectorFromUpdateV2` on
 * the reassembled update, keeps only whether it threw, and that "that is what
 * closes the poison pill". Two things there are wrong, and both matter:
 *
 * 1. That call is the WEAKEST of the candidates. An update truncated by one
 *    byte passes it and throws on every device that applies it, which is the
 *    exact failure it was chosen to prevent.
 * 2. NOTHING the authority can call closes the poison pill, including applying
 *    the update to a throwaway document. Whether bytes throw depends on the
 *    structs the RECEIVER already holds, and the authority holds none by
 *    definition, so the receiver's predicate is not available to it.
 *
 * So every candidate was a filter and none was a proof. `diffUpdateV2` was the
 * strongest of them and shipped for a while; it was removed once the rest of its
 * bill was counted, being the most expensive step in an append, the only
 * coupling between the server and Yjs's version, and the one thing that made
 * end-to-end encryption impossible. What actually bounds the damage is that a
 * partition has one writer principal, so the only party who can author bytes
 * that brick it is the party that owns it, and what recovers from it is that
 * every log entry is individually addressable and a replica names the position
 * it is stuck at (`src/sync/transport.test.ts`).
 *
 * These tests measure the candidates against ground truth, a real receiver.
 * Nothing here asserts an exact count, because counts move with the corpus; the
 * ORDERING and the DIRECTION are the properties.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import { putRow, rowAt, type ValuesType } from './raw-document.js';

const EMPTY_STATE_VECTOR = new Uint8Array(
	Y.encodeStateVector(new Y.Doc({ gc: true })),
);

/** The memo's choice: recover the clocks and stop reading. */
function acceptsByStateVector(bytes: Uint8Array): boolean {
	try {
		Y.encodeStateVectorFromUpdateV2(bytes as Uint8Array<ArrayBuffer>);
		return true;
	} catch {
		return false;
	}
}

/** The strongest documentless candidate: decode the whole stream, re-encode it. */
function acceptsByDiff(bytes: Uint8Array): boolean {
	try {
		Y.diffUpdateV2(
			bytes as Uint8Array<ArrayBuffer>,
			EMPTY_STATE_VECTOR as Uint8Array<ArrayBuffer>,
		);
		return true;
	} catch {
		return false;
	}
}

/** The most an authority could possibly do: integrate into a throwaway doc. */
function acceptsByThrowawayDocument(bytes: Uint8Array): boolean {
	const doc = new Y.Doc({ gc: true });
	try {
		Y.applyUpdateV2(doc, bytes as Uint8Array<ArrayBuffer>);
		return true;
	} catch {
		return false;
	} finally {
		doc.destroy();
	}
}

/** Ground truth: a device holding `base` is handed `bytes`. Does it survive? */
function receiverSurvives(
	base: Uint8Array | undefined,
	bytes: Uint8Array,
): boolean {
	const doc = new Y.Doc({ gc: true });
	try {
		if (base !== undefined)
			Y.applyUpdateV2(doc, base as Uint8Array<ArrayBuffer>);
		Y.applyUpdateV2(doc, bytes as Uint8Array<ArrayBuffer>);
		return true;
	} catch {
		return false;
	} finally {
		doc.destroy();
	}
}

/** A document shaped like a real one: rows with fields, and node text. */
function sample(rows: number): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	const root = doc.get('notes');
	doc.transact(() => {
		for (let index = 0; index < rows; index += 1) {
			const row = new Y.Type();
			root.setAttr(
				`r${String(index).padStart(23, '0')}` as never,
				row as never,
			);
			row.setAttr('title' as never, `note ${index}` as never);
			const container = new Y.Type();
			row.setAttr('!doc' as never, container as never);
			const text = new Y.Type('text' as never);
			container.setAttr('editor' as never, text as never);
			text.applyDelta(text.change.insert('x'.repeat(200)) as never);
		}
	});
	const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
	doc.destroy();
	return bytes;
}

/**
 * A real incremental send and the state a receiver already holds for it.
 *
 * The harder case, and the one the transport actually carries: an increment
 * references structs the receiver has, so corruption in it fails during
 * integration rather than during decode.
 */
function incrementOverSeed(): { seed: Uint8Array; increment: Uint8Array } {
	const doc = new Y.Doc({ gc: true });
	const root = doc.get('notes');
	doc.transact(() => {
		for (let index = 0; index < 20; index += 1) {
			const row: ValuesType = new Y.Type();
			putRow(root, `r${index}`, row);
			row.setAttr('title', `note ${index}`);
		}
	});
	const seed = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
	const mark = Y.encodeStateVector(doc);
	doc.transact(() => {
		for (let index = 0; index < 20; index += 1) {
			rowAt(root, `r${index}`)?.setAttr('title', `edited ${index}`);
		}
	});
	const increment = new Uint8Array(
		Y.diffUpdateV2(
			Y.encodeStateAsUpdateV2(doc) as Uint8Array<ArrayBuffer>,
			mark as Uint8Array<ArrayBuffer>,
		),
	);
	doc.destroy();
	return { seed, increment };
}

/** Every single-byte flip, and every truncation of the last 200 bytes. */
function mutations(valid: Uint8Array): Uint8Array[] {
	const candidates: Uint8Array[] = [];
	for (let at = 0; at < valid.length; at += 1) {
		const corrupted = new Uint8Array(valid);
		corrupted[at] = (corrupted[at] ?? 0) ^ 0xff;
		candidates.push(corrupted);
	}
	for (
		let length = Math.max(0, valid.length - 200);
		length <= valid.length;
		length += 1
	) {
		candidates.push(valid.slice(0, length));
	}
	return candidates;
}

type Leaks = {
	unsafe: number;
	stateVector: number;
	diff: number;
	document: number;
};

function measure(valid: Uint8Array, base: Uint8Array | undefined): Leaks {
	const leaks: Leaks = { unsafe: 0, stateVector: 0, diff: 0, document: 0 };
	for (const candidate of mutations(valid)) {
		if (receiverSurvives(base, candidate)) continue;
		leaks.unsafe += 1;
		if (acceptsByStateVector(candidate)) leaks.stateVector += 1;
		if (acceptsByDiff(candidate)) leaks.diff += 1;
		if (acceptsByThrowawayDocument(candidate)) leaks.document += 1;
	}
	return leaks;
}

describe('the memo names the weakest available check', () => {
	test('an update truncated by ONE byte passes it and throws on apply', () => {
		const truncated = sample(50).slice(0, -1);

		expect(acceptsByStateVector(truncated)).toBe(true);
		expect(receiverSurvives(undefined, truncated)).toBe(false);
		// Why the memo's choice was never the one to ship, in one line.
		expect(acceptsByDiff(truncated)).toBe(false);
	});

	test('CONTROL: both accept the intact update, so neither is refusing everything', () => {
		// Without this, the test above passes for a check that refuses its own
		// input, which is broken rather than strict.
		const valid = sample(50);

		expect(acceptsByStateVector(valid)).toBe(true);
		expect(acceptsByDiff(valid)).toBe(true);
		expect(receiverSurvives(undefined, valid)).toBe(true);
	});
});

describe('no authority-side check closes the poison pill', () => {
	test('bytes exist that EVERY check accepts and a receiver still throws on', () => {
		// The claim the memo makes, refuted. Corruption inside an increment fails
		// when it is integrated against structs the receiver holds, and the
		// authority holds none, so the failing step is one it cannot run.
		const { seed, increment } = incrementOverSeed();
		const survivors = mutations(increment).filter(
			(candidate) =>
				!receiverSurvives(seed, candidate) &&
				acceptsByDiff(candidate) &&
				acceptsByThrowawayDocument(candidate),
		);

		expect(survivors.length).toBeGreaterThan(0);
	});

	test('CONTROL: the same sweep contains bytes every check correctly refuses', () => {
		// Without this the test above would also pass if every check accepted
		// everything, which would make the comparison meaningless rather than
		// alarming.
		const { seed, increment } = incrementOverSeed();
		const refused = mutations(increment).filter(
			(candidate) =>
				!receiverSurvives(seed, candidate) && !acceptsByDiff(candidate),
		);

		expect(refused.length).toBeGreaterThan(0);
	});
});

describe('the best filter available was still only a filter', () => {
	test('diff leaks strictly less than the state vector, on both shapes', () => {
		const full = measure(sample(20), undefined);
		const { seed, increment } = incrementOverSeed();
		const incremental = measure(increment, seed);

		expect(full.unsafe).toBeGreaterThan(0);
		expect(incremental.unsafe).toBeGreaterThan(0);
		expect(full.diff).toBeLessThan(full.stateVector);
		expect(incremental.diff).toBeLessThan(incremental.stateVector);
	});

	test('holding a document buys nothing over diff on an increment', () => {
		// The measurement that ends the argument. If integrating into a throwaway
		// `Y.Doc` were meaningfully stronger, the authority holding one for the
		// length of one call would be worth arguing about. It is not: on the shape
		// the transport actually carries, the two are within a hair of each other
		// and both leak. There is no ceiling to climb to, which is what makes
		// "check harder on the server" a dead end rather than an unfinished one.
		const { seed, increment } = incrementOverSeed();
		const leaks = measure(increment, seed);

		expect(leaks.document).toBeGreaterThan(0);
		expect(Math.abs(leaks.diff - leaks.document)).toBeLessThanOrEqual(2);
	});

	test('no check ever refuses bytes a receiver would have survived', () => {
		// The direction that would be unforgivable. An over-strict filter refuses
		// a person's real work and reports it as corruption, and unlike a leak it
		// cannot be recovered from by anybody. Both checks are conservative in the
		// safe direction on every mutation swept here.
		const { seed, increment } = incrementOverSeed();
		const overRefusals = mutations(increment).filter(
			(candidate) =>
				receiverSurvives(seed, candidate) && !acceptsByDiff(candidate),
		);

		expect(overRefusals).toHaveLength(0);
	});
});
