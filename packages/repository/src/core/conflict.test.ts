/**
 * Conflict Block Tests
 *
 * One grammar is written by every merge and read by every editor and lint,
 * so what is written must read back exactly, and a note's own text must
 * never open, split or close a block.
 *
 * Key behaviors:
 * - a block reads back with its sections, labels, sides and offsets
 * - section lines that read as delimiters, or as escaped ones, round-trip
 * - escaped text outside a block is never a block; malformed blocks are text
 * - an identical block is written once, whoever its labels name
 */
import { describe, expect, test } from 'bun:test';
import {
	block,
	escapeLines,
	findConflicts,
	type Labels,
	versionOf,
	withBlock,
} from './conflict.js';

const labels: Labels = {
	current: {
		author: 'alice/laptop',
		time: '2026-10-28T14:02:11Z',
		version: '3f2a1c9',
	},
	base: { version: '9b8e7d6' },
	incoming: {
		author: 'bob/phone',
		time: '2026-10-28T14:02:12Z',
		version: '1a2b3c4',
	},
};

describe('the grammar', () => {
	test('a block reads back with its sections, labels and sides', () => {
		const written = block(
			{ current: 'mine\n', base: 'old\n', incoming: 'theirs\n' },
			labels,
		);
		expect(written).toBe(
			'<<<<<<< current alice/laptop 2026-10-28T14:02:11Z 3f2a1c9\nmine\n||||||| base 9b8e7d6\nold\n=======\ntheirs\n>>>>>>> incoming bob/phone 2026-10-28T14:02:12Z 1a2b3c4\n',
		);
		const text = `before\n${written}after\n`;
		const [found] = findConflicts(text);
		expect(found).toMatchObject({
			line: 2,
			current: 'mine\n',
			base: 'old\n',
			incoming: 'theirs\n',
			sides: { current: labels.current, incoming: labels.incoming },
		});
		expect(text.slice(found?.from, found?.to)).toBe(written);
	});

	test('section lines that read as delimiters, escaped or not, round-trip', () => {
		const tricky =
			'<<<<<<< mine\n=======\n||||||| base\n>>>>>>> theirs\n\\=======\n\\\\<<<<<<< x\nplain \\ line\n';
		expect(findConflicts(escapeLines(tricky))).toEqual([]);
		const [found, ...rest] = findConflicts(
			block({ current: tricky, incoming: tricky }, labels),
		);
		expect(rest).toEqual([]);
		expect(found?.current).toBe(tricky);
		expect(found?.incoming).toBe(tricky);
	});

	test('a block missing a delimiter or a label is text', () => {
		for (const text of [
			'<<<<<<< current a t v\nx\n=======\ny\n>>>>>>> incoming b t v\n',
			'<<<<<<< \nx\n||||||| base\n=======\ny\n>>>>>>> b\n',
			'<<<<<<< a\nx\n||||||| base\n=======\ny\n',
		])
			expect(findConflicts(text)).toEqual([]);
	});

	test('a label Epicenter did not write still reads, without sides', () => {
		const [found] = findConflicts(
			'<<<<<<< HEAD\na\n||||||| base\n=======\nb\n>>>>>>> topic\n',
		);
		expect(found?.labels).toEqual({
			current: 'HEAD',
			base: '',
			incoming: 'topic',
		});
		expect(found?.sides).toEqual({ current: null, incoming: null });
	});

	test('label fields hold no whitespace', () => {
		const written = block(
			{ current: '', incoming: 'x\n' },
			{
				current: { author: 'Ada Lovelace', time: '', version: versionOf(null) },
				incoming: labels.incoming,
			},
		);
		expect(findConflicts(written)[0]?.sides.current).toEqual({
			author: 'Ada_Lovelace',
			time: '-',
			version: '-',
		});
	});
});

test('an identical block is written once, whoever its labels name', () => {
	const once = withBlock(
		'note\n',
		block({ current: '', incoming: 'x\n' }, labels),
	);
	const other = {
		...labels,
		incoming: { author: 'carol/tablet', time: 'later', version: 'fff0000' },
		base: { version: 'eee0000' },
	};
	expect(withBlock(once, block({ current: '', incoming: 'x\n' }, other))).toBe(
		once,
	);
	expect(withBlock('a', 'b\n')).toBe('a\nb\n');
});
