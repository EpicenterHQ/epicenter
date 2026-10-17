/**
 * File Merge Tests
 *
 * `merge` merges three versions of one file by its content and extension,
 * with no definition, the writer acting (`ours`) winning each unit both
 * sides changed differently: Markdown whose frontmatter reads by field and
 * body, JSON objects by key, any other text by line, and binary or a side
 * with no file as the whole file. Each test names a pair of changes and
 * shows what merges and what the writer overrode.
 *
 * Key behaviors:
 * - Independent field and body changes merge, unknown keys included, at any
 *   path: no table and no schema decide it
 * - Spelling never conflicts: quoting, key order, and comments read as the
 *   same values
 * - Frontmatter stays as a side wrote it while the merged fields are that
 *   side's, joined with the other side's presentation edits where their
 *   lines do not compete; it is written canonically, ours' key order first,
 *   only when they are neither side's. A CRLF row stays CRLF throughout
 * - Two edits of one field compete even where a line merge would succeed
 * - Body edits to neighboring lines both merge; only the same lines compete,
 *   and the writer keeps the other side's other lines
 * - Two added rows with no base agree only where they are equal; two bodies
 *   added at one place both stay
 * - A version whose frontmatter does not read merges as text; Markdown with
 *   no closed frontmatter merges as any text does
 * - With theirs winning, `overridden` names only a file lost to a delete
 * - JSON merges key by key, nested objects recursing, a byte-order mark
 *   kept; an array is one unit, so two additions to one array compete
 *   instead of joining into invalid JSON; JSON that is not an object is the
 *   whole file; JSON that does not parse, or holds a number a rewrite would
 *   change, merges by line
 * - A side with no file, or a version that is not text, is the whole file
 */
import { expect, test } from 'bun:test';
import { type FileVersions, merge } from './merge-file.js';
import { sameValue } from './row-merge.js';

const ROW = 'todos/walk.md';

const row = (frontmatter: string[], body = '') =>
	['---', ...frontmatter, '---', body].join('\n');

const BASE = row(['title: Walk', 'done: false'], 'Left at dawn.\n');

/** A merge where nothing competes, as its content. */
async function clean(versions: FileVersions, path = ROW) {
	const merged = await merge(path, versions);
	expect(merged.overridden).toEqual([]);
	return merged.content;
}

// ============================================================================
// Markdown with frontmatter
// ============================================================================

test('independent field and body changes merge, written in canonical form', async () => {
	expect(
		await clean({
			base: BASE,
			ours: row(
				["title: 'Evening walk' # mine", 'done: false'],
				'Left at dawn.\n',
			),
			theirs: row(
				['title: "Walk"', 'done: true', 'mood: calm'],
				'Left at dawn.\nCame back by the river.\n',
			),
		}),
	).toBe(
		row(
			['title: Evening walk', 'done: true', 'mood: calm'],
			'Left at dawn.\nCame back by the river.\n',
		),
	);
});

test('a row merges by field at any depth and at the root', async () => {
	const versions = {
		base: BASE,
		ours: row(["title: 'Evening walk'", 'done: false'], 'Left at dawn.\n'),
		theirs: row(['title: Walk', 'done: true # theirs'], 'Left at dawn.\n'),
	};
	const merged = row(['title: Evening walk', 'done: true'], 'Left at dawn.\n');
	for (const path of ['todos/walk.md', 'notes/2026/walk.md', 'walk.md'])
		expect(await clean(versions, path)).toBe(merged);
});

test('a row no schema would accept merges by field like any other', async () => {
	// `done` is a word and `when` an object: no table checks either.
	const base = row(['title: Walk', 'done: maybe', 'when: { at: dawn }']);
	expect(
		await clean({
			base,
			ours: row(['title: Walk', 'done: later', 'when: { at: dawn }']),
			theirs: row(['title: Walk', 'done: maybe', 'when: { at: dusk }']),
		}),
	).toBe(row(['title: Walk', 'done: later', 'when:', '  at: dusk']));
});

test('a hand-written README keeps its frontmatter comment when only its body changed', async () => {
	const head = ['# shown on the folder page', "title: 'Read me'"];
	const base = row(head, 'Intro.\n\nMiddle.\n\nEnd.\n');
	expect(
		await clean(
			{
				base,
				ours: row(head, 'Intro, revised.\n\nMiddle.\n\nEnd.\n'),
				theirs: row(head, 'Intro.\n\nMiddle.\n\nEnd, revised.\n'),
			},
			'README.md',
		),
	).toBe(row(head, 'Intro, revised.\n\nMiddle.\n\nEnd, revised.\n'));
});

test("frontmatter is canonical only when its fields are neither side's, in ours' key order", async () => {
	const head = (done: string) => [
		'# kept while untouched',
		`done: ${done}`,
		"title: 'Walk'",
	];
	const base = row(head('false'));
	// Ours changed a field and theirs the body: the fields are ours', so
	// ours' spelling stands.
	expect(
		await clean({
			base,
			ours: row(head('true')),
			theirs: row(head('false'), 'More.\n'),
		}),
	).toBe(row(head('true'), 'More.\n'));
	// Each changed a different field: canonical, in ours' order, then the key
	// only theirs added.
	expect(
		await clean({
			base,
			ours: row(head('true')),
			theirs: row(['title: Run', 'mood: calm', '# theirs', 'done: false']),
		}),
	).toBe(row(['done: true', 'title: Run', 'mood: calm']));
});

test('body edits to neighboring lines both merge, as Sync and save merge them', async () => {
	const base = row(['title: Walk', 'done: false'], 'one\ntwo\nthree\n');
	expect(
		await clean({
			base,
			ours: row(['title: Walk', 'done: false'], 'ONE\ntwo\nthree\n'),
			theirs: row(['title: Walk', 'done: false'], 'one\nTWO\nthree\n'),
		}),
	).toBe(row(['title: Walk', 'done: false'], 'ONE\nTWO\nthree\n'));
});

test('quoting, key order, and comments never compete with a value, and join it where they can', async () => {
	expect(
		await clean({
			base: BASE,
			ours: row(['done: false', "title: 'Walk' # quoted"], 'Left at dawn.\n'),
			theirs: row(['title: Walk', 'done: true'], 'Left at dawn.\n'),
		}),
	).toBe(row(['done: true', "title: 'Walk' # quoted"], 'Left at dawn.\n'));
});

test("theirs' frontmatter comment joins ours' value edit when their lines do not compete", async () => {
	expect(
		await clean({
			base: row(['title: Walk', 'done: false']),
			ours: row(['title: Walk', 'done: true']),
			theirs: row(['# a note', 'title: Walk', 'done: false']),
		}),
	).toBe(row(['# a note', 'title: Walk', 'done: true']));
});

test("theirs' presentation edit on the line ours changed is named, and ours stands", async () => {
	expect(
		await merge(ROW, {
			base: row(['title: Walk', 'done: false']),
			ours: row(['title: Walk', 'done: true']),
			theirs: row(['title: Walk', 'done: false # not yet']),
		}),
	).toEqual({
		content: row(['title: Walk', 'done: true']),
		overridden: [{ kind: 'lines', part: 'text', line: 3, count: 1 }],
	});
});

test('a CRLF row both sides changed keeps CRLF throughout', async () => {
	const crlf = (text: string) => text.replaceAll('\n', '\r\n');
	expect(
		await clean({
			base: crlf('---\nt: 1\n---\na\nb\nc\n'),
			ours: crlf('---\nt: 1\n---\nA\nb\nc\n'),
			theirs: crlf('---\nt: 1\n---\na\nb\nC\n'),
		}),
	).toBe(crlf('---\nt: 1\n---\nA\nb\nC\n'));
	// Fields neither side holds are canonical, line feeds throughout.
	expect(
		await clean({
			base: crlf('---\nt: 1\nu: 1\n---\na\n'),
			ours: crlf('---\nt: 2\nu: 1\n---\nA\n'),
			theirs: crlf('---\nt: 1\nu: 2\n---\na\n'),
		}),
	).toBe('---\nt: 2\nu: 2\n---\nA\n');
});

test('with theirs winning, overridden names nothing theirs kept', async () => {
	const versions = {
		base: BASE,
		ours: row(['title: Evening walk', 'done: false'], 'Left at dawn.\n'),
		theirs: row(['title: Morning walk', 'done: false'], 'Left at dawn.\n'),
	};
	expect(await merge(ROW, versions, { winner: 'theirs' })).toEqual({
		content: versions.theirs,
		overridden: [],
	});
	const bytes = (value: number) => new Uint8Array([0, value]);
	expect(
		await merge(
			'a.bin',
			{ base: bytes(1), ours: bytes(2), theirs: bytes(3) },
			{ winner: 'theirs' },
		),
	).toEqual({ content: bytes(3), overridden: [] });
	// A delete still beats the edit it never saw, and names the file.
	expect(
		await merge(ROW, { ...versions, theirs: null }, { winner: 'theirs' }),
	).toEqual({ content: null, overridden: [{ kind: 'file', lost: 'ours' }] });
});

test('two edits of one field compete, and the writer wins', async () => {
	expect(
		await merge(ROW, {
			base: BASE,
			ours: row(["title: 'Evening walk'", 'done: false'], 'Left at dawn.\n'),
			theirs: row(
				['title: Morning walk # theirs', 'done: true'],
				'Left at dawn.\n',
			),
		}),
	).toEqual({
		content: row(['title: Evening walk', 'done: true'], 'Left at dawn.\n'),
		overridden: [{ kind: 'field', field: 'title' }],
	});
});

test('a field one side removed and the other changed competes', async () => {
	expect(
		await merge(ROW, {
			base: row(['title: Walk', 'done: false', 'tags: [a]']),
			ours: row(["title: 'Walk' # mine", 'done: false']),
			theirs: row(['title: Walk', 'done: false', 'tags: [a, b]']),
		}),
	).toEqual({
		content: row(["title: 'Walk' # mine", 'done: false']),
		overridden: [{ kind: 'field', field: 'tags' }],
	});
});

test("competing body lines are one unit, and the writer keeps the other side's other lines", async () => {
	const at = (title: string, body: string) =>
		row([`title: ${title}`, 'done: false'], body);
	const versions = {
		base: at('Walk', 'one\ntwo\nthree\nfour\n'),
		ours: at("'Evening walk'", 'ONE\ntwo\nthree\nfour (ours)\n'),
		theirs: at('Walk', 'one\nTWO\nthree\nfour (theirs)\n'),
	};
	expect(await merge(ROW, versions)).toEqual({
		content: at("'Evening walk'", 'ONE\nTWO\nthree\nfour (ours)\n'),
		overridden: [{ kind: 'lines', part: 'body', line: 4, count: 1 }],
	});
	// With theirs winning, our other lines and our title still stand.
	expect((await merge(ROW, versions, { winner: 'theirs' })).content).toBe(
		at("'Evening walk'", 'ONE\nTWO\nthree\nfour (theirs)\n'),
	);
});

test('two added rows with no base agree only where equal, and both bodies stay', async () => {
	expect(
		await merge(ROW, {
			base: null,
			ours: row(["title: 'Walk' # mine", 'done: false'], 'Mine\n'),
			theirs: row(['title: Walk', 'done: true'], 'Theirs\n'),
		}),
	).toEqual({
		content: row(["title: 'Walk' # mine", 'done: false'], 'Theirs\nMine\n'),
		overridden: [{ kind: 'field', field: 'done' }],
	});
});

test('a version whose frontmatter does not read merges as text', async () => {
	const broken = '---\ntitle: [unclosed\n---\n';
	// Their added body line does not compete with our broken frontmatter.
	expect(
		await clean({
			base: BASE,
			ours: broken,
			theirs: row(['title: Walk', 'done: false'], 'Left at dawn.\nAnd more.\n'),
		}),
	).toBe('---\ntitle: [unclosed\n---\nAnd more.\n');
	// Their changed title does, and ours stands.
	const merged = await merge(ROW, {
		base: BASE,
		ours: broken,
		theirs: row(['title: Run', 'done: false'], 'Left at dawn.\nAnd more.\n'),
	});
	expect(merged.content).toBe('---\ntitle: [unclosed\n---\nAnd more.\n');
	expect(merged.overridden).toMatchObject([{ kind: 'lines', part: 'text' }]);
});

test('Markdown opening with an unclosed --- line merges by line, and two insertions both stay', async () => {
	expect(
		await clean(
			{
				base: '---\nIntro\n',
				ours: '---\nIntro\nA\n',
				theirs: '---\nIntro\nB\n',
			},
			'notes.md',
		),
	).toBe('---\nIntro\nB\nA\n');
});

test('Markdown with no frontmatter merges by line, and two appends both stay', async () => {
	expect(
		await clean(
			{
				base: '# Notes\n',
				ours: '# Notes\nmine\n',
				theirs: '# Notes\nyours\n',
			},
			'notes.md',
		),
	).toBe('# Notes\nyours\nmine\n');
});

// ============================================================================
// JSON
// ============================================================================

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

test('JSON keys each side changed both stand, nested objects included', async () => {
	expect(
		await clean(
			{
				base: json({ title: 'A', meta: { theme: 'light', size: 1 } }),
				ours: json({ title: 'B', meta: { theme: 'dark', size: 1 } }),
				theirs: json({ title: 'A', meta: { theme: 'light', size: 2 }, v: 1 }),
			},
			'settings.json',
		),
	).toBe(json({ title: 'B', meta: { theme: 'dark', size: 2 }, v: 1 }));
});

test('a JSON key both changed competes, and the writer wins it', async () => {
	expect(
		await merge('nested/deep/settings.json', {
			base: json({ meta: { theme: 'light' }, size: 1 }),
			ours: json({ meta: { theme: 'dark' }, size: 1 }),
			theirs: json({ meta: { theme: 'sepia' }, size: 2 }),
		}),
	).toEqual({
		content: json({ meta: { theme: 'dark' }, size: 2 }),
		overridden: [{ kind: 'field', field: 'meta/theme' }],
	});
});

test('two devices adding different items to one array compete, and the result is valid JSON', async () => {
	const merged = await merge('epicenter.json', {
		base: '{\n  "local": []\n}\n',
		ours: '{\n  "local": [\n    "audio/"\n  ]\n}\n',
		theirs: '{\n  "local": [\n    "cache/"\n  ]\n}\n',
	});
	expect(merged).toEqual({
		content: '{\n  "local": [\n    "audio/"\n  ]\n}\n',
		overridden: [{ kind: 'field', field: 'local' }],
	});
	expect(JSON.parse(merged.content as string)).toEqual({ local: ['audio/'] });
});

test("a JSON merge equal to one side keeps that side's bytes, and a new result keeps ours' key order", async () => {
	const base = json({ a: 1, b: 1 });
	// Ours changed `b` and spells the file with tabs; theirs only reordered.
	const tabbed = '{\n\t"a": 1,\n\t"b": 2\n}\n';
	expect(
		await clean({ base, ours: tabbed, theirs: json({ b: 1, a: 1 }) }, 'x.json'),
	).toBe(tabbed);
	// A key only theirs added goes after ours' keys, in ours' order.
	expect(
		await clean(
			{ base, ours: json({ b: 2, a: 1 }), theirs: json({ a: 1, b: 1, c: 3 }) },
			'x.json',
		),
	).toBe(json({ b: 2, a: 1, c: 3 }));
});

test('JSON that is not an object is the whole file', async () => {
	expect(
		await merge('x.json', {
			base: json({ a: 1, b: 1 }),
			ours: '[1, 2]\n',
			theirs: json({ a: 1, b: 2 }),
		}),
	).toEqual({
		content: '[1, 2]\n',
		overridden: [{ kind: 'file', lost: 'theirs' }],
	});
});

test('JSON that does not parse, comments included, merges by line, so neither edit leaves the file', async () => {
	const at = (a: number, b: number) =>
		`{\n  // settings\n  "a": ${a},\n  "b": ${b}\n}\n`;
	expect(
		await clean(
			{ base: at(1, 1), ours: at(2, 1), theirs: at(1, 2) },
			'.vscode/settings.json',
		),
	).toBe(at(2, 2));
});

test('a JSON number a rewrite would change is never rewritten: the file merges by line', async () => {
	for (const id of ['12345678901234567890', '1e400', '1.0']) {
		const at = (a: number, b: number) =>
			`{\n  "id": ${id},\n  "a": ${a},\n  "b": ${b}\n}\n`;
		expect(
			await clean(
				{ base: at(1, 1), ours: at(2, 1), theirs: at(1, 2) },
				'x.json',
			),
		).toBe(at(2, 2));
	}
});

test('a rewritten JSON result keeps a byte-order mark either side had', async () => {
	const BOM = '\uFEFF';
	expect(
		await clean(
			{
				base: json({ a: 1, b: 1 }),
				ours: json({ a: 2, b: 1 }),
				theirs: BOM + json({ a: 1, b: 2 }),
			},
			'x.json',
		),
	).toBe(BOM + json({ a: 2, b: 2 }));
});

test('JSON merged by line never writes one key twice: two keys added at one place compete', async () => {
	const at = (...lines: string[]) =>
		['{', '  // settings', '  "a": 1', ...lines, '}', ''].join('\n');
	expect(
		await merge('x.json', {
			base: at(),
			ours: at('  ,"b": 2'),
			theirs: at('  ,"b": 3'),
		}),
	).toEqual({
		content: at('  ,"b": 2'),
		overridden: [{ kind: 'lines', part: 'text', line: 4, count: 1 }],
	});
});

test('JSON with a byte-order mark merges by key and keeps the mark', async () => {
	const BOM = '\uFEFF';
	expect(
		await clean(
			{
				base: BOM + json({ a: 1, b: 1 }),
				ours: BOM + json({ a: 2, b: 1 }),
				theirs: BOM + json({ a: 1, b: 2 }),
			},
			'x.json',
		),
	).toBe(BOM + json({ a: 2, b: 2 }));
});

// ============================================================================
// Other files
// ============================================================================

test('other text merges by line', async () => {
	expect(
		await clean(
			{ base: 'a\nb\nc\n', ours: 'A\nb\nc\n', theirs: 'a\nb\nC\n' },
			'notes.txt',
		),
	).toBe('A\nb\nC\n');
	expect(
		await merge('notes.txt', {
			base: 'a\nb\n',
			ours: 'a\nB (ours)\n',
			theirs: 'a\nB (theirs)\n',
		}),
	).toEqual({
		content: 'a\nB (ours)\n',
		overridden: [{ kind: 'lines', part: 'text', line: 2, count: 1 }],
	});
});

test('a side with no file, or a version that is not text, is the whole file', async () => {
	const changed = row(['title: Evening walk', 'done: false']);
	const bytes = new Uint8Array([0, 1, 2]);
	const cases: [FileVersions, string | Uint8Array | null, 'ours' | 'theirs'][] =
		[
			// A delete beats the edit it never saw, from either side.
			[{ base: BASE, ours: null, theirs: changed }, null, 'theirs'],
			[{ base: BASE, ours: changed, theirs: null }, null, 'ours'],
			[{ base: BASE, ours: changed, theirs: bytes }, changed, 'theirs'],
			[
				{ base: bytes, ours: new Uint8Array([1]), theirs: bytes.slice(1) },
				new Uint8Array([1]),
				'theirs',
			],
		];
	for (const [versions, content, lost] of cases)
		expect(await merge(ROW, versions)).toEqual({
			content,
			overridden: [{ kind: 'file', lost }],
		});
});

test('values compare as JSON, whatever their key order', () => {
	expect(
		sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }),
	).toBe(true);
	expect(sameValue([1, 2], [2, 1])).toBe(false);
	expect(sameValue({ a: undefined }, {})).toBe(false);
	expect(sameValue(null, {})).toBe(false);
});
