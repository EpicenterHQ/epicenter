/**
 * Settle Tests: the cases spike 7 ran through stock Git
 *
 * Spike 7 (`spike-scratch/local-spike-7`, T1 to T3) ran this merge as Git's
 * merge driver between two clones. These are the same notes and edits at the
 * function's edge, with the rules the owner set since: the later arrival
 * wins a key (decision 28), a clash is whole lines (decision 43), and what
 * settle writes is in house style (decision 29). `current` is the side that
 * reached the server first, `incoming` the later arrival.
 *
 * Key behaviors:
 * - T1: different fields both land; one sentence both edited is one whole-line block
 * - T2: one field both set takes the later arrival's value, with no block
 * - T2b: the side named incoming wins, so the driver's rebase swap keeps the later arrival
 * - T3: an edit beats a delete, in both directions
 * - Decision 44: a losing binary write is named from its LFS oid
 */
import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { formatNote, parseRowSource } from '../note/index.js';
import { findConflicts } from './conflict.js';
import { lfsOid } from './hash.js';
import { writePointer } from './pointer.js';
import { conflictSibling, settle, settlePointer } from './settle.js';

const parties = {
	current: { author: 'alice', time: '2026-10-30T10:00:00Z' },
	incoming: { author: 'bob', time: '2026-10-30T10:05:00Z' },
};
const KEYS = ['title', 'status', 'tags'];

/** The seed note of spike 7's `notes/meeting notes.md`. */
const SEED =
	'---\ntitle: Weekly sync\nstatus: draft\ntags:\n  - work\n---\n# Weekly sync\n\nFirst paragraph stays the same.\n\nThe budget is 100 dollars and we ship on Friday.\n\nLast paragraph stays too.\n';

const edit = (text: string, from: string, to: string) => {
	expect(text).toContain(from);
	return text.replace(from, to);
};

describe('spike 7 cases', () => {
	test('T1: different fields both land, and one sentence both edited is one whole-line block', () => {
		const alice = edit(
			edit(SEED, 'status: draft', 'status: review'),
			'100 dollars',
			'150 dollars',
		);
		const bob = edit(
			edit(SEED, '  - work\n', '  - work\n  - planning\n'),
			'100 dollars',
			'200 dollars',
		);
		const settled = settle(SEED, alice, bob, { parties, keys: KEYS });
		expect(settled.blocks).toBe(true);
		const text = settled.text ?? '';
		const { document } = expectOk(parseRowSource(text));
		expect(document.fields).toEqual({
			title: 'Weekly sync',
			status: 'review',
			tags: ['work', 'planning'],
		});
		expect(
			text.startsWith(
				'---\ntitle: Weekly sync\nstatus: review\ntags:\n  - work\n  - planning\n---\n# Weekly sync\n\nFirst paragraph stays the same.\n\n<<<<<<< current alice 2026-10-30T10:00:00Z ',
			),
		).toBe(true);
		expect(text.endsWith('\n\nLast paragraph stays too.\n')).toBe(true);
		const [conflict, ...more] = findConflicts(text);
		expect(more).toEqual([]);
		expect(conflict).toMatchObject({
			current: 'The budget is 150 dollars and we ship on Friday.\n',
			base: 'The budget is 100 dollars and we ship on Friday.\n',
			incoming: 'The budget is 200 dollars and we ship on Friday.\n',
			sides: {
				current: { author: 'alice' },
				incoming: { author: 'bob' },
			},
		});
		// In house style already: formatting again changes nothing.
		expect(expectOk(formatNote(text, KEYS))).toBe(text);
	});

	test('T2: the later arrival takes a field both set, with no block', () => {
		const alice = edit(SEED, 'title: Weekly sync', 'title: From Alice');
		const bob = edit(SEED, 'title: Weekly sync', 'title: From Bob');
		const settled = settle(SEED, alice, bob, { parties, keys: KEYS });
		expect(settled).toEqual({
			text: edit(SEED, 'title: Weekly sync', 'title: From Bob'),
			blocks: false,
		});
		expect(findConflicts(settled.text ?? '')).toEqual([]);
	});

	test('T2b: the side named incoming wins, so a driver that swaps sides on rebase keeps the later arrival', () => {
		const alice = edit(SEED, 'title: Weekly sync', 'title: Alice again');
		const bob = edit(SEED, 'title: Weekly sync', 'title: Bob by rebase');
		// Under `git pull --rebase` Bob's commit is replayed onto Alice's, and the driver passes Bob as incoming.
		expect(settle(SEED, alice, bob, { parties }).text).toContain(
			'title: Bob by rebase',
		);
		expect(settle(SEED, bob, alice, { parties }).text).toContain(
			'title: Alice again',
		);
	});

	test('T3: an edit beats a delete, in both directions', () => {
		const kept =
			'---\ntitle: Kept\n---\nA note one side edits and the other deletes.\n';
		const edited = edit(kept, 'deletes.', 'deletes. Edited by Alice.');
		expect(settle(kept, edited, null, { parties })).toEqual({
			text: edited,
			blocks: false,
		});
		const gone = '---\ntitle: Gone\n---\nThe mirror case.\n';
		const mirrored = edit(gone, 'case.', 'case. Edited by Bob.');
		expect(settle(gone, null, mirrored, { parties })).toEqual({
			text: mirrored,
			blocks: false,
		});
	});
});

describe('house style on what settle writes', () => {
	test('a merged note takes the key order of the contract; without one it keeps the merged order', () => {
		const base = '---\nb: 1\na: 1\n---\nx\n';
		const current = '---\nb: 2\na: 1\n---\nx\n';
		const incoming = "---\nb: 1\na: 'quoted'\nc: [1]\n---\ny\n";
		expect(settle(base, current, incoming, { parties }).text).toBe(
			'---\nb: 2\na: quoted\nc:\n  - 1\n---\ny\n',
		);
		expect(
			settle(base, current, incoming, { parties, keys: ['c', 'a'] }).text,
		).toBe('---\nc:\n  - 1\na: quoted\nb: 2\n---\ny\n');
	});

	test('a write that lands as is is formatted; what already stands is not touched', () => {
		const base = '---\ntitle: a\n---\n';
		const loose = "---\ntitle: 'b'  # quoted\n---\n";
		expect(settle(base, base, loose, { parties }).text).toBe(
			'---\ntitle: b\n---\n',
		);
		expect(settle(base, loose, base, { parties }).text).toBe(loose);
	});

	test('a merged header that does not parse is left as merged', () => {
		const base = '---\na: [\n---\nbody\n';
		const settled = settle(
			base,
			'---\na: [\ndone: true\n---\nbody\n',
			'---\na: [\ndone: false\n---\nbody\n',
			{ parties },
		);
		expect(settled.text).toBe('---\na: [\ndone: false\n---\nbody\n');
	});
});

test('decision 44: a losing binary write lands beside its file, named from its LFS oid', async () => {
	const winner = new TextEncoder().encode('webm bytes from Alice');
	const loser = new TextEncoder().encode('webm bytes from Bob');
	const base = writePointer({
		oid: await lfsOid(new Uint8Array([0])),
		size: 1,
	});
	const current = writePointer({
		oid: await lfsOid(winner),
		size: winner.length,
	});
	const oid = await lfsOid(loser);
	const incoming = writePointer({ oid, size: loser.length });
	expect(settlePointer(base, current, incoming)).toEqual({ lost: true });
	expect(conflictSibling('recordings/a.webm', oid)).toBe(
		`recordings/a (conflict ${oid.slice(0, 7)}).webm`,
	);
});
