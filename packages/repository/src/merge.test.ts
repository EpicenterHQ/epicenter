/**
 * Epicenter Merge Tests
 *
 * Ported from the merge spike: examples for each rule in ADR-0692, then
 * seeded properties over 2,500 Markdown-like triples each. The properties are
 * what make the rules trustworthy: independent edits survive exactly once,
 * output never blends tokens, and marker output parses without nesting.
 *
 * Key behaviors:
 * - Neighboring line edits, separate sentence edits and same-point appends merge
 * - A true overlap is reported, never blended (cat/cart/coat)
 * - Frontmatter merges by parsed key; a clash keeps current and records incoming
 * - Two creates merge fields and keep both bodies; delete versus edit is signalled
 * - Large notes merge in bounded memory
 */
import { describe, expect, test } from 'bun:test';
import { merge, parseConflicts, withMarkers } from './merge.js';

const labels = { current: 'current', incoming: 'incoming' };

describe('examples', () => {
	test('adjacent checkbox edits both survive', () => {
		const r = merge('- [ ] a\n- [ ] b\n', '- [x] a\n- [ ] b\n', '- [ ] a\n- [x] b\n');
		expect(r.text).toBe('- [x] a\n- [x] b\n');
		expect(r.overlaps).toHaveLength(0);
	});

	test('adjacent line edits both survive', () => {
		const r = merge('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n');
		expect(r.text).toBe('a\nB\nC\n');
		expect(r.overlaps).toHaveLength(0);
	});

	test('separate sentence edits in one paragraph both survive', () => {
		const r = merge('One. Two. Three.\n', 'One! Two. Three.\n', 'One. Two. Three!\n');
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

	test('cat/cart/coat reports a whole-word overlap without coart', () => {
		const r = merge('cat\n', 'cart\n', 'coat\n');
		expect(r.overlaps).toHaveLength(1);
		expect(r.text).toBe('cart\n');
		expect(r.text).not.toContain('coart');
	});

	test('a frontmatter clash keeps current and records incoming', () => {
		const r = merge(
			'---\ntitle: Old\ntags: a\n---\nBody\n',
			'---\ntitle: Current\ntags: a\n---\nBody\n',
			'---\ntitle: Incoming\ntags: b\n---\nBody\n',
		);
		expect(r.text).toBe('---\ntitle: Current\ntags: b\n---\nBody\n');
		expect(r.dropped).toEqual([{ key: 'title', current: 'Current', incoming: 'Incoming' }]);
		expect(r.overlaps).toHaveLength(0);
	});

	test('frontmatter compares parsed values, so formatting is not a clash', () => {
		const r = merge('---\na: 1\nb: x\n---\n', "---\na: 1\nb: 'x'  # quoted\n---\n", '---\na: 2\nb: x\n---\n');
		expect(r.text).toBe("---\na: 2\nb: 'x'  # quoted\n---\n");
		expect(r.dropped).toEqual([]);
	});

	test('a settings-style set on each side merges by key', () => {
		const base = '---\ntheme: light\n---\n';
		const r = merge(base, '---\ntheme: dark\n---\n', '---\ntheme: light\nfont: serif\n---\n');
		expect(r.text).toBe('---\ntheme: dark\nfont: serif\n---\n');
	});

	test('a key removed on one side is removed', () => {
		const r = merge('---\na: 1\nb: 2\n---\n', '---\na: 1\n---\n', '---\na: 1\nb: 2\nc: 3\n---\n');
		expect(r.text).toBe('---\na: 1\nc: 3\n---\n');
	});

	test('two offline creates merge fields and keep both bodies', () => {
		const r = merge(null, '---\nweather: sun\n---\nMorning', '---\nmood: good\n---\nEvening');
		expect(r.text).toBe('---\nweather: sun\nmood: good\n---\nMorning\n\nEvening');
		expect(r.overlaps).toHaveLength(0);
	});

	test('two identical creates are one file', () => {
		expect(merge(null, 'Same\n', 'Same\n').text).toBe('Same\n');
	});

	test('delete versus edit signals the deleted side and returns the edit', () => {
		expect(merge('before', null, 'edited')).toMatchObject({ text: 'edited', deleteEdit: { deleted: 'current' } });
		expect(merge('before', 'edited', null)).toMatchObject({ text: 'edited', deleteEdit: { deleted: 'incoming' } });
	});

	test('a one-sided create has no delete-versus-edit signal', () => {
		expect(merge(null, null, 'New\n')).toMatchObject({ text: 'New\n', deleteEdit: null });
	});

	test('CRLF output follows current for independent edits', () => {
		expect(merge('a\nb\n', 'A\r\nb\r\n', 'a\nB\n').text).toBe('A\r\nB\r\n');
	});

	test('a true overlap gets a Git-style marker block with a base section', () => {
		const marked = withMarkers(merge('cat\n', 'cart\n', 'coat\n'), { current: 'Alice', incoming: 'Bob' });
		expect(marked).toBe('<<<<<<< Alice\ncart\n||||||| base\ncat\n=======\ncoat\n>>>>>>> Bob\n');
		expect(parseConflicts(marked ?? '').filter((s) => 'conflict' in s)).toHaveLength(1);
	});

	test('an overlap in a body after frontmatter has offsets past the header', () => {
		const r = merge('---\na: 1\n---\ncat\n', '---\na: 1\n---\ncart\n', '---\na: 2\n---\ncoat\n');
		expect(r.text).toBe('---\na: 2\n---\ncart\n');
		const [overlap] = r.overlaps;
		expect(r.text?.slice(overlap?.start, overlap?.end)).toBe('cart');
		expect(withMarkers(r, labels)).toBe(
			'---\na: 2\n---\n<<<<<<< current\ncart\n||||||| base\ncat\n=======\ncoat\n>>>>>>> incoming\n',
		);
	});

	test('CRLF overlap markers use current line endings and offsets', () => {
		const r = merge('a\ncat\n', 'a\r\ncart\r\n', 'a\ncoat\n');
		expect(r.text).toBe('a\r\ncart\r\n');
		expect(withMarkers(r, labels)).toBe(
			'a\r\n<<<<<<< current\r\ncart\r\n||||||| base\r\ncat\r\n=======\r\ncoat\r\n>>>>>>> incoming\r\n',
		);
	});

	test('a further edit around existing markers never nests markers', () => {
		const first = withMarkers(merge('cat\n', 'cart\n', 'coat\n'), labels);
		const r = merge('cat\n', first, 'cut\n');
		const marked = withMarkers(r, labels) ?? '';
		expect(marked.match(/^<<<<<<< /gm)).toHaveLength(1);
		expect(parseConflicts(marked).filter((s) => 'conflict' in s)).toHaveLength(1);
		expect(r.overlaps.length).toBeGreaterThan(0);
	});

	test('an identical concurrent change appears once', () => {
		expect(merge('a\n', 'b\n', 'b\n').text).toBe('b\n');
	});

	test('unparseable frontmatter merges as plain lines', () => {
		const r = merge('---\na: [\n---\nx\ny\n', '---\na: [\n---\nX\ny\n', '---\na: [\n---\nx\nY\n');
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
const count = (s: string, token: string) => (s.match(new RegExp(`\\b${token}\\b`, 'g')) ?? []).length;
const tokens = (s: string | null): string[] => s?.match(/\b(?:b|c|i)\d+\b/g) ?? [];

function caseAt(k: number): [string, string, string] {
	const baseLines = Array.from(
		{ length: 1 + pick(5) },
		(_, n) => `- b${k * 20 + n * 3} b${k * 20 + n * 3 + 1} b${k * 20 + n * 3 + 2}\n`,
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
			for (const token of new Set([...tokens(c), ...tokens(i)].filter((t) => !tokens(b).includes(t)))) {
				if (r.overlaps.some((o) => tokens(o.current).includes(token) || tokens(o.incoming).includes(token)))
					continue;
				expect(count(r.text ?? '', token)).toBe(1);
			}
		}
	});

	test('jointly retained base tokens occur once outside overlaps', () => {
		for (const [b, c, i] of CASES) {
			const r = merge(b, c, i);
			for (const token of tokens(b).filter((t) => tokens(c).includes(t) && tokens(i).includes(t))) {
				if (r.overlaps.some((o) => tokens(o.base).includes(token))) continue;
				expect(count(r.text ?? '', token)).toBe(1);
			}
		}
	});

	test('merge is deterministic', () => {
		for (const [b, c, i] of CASES) expect(merge(b, c, i)).toEqual(merge(b, c, i));
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
			for (const token of tokens(merge(b, c, i).text)) expect(possible.has(token)).toBe(true);
		}
	});

	test('marked output parses and has no nested markers', () => {
		for (const [b, c, i] of CASES) {
			const marked = withMarkers(merge(b, c, i), labels) ?? '';
			const parsed = parseConflicts(marked);
			expect(parsed.map((s) => ('text' in s ? s.text : s.conflict.raw)).join('')).toBe(marked);
			for (const segment of parsed) {
				if (!('conflict' in segment)) continue;
				expect(segment.conflict.current).not.toContain('<<<<<<< ');
				expect(segment.conflict.incoming).not.toContain('<<<<<<< ');
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
			for (const token of [`c${trial}`, `d${trial}`, `i${trial}`]) expect(count(r.text ?? '', token)).toBe(1);
		}
	});
});
