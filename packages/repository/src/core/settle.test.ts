/**
 * Settle Tests
 *
 * `settle` is the one producer of what happened to a path where two
 * histories meet, so every conflict block it reports must be in the text.
 *
 * Key behaviors:
 * - a change against an unchanged base lands as is; a repeat lands as nothing
 * - a delete loses to an edit it had not seen; an edit brings a deleted note back
 * - a field both sides set keeps current's value and writes incoming's as a block (D2);  a later edit of that field continues the block, unless the writer had seen it
 * - a path created twice, or deleted since base, keeps current and appends incoming whole (D3)
 * - an identical block is never written twice
 */
import { describe, expect, test } from 'bun:test';
import { findConflicts } from './conflict.js';
import { parseMarkdown } from './markdown.js';
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

	test('a field both sides set keeps current and writes incoming as a block (D2)', () => {
		const settled = settle(note('Base'), note('Mine'), note('Theirs'), {
			parties,
		});
		expect(settled.blocks).toBe(true);
		expect(parseMarkdown(settled.text ?? '').fields).toEqual({ title: 'Mine' });
		expect(settled.text).toContain('title: Theirs');
		expect(findConflicts(settled.text ?? '')).toHaveLength(1);
	});

	test("a later edit of a field a block already offers continues that block's side", () => {
		const first =
			settle(note('Base'), note('Mine'), note('Theirs'), { parties }).text ??
			'';
		const second = settle(note('Theirs'), first, note('Theirs again'), {
			parties: { ...parties, incoming: { author: 'alice/laptop', time: 't3' } },
		});
		expect(second.blocks).toBe(true);
		expect(parseMarkdown(second.text ?? '').fields).toEqual({ title: 'Mine' });
		expect(findConflicts(second.text ?? '')).toMatchObject([
			{
				current: 'title: Mine\n',
				base: 'title: Base\n',
				incoming: 'title: Theirs again\n',
				sides: { incoming: { time: 't3' } },
			},
		]);
	});

	test("a field's block the writer had already seen is not continued: their edit of the field is a clash of its own, and the block stays as they left it", () => {
		// Minimized from wire seed 17014: the writer's base already held a block offering mood: A, with text typed on its opening line.
		const held =
			'<<<<<<< current main - 44bb5a0 typed\nmood: A\n||||||| base ea98c42\n=======\nmood: B\n>>>>>>> incoming alice/laptop t0 8bb3865\n';
		const fields = (mood: string) => `---\nmood: ${mood}\n---\n${held}`;
		const settled =
			settle(fields('A'), fields('Mine'), fields('Theirs'), { parties }).text ??
			'';
		expect(settled).toContain(held);
		expect(settled).toContain('mood: Theirs');
		expect(findConflicts(settled)).toHaveLength(2);
	});

	test('a path created twice or deleted since base holds another note (D3)', () => {
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
		const reused = settle(note('Old'), note('New'), note('Old', 'edit\n'), {
			deletedSince: true,
			parties,
		});
		expect(reused.blocks).toBe(true);
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
	test('a replace over a file that changed or went is lost', () => {
		expect(settlePointer(a, b, c)).toEqual({ lost: true });
		expect(settlePointer(a, null, c)).toEqual({ lost: true });
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
