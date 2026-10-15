/**
 * KV merge vectors (`fixtures/kv-merge.json`).
 * Tests distinguish independent edits from competing root values, preserve
 * unknown numeric tokens, and pin parser eligibility and Unicode behavior.
 * Successful output must be identical when the two editing sides swap.
 */
import { expect, test } from 'bun:test';
import { type KvMergeInput, mergeKv, reconcileKv } from './kv-merge.js';

const cases: (KvMergeInput & { name: string; expected: unknown })[] =
	await Bun.file(new URL('../fixtures/kv-merge.json', import.meta.url)).json();

for (const fixture of cases) {
	test(fixture.name, () => {
		const result = mergeKv(fixture);
		expect<unknown>(result).toEqual(fixture.expected);
		if (result.kind === 'merged' || result.kind === 'file-conflict') {
			expect(
				mergeKv({
					base: fixture.base,
					ours: fixture.theirs,
					theirs: fixture.ours,
				}),
			).toEqual(result);
		}
		if (result.kind === 'merged') {
			expect(
				mergeKv({
					base: result.text,
					ours: result.text,
					theirs: result.text,
				}),
			).toEqual(result);
		}
		if (result.kind === 'conflict') {
			expect(
				mergeKv({
					base: fixture.base,
					ours: fixture.theirs,
					theirs: fixture.ours,
				}),
			).toEqual({
				kind: 'conflict',
				conflicts: result.conflicts.map(({ key, base, ours, theirs }) => ({
					key,
					base,
					ours: theirs,
					theirs: ours,
				})),
			});
		}
	});
}

test('an unpaired UTF-16 code unit in source is refused', () => {
	expect(mergeKv({ base: '{}', ours: '{"x":"\uD800"}', theirs: '{}' })).toEqual(
		{ kind: 'invalid', side: 'ours' },
	);
});

test.each([
	'{"x": /* " */ ',
	'{"x": "\n, "y": ',
	'{"x":[},',
])('malformed parser recovery cannot bypass the depth bound: %s', (prefix) => {
	const source = prefix + '['.repeat(100_000) + '0' + ']'.repeat(100_000) + '}';
	expect(mergeKv({ base: '{}', ours: source, theirs: '{}' })).toEqual({
		kind: 'invalid',
		side: 'ours',
	});
});

test('mismatched brackets cannot cancel nested arrays during recovery', () => {
	const source =
		'{"x":[' + '},['.repeat(100_000) + '0' + ']'.repeat(100_001) + '}';
	expect(mergeKv({ base: '{}', ours: source, theirs: '{}' })).toEqual({
		kind: 'invalid',
		side: 'ours',
	});
});

test('settled keys apply only where they compete, and the rest merges', () => {
	const input = {
		base: '{"theme":"light","size":1,"font":"serif"}',
		ours: '{"theme":"dark","size":2.0,"font":"serif"}',
		theirs: '{"theme":"sepia","size":3,"font":"mono"}',
	};
	expect(reconcileKv(input, new Map([['theme', '"sepia"']]))).toEqual({
		kind: 'conflict',
		conflicts: [{ key: 'size', base: '1', ours: '2.0', theirs: '3' }],
	});
	expect(
		reconcileKv(
			input,
			new Map([
				['theme', null],
				['size', '2.0'],
				['font', '"ignored"'],
			]),
		),
	).toEqual({
		kind: 'merged',
		text: '{\n  "font": "mono",\n  "size": 2.0\n}\n',
	});
});
