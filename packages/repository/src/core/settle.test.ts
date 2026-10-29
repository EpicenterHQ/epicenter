/**
 * Settle Tests
 *
 * `settle` is the one producer of what happened to a path where two
 * histories meet, so every conflict it reports must be in the text.
 *
 * Key behaviors:
 * - a change against an unchanged base lands as is; a repeat lands as nothing
 * - a delete loses to an edit it had not seen; an edit brings a deleted note back
 * - a field both sides set keeps current's value and writes incoming's as a block (D2)
 * - a path created twice, or deleted since base, keeps current and appends incoming whole (D3)
 * - an identical block is never written twice
 * - a pointer is one value: current stays and the loser keeps its oid
 */
import { describe, expect, test } from 'bun:test';
import { findConflicts } from './door.js';
import { parseMarkdown, writePointer } from './markdown.js';
import { settle, withBlock } from './settle.js';

const labels = { current: 'main', incoming: 'alice/laptop' };
const note = (title: string, body = 'body\n') => `---\ntitle: ${title}\n---\n${body}`;

describe('settle', () => {
	test('a change on an unchanged base lands, and a repeat changes nothing', () => {
		expect(settle('a\n', 'a\n', 'b\n', { labels })).toEqual({ text: 'b\n', disposition: 'landed' });
		expect(settle('a\n', 'b\n', 'b\n', { labels })).toEqual({ text: 'b\n', disposition: 'landed' });
		expect(settle('a\n', 'b\n', 'a\n', { labels })).toEqual({ text: 'b\n', disposition: 'landed' });
	});

	test('a delete loses to an edit; an edit restores a deleted note', () => {
		expect(settle('a\n', 'edited\n', null, { labels })).toEqual({ text: 'edited\n', disposition: 'kept-current' });
		expect(settle('a\n', null, 'edited\n', { labels })).toEqual({ text: 'edited\n', disposition: 'restored' });
	});

	test('a field both sides set keeps current and writes incoming as a block (D2)', () => {
		const settled = settle(note('Base'), note('Mine'), note('Theirs'), { labels });
		expect(settled.disposition).toBe('conflict');
		expect(parseMarkdown(settled.text ?? '').data?.fields).toEqual({ title: 'Mine' });
		expect(settled.text).toContain('title: Theirs');
		expect(findConflicts(settled.text ?? '')).toHaveLength(1);
	});

	test('a path created twice or deleted since base holds another note (D3)', () => {
		const twice = settle(null, note('One'), note('Two'), { labels });
		expect(twice.disposition).toBe('different-note');
		expect(twice.text?.startsWith(note('One'))).toBe(true);
		expect(findConflicts(twice.text ?? '')).toEqual([{ line: 5, current: 'main', incoming: 'alice/laptop' }]);
		const reused = settle(note('Old'), note('New'), note('Old', 'edit\n'), { deletedSince: true, labels });
		expect(reused.disposition).toBe('different-note');
	});

	test('an identical block is written once, whoever its labels name', () => {
		const once = settle(null, note('One'), note('Two'), { labels }).text ?? '';
		const again = settle(null, once, note('Two'), { labels: { current: 'main', incoming: 'bob/phone' } }).text ?? '';
		expect(again).toBe(once);
		expect(withBlock('a', 'b\n')).toBe('a\nb\n');
	});

	test('a pointer is one value: current stays, and the loser keeps its oid', () => {
		const ours = writePointer({ oid: 'a'.repeat(64), size: 1 });
		const theirs = writePointer({ oid: 'b'.repeat(64), size: 2 });
		const base = writePointer({ oid: 'c'.repeat(64), size: 3 });
		expect(settle(base, ours, theirs, { labels })).toEqual({ text: ours, disposition: 'kept-current', yours: 'b'.repeat(64) });
	});
});
