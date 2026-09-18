/**
 * What the CRDT actually buys, field by field.
 *
 * The entire tombstone problem, and with it generations, rebuilds, migration,
 * frozen generations and retention windows, exists because rows live in a CRDT.
 * That is worth paying for only where a CRDT does something a simpler rule
 * cannot. So: measure where it does.
 *
 * The answer splits cleanly, and not where you would guess.
 *
 * - **Value fields get last-writer-wins already.** A Yjs map discards one of
 *   two concurrent writes to the same key, exactly as a plain timestamped table
 *   would, and the survivor is chosen by clientID ordering rather than by who
 *   edited last. It is a coin flip, not a merge.
 * - **A node genuinely merges.** Two concurrent insertions into one string both
 *   survive, interleaved correctly. No last-writer-wins scheme can do this.
 *
 * So for a row's values the CRDT provides a marginally different tie-break and
 * charges the whole tombstone machine for it. Pinned because "we need a CRDT
 * for rows" is an assumption nobody re-examines once it is in the walls.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import { putRow, rowAt, type ValuesType } from './raw-document.js';

function sync(a: Y.Doc, b: Y.Doc): void {
	const fromA = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b));
	const fromB = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a));
	Y.applyUpdateV2(b, fromA);
	Y.applyUpdateV2(a, fromB);
}

/** Two devices holding one row, already synchronised. */
function pair() {
	const phone = new Y.Doc({ gc: true });
	const laptop = new Y.Doc({ gc: true });
	phone.transact(() => {
		const row: ValuesType = new Y.Type();
		putRow(phone.get('notes'), 'n1', row);
		row.setAttr('title', 'original');
		row.setAttr('tags', ['a']);
	});
	sync(phone, laptop);
	const row = (doc: Y.Doc): ValuesType => {
		const found = rowAt(doc.get('notes'), 'n1');
		if (found === undefined) throw new Error('the row is gone');
		return found;
	};
	return { phone, laptop, row };
}

describe('a row of values', () => {
	test('DIFFERENT fields merge, which a per-field table also does', () => {
		const { phone, laptop, row } = pair();
		phone.transact(() => row(phone).setAttr('title', 'from phone'));
		laptop.transact(() => row(laptop).setAttr('tags', ['b']));
		sync(phone, laptop);

		expect(row(phone).getAttrs()).toEqual({ title: 'from phone', tags: ['b'] });
	});

	test('the SAME field discards one write, exactly like last-writer-wins', () => {
		// The measurement that matters. A CRDT is worth its cost where "both" is a
		// sensible answer. Here it is not: one edit is thrown away, and the only
		// question is which.
		const { phone, laptop, row } = pair();
		phone.transact(() => row(phone).setAttr('title', 'from the phone'));
		laptop.transact(() => row(laptop).setAttr('title', 'from the laptop'));
		sync(phone, laptop);

		const survivor = row(phone).getAttr('title');
		if (typeof survivor !== 'string') throw new Error('the title is gone');
		expect(row(laptop).getAttr('title')).toEqual(survivor);
		expect(['from the phone', 'from the laptop']).toContain(survivor);
	});

	test('and the survivor is a coin flip, not the later edit', () => {
		// Worth stating plainly, because "the CRDT resolves it properly" is the
		// belief this replaces. The winner is whichever document happened to mint
		// the higher clientID. A wall-clock timestamp would at least mean the
		// later edit wins, which is what a person expects.
		let phoneWon = 0;
		const rounds = 40;
		for (let round = 0; round < rounds; round += 1) {
			const { phone, laptop, row } = pair();
			phone.transact(() => row(phone).setAttr('title', 'phone'));
			laptop.transact(() => row(laptop).setAttr('title', 'laptop'));
			sync(phone, laptop);
			if (row(phone).getAttr('title') === 'phone') phoneWon += 1;
		}

		// Neither side is systematically favoured, which is what makes it
		// arbitrary rather than a rule anyone could rely on.
		expect(phoneWon).toBeGreaterThan(0);
		expect(phoneWon).toBeLessThan(rounds);
	});
});

describe('a node, where a CRDT does something nothing else can', () => {
	test('two concurrent insertions BOTH survive, interleaved correctly', () => {
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		const text = (doc: Y.Doc) => doc.get('body', 'text');
		phone.transact(() =>
			text(phone).applyDelta(text(phone).change.insert('hello world') as never),
		);
		sync(phone, laptop);

		phone.transact(() =>
			text(phone).applyDelta(
				text(phone).change.retain(5).insert(' beautiful') as never,
			),
		);
		laptop.transact(() =>
			text(laptop).applyDelta(
				text(laptop).change.retain(11).insert('!!!') as never,
			),
		);
		sync(phone, laptop);

		// Compared on CONTENT rather than on `toJSON`, which also carries the
		// type's name: a root minted by a remote update keeps no name, so the
		// laptop's copy has none and the phone's does. That is a separate pinned
		// property (`invariants.test.ts`) and asserting through it here would fail
		// for a reason that has nothing to do with merging.
		const content = (doc: Y.Doc) =>
			JSON.stringify(
				(text(doc).toJSON() as unknown as { children?: unknown }).children,
			);
		expect(content(phone)).toBe(content(laptop));
		// Both edits are present in one string. This is the thing a row's value
		// fields never get, and the reason a node has to stay a CRDT whatever
		// happens to rows.
		expect(content(phone)).toContain('beautiful');
		expect(content(phone)).toContain('!!!');
	});
});
