/**
 * Epicenter Merge Tests
 *
 * Ported from the merge spike: examples for each rule in ADR-0692, then
 * seeded properties over 2,500 Markdown-like triples each. The properties are
 * what make the rules trustworthy: independent edits survive exactly once,
 * output never blends tokens, and each overlap is one well-formed block, never nested.
 *
 * Key behaviors:
 * - Neighboring line edits, separate sentence edits and same-point appends merge
 * - A true overlap is reported, never blended (cat/cart/coat)
 * - The header merges by top-level key, each value whole; a key both sides set takes the later write's (incoming, arriving now, over current, main's); a key's unseen delete loses; comments stay
 * - A top block that does not parse is body: a header written over it merges as added keys, never a duplicate
 * - Two creates merge fields and keep both bodies; both they and delete versus edit are reported
 * - An edit of lines a block offers as a side continues that side: one clash is one block, however many writes follow
 * - Any other overlap touching an existing block adds a separate, adjacent block; blocks never nest
 * - Large notes merge in bounded memory
 *
 * Ported from `claude/repository-v2` `core/merge.test.ts` at `c32dd466`. Its
 * last section, seeded properties built with v2's Markdown writer, is
 * replaced by `merge.properties.test.ts`, which builds notes with the house
 * style codec this package keeps.
 */
import { describe, expect, test } from 'bun:test';
import { parseRowSource } from '../note/index.js';
import { findConflicts, type Labels } from './conflict.js';
import { type ContentOverlap, merge, withBlocks } from './merge.js';

const labels: Labels = {
	current: { author: 'alice', time: 't1', version: 'c1' },
	base: { version: 'b1' },
	incoming: { author: 'bob', time: 't2', version: 'i1' },
};
/** The delimiter lines `labels` writes. */
const OPEN = '<<<<<<< current alice t1 c1\n';
const BASE = '||||||| base b1\n';
const CLOSE = '>>>>>>> incoming bob t2 i1\n';
/** Body and block overlaps: the ones with spans in the text. */
const spans = (overlaps: ContentOverlap[]) =>
	overlaps.flatMap((o) => (o.unit === 'body' || o.unit === 'block' ? [o] : []));

describe('examples', () => {
	test('adjacent checkbox edits both survive', () => {
		const r = merge(
			'- [ ] a\n- [ ] b\n',
			'- [x] a\n- [ ] b\n',
			'- [ ] a\n- [x] b\n',
		);
		expect(r.text).toBe('- [x] a\n- [x] b\n');
		expect(r.overlaps).toHaveLength(0);
	});

	test('adjacent line edits both survive', () => {
		const r = merge('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n');
		expect(r.text).toBe('a\nB\nC\n');
		expect(r.overlaps).toHaveLength(0);
	});

	test('separate sentence edits in one paragraph both survive', () => {
		const r = merge(
			'One. Two. Three.\n',
			'One! Two. Three.\n',
			'One. Two. Three!\n',
		);
		expect(r.text).toBe('One! Two. Three!\n');
		expect(r.overlaps).toHaveLength(0);
	});

	test('simultaneous end bullets keep current then incoming', () => {
		const r = merge('- x\n', '- x\n- y\n', '- x\n- z\n');
		expect(r.text).toBe('- x\n- y\n- z\n');
		expect(r.overlaps).toHaveLength(0);
	});

	test('same-point additions after an unterminated line remain separate', () => {
		const r = merge('a', 'a\nb', 'a\nc');
		expect(r.text).toBe('a\nb\nc');
		expect(r.overlaps).toHaveLength(0);
	});

	test('same-point additions where current ends unterminated stay on their own lines', () => {
		expect(merge('', 'b', 'c\n').text).toBe('b\nc\n');
		// An existing block current did not have lands on a line of its own, so it still reads as a block (property seed W 29).
		const head = '---\ntitle: a\n---\n';
		const block =
			'<<<<<<< current c - -\n||||||| base -\n=======\nold\n>>>>>>> incoming b - -\n';
		const r = merge(head, `${head}t57z`, `${head}${block}`);
		expect(r.text).toBe(`${head}t57z\n${block}`);
		expect(findConflicts(r.text ?? '')).toHaveLength(1);
	});

	test('a word both sides kept is kept once: whitespace never anchors a side ahead of a word (property seed B 621772)', () => {
		// Current drops the leading space; incoming replaces it with a line. Both keep "a".
		const r = merge(' a', 'a b', 'c\na d');
		expect((r.text ?? '').match(/\ba\b/g)).toHaveLength(1);
		expect(r.text).not.toContain('ac');
	});

	test('a line one side ends unterminated stays its own line when the other side adds after it', () => {
		// Incoming rewrites the last line and leaves it unterminated; current adds a line after it (property seed B 601077).
		expect(merge('agent\n', 'agent\nadded\n', 'changed\nt58z').text).toBe(
			'changed\nt58z\nadded\n',
		);
	});

	test('cat/cart/coat reports a whole-word overlap without coart', () => {
		const r = merge('cat\n', 'cart\n', 'coat\n');
		expect(r.overlaps).toHaveLength(1);
		expect(r.text).toBe('cart\n');
		expect(r.text).not.toContain('coart');
	});

	test("a key both sides set takes the later write's value: incoming, arriving now, over current, main's; no clash", () => {
		const r = merge(
			'---\ntitle: Old\ntags: a\n---\nBody\n',
			'---\ntitle: Current\ntags: a\n---\nBody\n',
			'---\ntitle: Incoming\ntags: b\n---\nBody\n',
		);
		expect(r.text).toBe('---\ntitle: Incoming\ntags: b\n---\nBody\n');
		expect(r.overlaps).toEqual([]);
	});

	test('frontmatter compares parsed values, so formatting is not a clash', () => {
		const r = merge(
			'---\na: 1\nb: x\n---\n',
			"---\na: 1\nb: 'x'  # quoted\n---\n",
			'---\na: 2\nb: x\n---\n',
		);
		expect(r.text).toBe("---\na: 2\nb: 'x'  # quoted\n---\n");
		expect(r.overlaps).toEqual([]);
	});

	test('a settings-style set on each side merges by key', () => {
		const base = '---\ntheme: light\n---\n';
		const r = merge(
			base,
			'---\ntheme: dark\n---\n',
			'---\ntheme: light\nfont: serif\n---\n',
		);
		expect(r.text).toBe('---\ntheme: dark\nfont: serif\n---\n');
	});

	test('a key removed on one side is removed', () => {
		const r = merge(
			'---\na: 1\nb: 2\n---\n',
			'---\na: 1\n---\n',
			'---\na: 1\nb: 2\nc: 3\n---\n',
		);
		expect(r.text).toBe('---\na: 1\nc: 3\n---\n');
	});

	test('a key deleted on one side and changed on the other keeps the change', () => {
		// Probe: current's unseen delete used to win, unlike the file-level rule.
		const r = merge(
			'---\nstatus: a\ntitle: t\n---\nx\n',
			'---\ntitle: t\n---\nx\n',
			'---\nstatus: b\ntitle: t\n---\nx\n',
		);
		expect(r.text).toBe('---\ntitle: t\nstatus: b\n---\nx\n');
		expect(r.overlaps).toEqual([]);
		const other = merge(
			'---\nstatus: a\ntitle: t\n---\nx\n',
			'---\nstatus: c\ntitle: t\n---\nx\n',
			'---\ntitle: t\n---\nx\n',
		);
		expect(other.text).toBe('---\nstatus: c\ntitle: t\n---\nx\n');
		expect(other.overlaps).toEqual([]);
	});

	test('two offline creates merge fields, keep both bodies and report the clash', () => {
		const r = merge(
			null,
			'---\nweather: sun\n---\nMorning',
			'---\nmood: good\n---\nEvening',
		);
		expect(r.text).toBe(
			'---\nweather: sun\nmood: good\n---\nMorning\n\nEvening',
		);
		expect(r.overlaps).toEqual([{ unit: 'file', clash: 'created' }]);
	});

	test("two creates with a clashing field take the later write's value and report the create", () => {
		const r = merge(
			null,
			'---\nstatus: a\n---\nbody c\n',
			'---\nstatus: b\n---\nbody i\n',
		);
		expect(r.text).toBe('---\nstatus: b\n---\nbody c\n\nbody i\n');
		expect(r.overlaps).toEqual([{ unit: 'file', clash: 'created' }]);
	});

	test('two identical creates are one file', () => {
		expect(merge(null, 'Same\n', 'Same\n').text).toBe('Same\n');
	});

	test('delete versus edit returns the edit and names the deleted side', () => {
		expect(merge('before', null, 'edited')).toEqual({
			text: 'edited',
			overlaps: [{ unit: 'file', clash: 'deleted', side: 'current' }],
		});
		expect(merge('before', 'edited', null)).toEqual({
			text: 'edited',
			overlaps: [{ unit: 'file', clash: 'deleted', side: 'incoming' }],
		});
	});

	test('a one-sided create is no overlap', () => {
		expect(merge(null, null, 'New\n')).toEqual({ text: 'New\n', overlaps: [] });
	});

	test('CRLF output follows current for independent edits', () => {
		expect(merge('a\nb\n', 'A\r\nb\r\n', 'a\nB\n').text).toBe('A\r\nB\r\n');
	});

	test('a true overlap gets a labelled conflict block with a base section', () => {
		const marked = withBlocks(merge('cat\n', 'cart\n', 'coat\n'), labels);
		expect(marked).toBe(`${OPEN}cart\n${BASE}cat\n=======\ncoat\n${CLOSE}`);
		expect(findConflicts(marked ?? '')).toMatchObject([
			{ current: 'cart\n', base: 'cat\n', incoming: 'coat\n' },
		]);
	});

	test('section lines that read as delimiters are escaped, and read back as written', () => {
		const marked =
			withBlocks(merge('a\n', '=======\n', '>>>>>>> x\n'), labels) ?? '';
		expect(marked).toBe(
			`${OPEN}\\=======\n${BASE}a\n=======\n\\>>>>>>> x\n${CLOSE}`,
		);
		expect(findConflicts(marked)).toMatchObject([
			{ current: '=======\n', incoming: '>>>>>>> x\n' },
		]);
	});

	test('an overlap in a body after frontmatter has offsets past the header', () => {
		const r = merge(
			'---\na: 1\n---\ncat\n',
			'---\na: 1\n---\ncart\n',
			'---\na: 2\n---\ncoat\n',
		);
		expect(r.text).toBe('---\na: 2\n---\ncart\n');
		const [overlap] = spans(r.overlaps);
		expect(r.text?.slice(overlap?.start, overlap?.end)).toBe('cart');
		expect(withBlocks(r, labels)).toBe(
			`---\na: 2\n---\n${OPEN}cart\n${BASE}cat\n=======\ncoat\n${CLOSE}`,
		);
	});

	test('CRLF overlap blocks use current line endings and offsets', () => {
		const r = merge('a\ncat\n', 'a\r\ncart\r\n', 'a\ncoat\n');
		expect(r.text).toBe('a\r\ncart\r\n');
		expect(withBlocks(r, labels)).toBe(
			`a\n${OPEN}cart\n${BASE}cat\n=======\ncoat\n${CLOSE}`.replaceAll(
				'\n',
				'\r\n',
			),
		);
	});

	test('a further edit of an existing block adds a separate block, never a nested one', () => {
		const first = withBlocks(merge('cat\n', 'cart\n', 'coat\n'), labels) ?? '';
		const r = merge('cat\n', first, 'cut\n');
		expect(r.overlaps).toMatchObject([{ unit: 'block' }]);
		const marked = withBlocks(r, labels) ?? '';
		expect(marked).toBe(`${OPEN}${BASE}cat\n=======\ncut\n${CLOSE}${first}`);
		const blocks = findConflicts(marked);
		expect(blocks).toHaveLength(2);
		for (const block of blocks)
			expect(block.current + block.incoming).not.toContain('<<<<<<< ');
	});

	test('one clash is one block: an edit of lines a block offers as a side continues that side, however many writes follow', () => {
		// Bob's oneR met Alice's oneA; Alice's later writes were made from oneA, then oneAB.
		const first = withBlocks(merge('one\n', 'oneR\n', 'oneA\n'), labels) ?? '';
		const later = {
			...labels,
			incoming: { author: 'alice', time: 't3', version: 'i2' },
		};
		const second =
			withBlocks(
				merge('intro\noneA\n', `intro\n${first}`, 'intro\noneAB\n'),
				later,
			) ?? '';
		expect(second).toBe(
			`intro\n${OPEN}oneR\n${BASE}one\n=======\noneAB\n>>>>>>> incoming alice t3 i2\n`,
		);
		const third =
			withBlocks(merge('intro\noneAB\n', second, 'intro\noneABC\n'), later) ??
			'';
		expect(findConflicts(third)).toMatchObject([
			{ current: 'oneR\n', base: 'one\n', incoming: 'oneABC\n' },
		]);
		// The block may be on either side: here the writer's own text holds it, and main edited the line it offers.
		const mirrored =
			withBlocks(merge('oneR\n', 'oneRS\n', first), labels) ?? '';
		expect(mirrored).toBe(`${OPEN}oneRS\n${BASE}one\n=======\noneA\n${CLOSE}`);
	});

	test("continuing a block's side keeps text typed on its delimiter line", () => {
		const block =
			'<<<<<<< current bob t1 c1 typed here\noneR\n||||||| base b1\none\n=======\noneA\n>>>>>>> incoming alice t0 i0\n';
		const continued =
			withBlocks(merge('oneR\n', block, 'oneRS\n'), labels) ?? '';
		expect(findConflicts(continued)).toMatchObject([
			{
				current: 'oneRS\n',
				incoming: 'oneA\n',
				labels: { current: 'current bob t1 c1 typed here' },
			},
		]);
	});

	test('an overlap touching an existing block keeps both sides', () => {
		// Probe: current edits a plain line and a line in the block; incoming edits
		// the plain line and resolves the block. Incoming used to vanish.
		const block =
			'<<<<<<< current x t v\none\n||||||| base\nzero\n=======\ntwo\n>>>>>>> incoming y t v\n';
		const edited = block.replace('one', 'ONE');
		const r = merge(
			`intro\n${block}end\n`,
			`intro by cur\n${edited}end\n`,
			'intro by inc\nresolved\nend\n',
		);
		expect(r.overlaps).toMatchObject([{ unit: 'block' }]);
		const marked = withBlocks(r, labels) ?? '';
		expect(marked).toBe(
			`${OPEN}intro by cur\n${BASE}intro\n=======\nintro by inc\nresolved\n${CLOSE}${edited}end\n`,
		);
		expect(findConflicts(marked)).toHaveLength(2);
	});

	test('two edits inside one block become two adjacent blocks', () => {
		const block =
			'<<<<<<< current x t v\none\n||||||| base\nzero\n=======\ntwo\n>>>>>>> incoming y t v\n';
		const mine = block.replace('one', 'ONE');
		const theirs = block.replace('two', 'TWO');
		const marked = withBlocks(
			merge(`a\n${block}`, `a\n${mine}`, `a\n${theirs}`),
			labels,
		);
		expect(marked).toBe(`a\n${mine}${theirs}`);
	});

	test('an identical concurrent change appears once', () => {
		expect(merge('a\n', 'b\n', 'b\n').text).toBe('b\n');
	});

	test('unparseable frontmatter merges as plain lines', () => {
		const r = merge(
			'---\na: [\n---\nx\ny\n',
			'---\na: [\n---\nX\ny\n',
			'---\na: [\n---\nx\nY\n',
		);
		expect(r.text).toBe('---\na: [\n---\nX\nY\n');
	});

	test('a large note merges both distant edits in bounded memory', () => {
		const base = Array.from({ length: 30_000 }, (_, k) => `line ${k}\n`);
		const current = [...base];
		current[10] = 'CURRENT\n';
		const incoming = [...base];
		incoming[29_000] = 'INCOMING\n';
		incoming.splice(15_000, 0, 'INSERTED\n');
		// A shuffled middle defeats prefix and suffix trimming.
		const startedAt = performance.now();
		const r = merge(base.join(''), current.join(''), incoming.join(''));
		expect(r.overlaps).toHaveLength(0);
		expect(r.text).toContain('CURRENT\n');
		expect(r.text).toContain('INCOMING\n');
		expect(r.text?.split('\n')).toHaveLength(30_002);
		expect(performance.now() - startedAt).toBeLessThan(5_000);
	});
});

// Seeded cases use unique words so loss or duplication can be counted,
// over replacements, insertions, deletions and same-line appends.
let seed = 0x5eed1234;
const random = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return seed >>> 0;
};
const pick = (n: number) => random() % n;
const count = (s: string, token: string) =>
	(s.match(new RegExp(`\\b${token}\\b`, 'g')) ?? []).length;
const tokens = (s: string | null): string[] =>
	s?.match(/\b(?:b|c|i)\d+\b/g) ?? [];

function caseAt(k: number): [string, string, string] {
	const baseLines = Array.from(
		{ length: 1 + pick(5) },
		(_, n) =>
			`- b${k * 20 + n * 3} b${k * 20 + n * 3 + 1} b${k * 20 + n * 3 + 2}\n`,
	);
	const edit = (side: string, mode: number) => {
		const lines = [...baseLines];
		const row = pick(lines.length);
		const fresh = `${side}${k}`;
		if (mode === 0) lines[row] = (lines[row] ?? '').replace(/b\d+/, fresh);
		else if (mode === 1) lines.splice(row, 0, `- ${fresh}\n`);
		else if (mode === 2) lines.splice(row, 1);
		else lines[row] = (lines[row] ?? '').replace(/\n$/, ` ${fresh}\n`);
		return lines.join('');
	};
	return [baseLines.join(''), edit('c', pick(4)), edit('i', pick(4))];
}

const CASES = Array.from({ length: 2500 }, (_, k) => caseAt(k));

describe('properties', () => {
	test('inserted tokens outside overlaps survive exactly once', () => {
		for (const [b, c, i] of CASES) {
			const r = merge(b, c, i);
			for (const token of new Set(
				[...tokens(c), ...tokens(i)].filter((t) => !tokens(b).includes(t)),
			)) {
				if (
					spans(r.overlaps).some(
						(o) =>
							tokens(o.current).includes(token) ||
							tokens(o.incoming).includes(token),
					)
				)
					continue;
				expect(count(r.text ?? '', token)).toBe(1);
			}
		}
	});

	test('jointly retained base tokens occur once outside overlaps', () => {
		for (const [b, c, i] of CASES) {
			const r = merge(b, c, i);
			for (const token of tokens(b).filter(
				(t) => tokens(c).includes(t) && tokens(i).includes(t),
			)) {
				if (spans(r.overlaps).some((o) => tokens(o.base).includes(token)))
					continue;
				expect(count(r.text ?? '', token)).toBe(1);
			}
		}
	});

	test('merge is deterministic', () => {
		for (const [b, c, i] of CASES)
			expect(merge(b, c, i)).toEqual(merge(b, c, i));
	});

	test('identity laws hold', () => {
		for (const [b, c, i] of CASES) {
			expect(merge(b, c, c).text).toBe(c);
			expect(merge(b, b, i).text).toBe(i);
			expect(merge(b, c, b).text).toBe(c);
		}
	});

	test('no output token is a blend', () => {
		for (const [b, c, i] of CASES) {
			const possible = new Set([...tokens(b), ...tokens(c), ...tokens(i)]);
			for (const token of tokens(merge(b, c, i).text))
				expect(possible.has(token)).toBe(true);
		}
	});

	test('every overlap is one well-formed block, and none nests', () => {
		for (const [b, c, i] of CASES) {
			const result = merge(b, c, i);
			const marked = withBlocks(result, labels) ?? '';
			const found = findConflicts(marked);
			expect(found.length).toBeGreaterThanOrEqual(
				spans(result.overlaps).filter((o) => o.unit === 'body').length,
			);
			for (const block of found) {
				expect(marked.slice(block.from, block.to)).toBe(block.raw);
				expect(block.current).not.toContain('<<<<<<< ');
				expect(block.incoming).not.toContain('<<<<<<< ');
			}
		}
	});

	test('the anchored diff for large regions keeps independent edits', () => {
		// Edits near both ends of one side leave a region above the table limit,
		// so the unique-line anchor diff runs.
		const base = Array.from({ length: 1500 }, (_, k) => `- b${k}\n`);
		for (let trial = 0; trial < 20; trial++) {
			const c = [...base];
			const i = [...base];
			c[pick(10)] = `- c${trial}\n`;
			c[1490 + pick(10)] = `- d${trial}\n`;
			i[200 + pick(1000)] = `- i${trial}\n`;
			const r = merge(base.join(''), c.join(''), i.join(''));
			expect(r.overlaps).toHaveLength(0);
			for (const token of [`c${trial}`, `d${trial}`, `i${trial}`])
				expect(count(r.text ?? '', token)).toBe(1);
		}
	});
});

describe('two insertions at one point', () => {
	test("lines both sides inserted are kept once, each side's own lines current first (property seeds B 910115, 910214)", () => {
		// Both broke the same frontmatter (its lines moved to the body) and set a field: the moved lines are one copy.
		const merged =
			merge(
				'---\ntitle: t1z\n---\n',
				'---\n---\n---\nx: a\ntitle: t1z\n---\n',
				'---\n---\n---\ny: b\ntitle: t1z\n---\n',
			).text ?? '';
		expect(merged.match(/t1z/g)).toHaveLength(1);
		expect(merged).toBe('---\n---\n---\nx: a\ny: b\ntitle: t1z\n---\n');
		// Nothing shared: both kept whole, current first, as before.
		expect(merge('a\n', 'a\nb\n', 'a\nc\n').text).toBe('a\nb\nc\n');
	});

	test("an insertion that shares lines with the other side's change of the lines it abuts is one clash, its shared lines never copied twice (property seed B 910214)", () => {
		const base = 'one\ntwo\n';
		const current = 'moved\nshared\nONE\ntwo\n';
		const incoming = 'moved\nshared\none\ntwo\nthree\n';
		const result = merge(base, current, incoming);
		// One clash, current's lines in the text and incoming's offered in the block: the shared lines once outside it.
		expect(result.text).toBe('moved\nshared\nONE\ntwo\nthree\n');
		expect(result.overlaps.filter((o) => o.unit === 'body')).toHaveLength(1);
		const marked = withBlocks(result, labels) ?? '';
		expect(findConflicts(marked)).toHaveLength(1);
		// Overlapping, not only touching: the same (property seed W 400031).
		const overlapping = merge(
			'---\ntitle: t11z\n---\na\n',
			'---\n---\ntitle: t11z\nX\na c\n',
			'---\n---\ntitle: t11z\na b\n',
		);
		expect(overlapping.text?.match(/t11z/g)).toHaveLength(1);
		expect(overlapping.overlaps.filter((o) => o.unit === 'body')).toHaveLength(
			1,
		);
		// Sharing nothing, they stay independent: an insertion beside a neighbour's edit merges clean.
		expect(merge(base, 'ONE\ntwo\n', 'zero\none\ntwo\n')).toEqual({
			text: 'zero\nONE\ntwo\n',
			overlaps: [],
		});
	});
});

describe('the header merges by top-level key, each value whole', () => {
	const note = (yaml: string, body = 'x\n') => `---\n${yaml}---\n${body}`;
	const fieldsOf = (text: string | null) => {
		const parsed = parseRowSource(text ?? '');
		return parsed.error === null ? parsed.data.document.fields : null;
	};

	test("a list both sides changed is one value: [a] / [a, b] / [a, c] is the later write's, incoming's [a, c]", () => {
		const r = merge(
			note('tags: [a]\n'),
			note('tags: [a, b]\n'),
			note('tags: [a, c]\n'),
		);
		expect(r.text).toBe(note('tags: [a, c]\n'));
		expect(r.overlaps).toEqual([]);
	});

	test("a map both sides changed is one value: incoming's whole, never merged by its keys", () => {
		const r = merge(
			note('meta:\n  x: 1\n'),
			note('meta:\n  x: 1\n  y: 2\n'),
			note('meta:\n  x: 1\n  z: 3\n'),
		);
		expect(fieldsOf(r.text)).toEqual({ meta: { x: 1, z: 3 } });
		expect(r.overlaps).toEqual([]);
	});

	test("comments in the header survive the merge, each side's own", () => {
		const base = note('# about this note\ntitle: t # the title\ntags: [a]\n');
		const current = note(
			'# about this note\ntitle: t # the title\ntags: [a, b] # topics\n',
		);
		const incoming = note(
			'# about this note\ntitle: t # the title\ntags: [a]\n# how it went\nmood: ok # for now\n',
		);
		const r = merge(base, current, incoming);
		expect(r.text).toBe(
			note(
				'# about this note\ntitle: t # the title\ntags: [a, b] # topics\n# how it went\nmood: ok # for now\n',
			),
		);
		// A key's value taken from incoming keeps the key's own comment, and brings the value's.
		const won = merge(
			base,
			current,
			note('# about this note\ntitle: u # renamed\ntags: [a]\n'),
		);
		expect(won.text).toBe(
			note('# about this note\ntitle: u # renamed\ntags: [a, b] # topics\n'),
		);
	});

	test("two patches of one key at once on a header that does not parse: the later write's value, never a duplicate key", () => {
		const broken = '---\na: [\n---\nbody\n';
		const r = merge(
			broken,
			'---\na: [\ndone: true\n---\nbody\n',
			'---\na: [\ndone: false\n---\nbody\n',
		);
		expect(r).toEqual({
			text: '---\na: [\ndone: false\n---\nbody\n',
			overlaps: [],
		});
		// Different keys are both kept.
		expect(
			merge(
				broken,
				'---\na: [\ndone: true\n---\nbody\n',
				'---\na: [\nmood: ok\n---\nbody\n',
			).text,
		).toBe('---\na: [\ndone: true\nmood: ok\n---\nbody\n');
	});

	test('a side that breaks its header drops it: the broken block is its body, and no empty header is left', () => {
		const r = merge(
			note('title: A\n', 'one\nbob\n'),
			note('title: A\n', 'one\nBOB\n'),
			`---\ntitle: A\ntitle: B\n---\nONE\nbob\n`,
		);
		expect(r.text).toBe('---\ntitle: A\ntitle: B\n---\nONE\nBOB\n');
	});
});

describe('the header is a list of key blocks: a broken key merges by key like any other', () => {
	test('two people breaking one header at once: each break is its own key, never a line copied into the body (property seed W 800031)', () => {
		// Bob breaks the header over a main that had no block yet; Carol breaks it over a main that did.
		const bob =
			merge(
				'---\ntitle: t\n---\n',
				'---\ntitle: t\n---\nBLOCK\n',
				'---\nxb: "open\ntitle: t\n---\n',
			).text ?? '';
		expect(bob).toBe('---\ntitle: t\nxb: "open\n---\nBLOCK\n');
		const carol =
			merge(
				'---\ntitle: t\n---\nBLOCK\n',
				bob,
				'---\nxc: "open\ntitle: t\n---\nBLOCK\n',
			).text ?? '';
		expect(carol).toBe('---\ntitle: t\nxb: "open\nxc: "open\n---\nBLOCK\n');
	});

	test('two concurrent breaks of different keys merge per key', () => {
		const base = '---\ntitle: t\nmood: m\n---\nbody\n';
		const r = merge(
			base,
			'---\ntitle: "t\nmood: m\n---\nbody\n',
			'---\ntitle: t\nmood: [m\n---\nbody\n',
		);
		expect(r).toEqual({
			text: '---\ntitle: "t\nmood: [m\n---\nbody\n',
			overlaps: [],
		});
	});

	test("two concurrent breaks of the same key: the later write's", () => {
		const r = merge(
			'---\ntitle: t\ndone: true\n---\nbody\n',
			'---\ntitle: "t\ndone: true\n---\nbody\n',
			'---\ntitle: [t\ndone: true\n---\nbody\n',
		);
		expect(r).toEqual({
			text: '---\ntitle: [t\ndone: true\n---\nbody\n',
			overlaps: [],
		});
	});

	test("a text whose closing fence went is all body: its old header lines are body, and the other side's header edit stays in the header", () => {
		// Current adds a key (broken); incoming deletes the closing fence, so its header lines are body.
		const r = merge(
			'---\ntitle: a\n---\nbody\n',
			'---\nxc: "open\ntitle: a\n---\nbody\n',
			'---\ntitle: a\nbody\n',
		);
		expect(r.text).toBe('---\nxc: "open\n---\n---\ntitle: a\nbody\n');
		expect(r.text?.match(/title: a/g)).toHaveLength(1);
	});
});
