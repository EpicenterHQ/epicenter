/**
 * Settle Tests
 *
 * `settle` is the one producer of what happened to a path where two
 * histories meet, so every conflict block it reports must be in the text.
 *
 * Key behaviors:
 * - a change against an unchanged base lands as is; a repeat lands as nothing
 * - a delete loses to an edit it had not seen; an edit brings a deleted note back
 * - a field both sides set takes the later write's value (incoming, arriving now, over main's), with no block
 * - a path created twice keeps current and appends incoming whole (D3); a recreated note merges by content
 * - an identical block is never written twice
 *
 * Ported from `claude/repository-v2` `core/settle.test.ts` at `c32dd466`;
 * v2's key patcher is replaced by the texts it wrote.
 */
import { describe, expect, test } from 'bun:test';
import { findConflicts } from './conflict.js';
import { conflictSibling, settle, settlePointer } from './settle.js';

const parties = {
	current: { author: 'main', time: 't1' },
	incoming: { author: 'alice/laptop', time: 't2' },
};
const note = (title: string, body = 'body\n') =>
	`---\ntitle: ${title}\n---\n${body}`;

describe('settle', () => {
	test('a change on an unchanged base lands, and a repeat changes nothing', () => {
		expect(settle('a\n', 'a\n', 'b\n', { parties })).toEqual({
			text: 'b\n',
			blocks: false,
		});
		expect(settle('a\n', 'b\n', 'b\n', { parties })).toEqual({
			text: 'b\n',
			blocks: false,
		});
		expect(settle('a\n', 'b\n', 'a\n', { parties })).toEqual({
			text: 'b\n',
			blocks: false,
		});
	});

	test('a delete loses to an edit; an edit restores a deleted note', () => {
		expect(settle('a\n', 'edited\n', null, { parties })).toEqual({
			text: 'edited\n',
			blocks: false,
		});
		expect(settle('a\n', null, 'edited\n', { parties })).toEqual({
			text: 'edited\n',
			blocks: false,
		});
	});

	test("a field both sides set takes the later write's value, incoming's over main's, with no block", () => {
		expect(
			settle(note('Base'), note('Mine'), note('Theirs'), { parties }),
		).toEqual({ text: note('Theirs'), blocks: false });
	});

	test("a block in the body is body: a field's later write leaves it as it was", () => {
		const held =
			'<<<<<<< current main - 44bb5a0 typed\nmood: A\n||||||| base ea98c42\n=======\nmood: B\n>>>>>>> incoming alice/laptop t0 8bb3865\n';
		const fields = (mood: string) => `---\nmood: ${mood}\n---\n${held}`;
		expect(
			settle(fields('A'), fields('Mine'), fields('Theirs'), { parties }),
		).toEqual({ text: fields('Theirs'), blocks: false });
	});

	test("two patches of one key at once on a note whose header does not parse: the later write's value, no block, never a duplicate key", () => {
		const broken = '---\na: [\n---\nbody\n';
		const settled = settle(
			broken,
			'---\na: [\ndone: true\n---\nbody\n',
			'---\na: [\ndone: false\n---\nbody\n',
			{ parties },
		);
		expect(settled).toEqual({
			text: '---\na: [\ndone: false\n---\nbody\n',
			blocks: false,
		});
	});

	test('a path created twice holds another note (D3); one deleted and created again merges by content', () => {
		const twice = settle(null, note('One'), note('Two'), { parties });
		expect(twice.blocks).toBe(true);
		expect(twice.text?.startsWith(note('One'))).toBe(true);
		expect(findConflicts(twice.text ?? '')).toMatchObject([
			{
				line: 5,
				current: '',
				incoming: note('Two'),
				sides: { incoming: { author: 'alice/laptop', time: 't2' } },
			},
		]);
		// Nothing tells a note made again from the one a base names: it merges as an edit of it (the accepted oddity).
		const reused = settle(note('Old'), note('New'), note('Old', 'edit\n'), {
			parties,
		});
		expect(reused).toEqual({ text: note('New', 'edit\n'), blocks: false });
	});

	test('an identical block is written once, whoever its labels name', () => {
		const once = settle(null, note('One'), note('Two'), { parties }).text ?? '';
		const again =
			settle(null, once, note('Two'), {
				parties: {
					current: parties.current,
					incoming: { author: 'bob/phone', time: 't3' },
				},
			}).text ?? '';
		expect(again).toBe(once);
	});
});

describe('decision 15: two different insertions at one spot are one clash, as in diff3', () => {
	test('two words added at the end of one line are one whole-line block, never "now later"', () => {
		const settled = settle(
			'Pay Alice\n',
			'Pay Alice now\n',
			'Pay Alice later\n',
			{
				parties,
			},
		);
		expect(settled.blocks).toBe(true);
		expect(settled.text).not.toContain('now later');
		const [conflict, ...more] = findConflicts(settled.text ?? '');
		expect(more).toEqual([]);
		expect(conflict).toMatchObject({
			current: 'Pay Alice now\n',
			base: 'Pay Alice\n',
			incoming: 'Pay Alice later\n',
		});
		// With no final newline, the same.
		const bare = settle('Pay Alice', 'Pay Alice now', 'Pay Alice later', {
			parties,
		});
		expect(bare.blocks).toBe(true);
		expect(findConflicts(bare.text ?? '')).toHaveLength(1);
	});

	test('two different lines appended after one line are one block', () => {
		const settled = settle('a\n', 'a\nb\n', 'a\nc\n', { parties });
		expect(settled.blocks).toBe(true);
		const [conflict, ...more] = findConflicts(settled.text ?? '');
		expect(more).toEqual([]);
		expect(conflict).toMatchObject({
			current: 'b\n',
			base: '',
			incoming: 'c\n',
		});
		expect(settled.text?.startsWith('a\n<<<<<<< ')).toBe(true);
	});

	test('identical insertions merge as one', () => {
		expect(settle('a\n', 'a\nb\n', 'a\nb\n', { parties })).toEqual({
			text: 'a\nb\n',
			blocks: false,
		});
		expect(
			settle('Pay Alice\n', 'Pay Alice now\n', 'Pay Alice now\n', { parties }),
		).toEqual({ text: 'Pay Alice now\n', blocks: false });
	});

	test('edits of different, non-adjacent words on one line still merge with no block', () => {
		expect(
			settle(
				'Pay Alice ten dollars today\n',
				'Pay Bob ten dollars today\n',
				'Pay Alice ten dollars tomorrow\n',
				{
					parties,
				},
			),
		).toEqual({ text: 'Pay Bob ten dollars tomorrow\n', blocks: false });
	});
});

describe('settlePointer: a blob write lands only over the blob its writer saw', () => {
	const [a, b, c] = ['pointer a', 'pointer b', 'pointer c'];
	test('create, replace and delete land where nothing moved', () => {
		expect(settlePointer(null, null, a)).toEqual({ text: a });
		expect(settlePointer(a, a, b)).toEqual({ text: b });
		expect(settlePointer(a, a, null)).toEqual({ text: null });
	});
	test('a create over a file added elsewhere is lost, unless it is the same bytes', () => {
		expect(settlePointer(null, b, a)).toEqual({ lost: true });
		expect(settlePointer(null, a, a)).toEqual({ text: a });
	});
	test('a replace over a file that changed is lost', () => {
		expect(settlePointer(a, b, c)).toEqual({ lost: true });
	});
	test('a replace over a file that went brings it back: an edit beats a delete (decision 15)', () => {
		expect(settlePointer(a, null, c)).toEqual({ text: c });
	});
	test('a delete that does not land leaves the file, with no refusal', () => {
		expect(settlePointer(a, b, null)).toEqual({ text: b });
	});
	test('a delete then a create at one path are two writes that each pass', () => {
		expect(settlePointer(a, a, null)).toEqual({ text: null });
		expect(settlePointer(null, null, b)).toEqual({ text: b });
	});
	test('a lost write is named beside its file from the original stem and its bytes, the stem shortened to fit', () => {
		const oid = 'abcdef0123'.repeat(6).slice(0, 64);
		expect(conflictSibling('photos/cat.png', oid)).toBe(
			'photos/cat (conflict abcdef0).png',
		);
		expect(conflictSibling('photos/cat (conflict 1234567).png', oid)).toBe(
			'photos/cat (conflict abcdef0).png',
		);
		expect(conflictSibling('README', oid, 8)).toBe(
			'README (conflict abcdef01)',
		);
		expect(conflictSibling('.env.local', oid)).toBe(
			'.env (conflict abcdef0).local',
		);
		const long = conflictSibling(`a/${'é'.repeat(200)}.webm`, oid);
		expect(new TextEncoder().encode(long.slice(2)).length).toBeLessThanOrEqual(
			255,
		);
		expect(long.endsWith(' (conflict abcdef0).webm')).toBe(true);
		expect(
			new TextEncoder().encode(
				conflictSibling(`${'d'.repeat(480)}/x.webm`, oid, 7, 512),
			).length,
		).toBeLessThanOrEqual(512);
	});
	test('a path the writer did not change keeps what is there', () => {
		expect(settlePointer(a, b, a)).toEqual({ text: b });
	});
});
