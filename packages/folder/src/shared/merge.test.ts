/**
 * Content merge tests
 *
 * Verifies the field and line-region policy independently of storage: disjoint
 * edits survive, competing units take change, and untouched source bytes remain.
 */
import { expect, test } from 'bun:test';
import { parseRowSource } from '@epicenter/definition/note';
import { expectOk } from 'wellcrafted/testing';
import { merge } from './merge.js';

const row = (head: string, body = '') => `---\n${head}---\n${body}`;

test('concurrent creation keeps an EOF closing fence separate from a newly added body', async () => {
	for (const newline of ['\n', '\r\n']) {
		const head = `---${newline}x: 1${newline}---`;
		for (const [current, change] of [
			[head, `${head}${newline}Body`],
			[`${head}${newline}Body`, head],
		]) {
			const merged = await merge('a.md', {
				base: null,
				current: current!,
				change: change!,
			});
			expect(typeof merged.content).toBe('string');
			const parsed = expectOk(parseRowSource(merged.content as string));
			expect(parsed.document).toEqual({ fields: { x: 1 }, body: 'Body' });
		}
	}
});

test('an independent Markdown merge retains a lone carriage return inside body text', async () => {
	const base = row('x: 0\n', 'A\rB\n\nLast\n');
	const merged = await merge('a.md', {
		base,
		current: base.replace('x: 0', 'x: 1'),
		change: base.replace('Last', 'Changed'),
	});
	expect(document(merged.content)).toEqual({
		fields: { x: 1 },
		body: 'A\rB\n\nChanged\n',
	});
});

function document(content: Awaited<ReturnType<typeof merge>>['content']) {
	expect(typeof content).toBe('string');
	return expectOk(parseRowSource(content as string)).document;
}

test('independent fields and paragraphs survive together', async () => {
	const base = row(
		'title: Before\ndone: false\n',
		'First paragraph.\n\nSecond paragraph.\n',
	);
	const current = row(
		'title: Current\ndone: false\n',
		'Current first.\n\nSecond paragraph.\n',
	);
	const change = row(
		'title: Before\ndone: true\n',
		'First paragraph.\n\nChanged second.\n',
	);
	const result = await merge('todos/a.md', { base, current, change });
	expect(document(result.content)).toEqual({
		fields: { title: 'Current', done: true },
		body: 'Current first.\n\nChanged second.\n',
	});
	expect(result.overridden).toEqual([]);
});

test('independent field edits retain the current source comment and unknown field', async () => {
	const base = row(
		'title: Seed\ndone: false\nextra: keep\n# source note\n',
		'Body',
	);
	const result = await merge('todos/a.md', {
		base,
		current: base.replace('title: Seed', 'title: Edited'),
		change: base.replace('done: false', 'done: true'),
	});
	expect(result.content).toContain('title: Edited\ndone: true\nextra: keep');
	expect(result.content).toContain('# source note');
	expect(document(result.content)).toEqual({
		fields: { title: 'Edited', done: true, extra: 'keep' },
		body: 'Body',
	});
});

test('arrays and nested mappings compete as whole fields', async () => {
	const result = await merge('a.md', {
		base: row('tags: [a, b]\noptions: {left: 0, right: 0}\n'),
		current: row('tags: [x, b]\noptions: {left: 1, right: 0}\n'),
		change: row('tags: [a, y]\noptions: {left: 0, right: 2}\n'),
	});
	expect(document(result.content).fields).toEqual({
		tags: ['a', 'y'],
		options: { left: 0, right: 2 },
	});
	expect(result.overridden).toEqual([
		{ kind: 'field', field: 'tags' },
		{ kind: 'field', field: 'options' },
	]);
});

test('a formatting-only edit cannot restore the old field value', async () => {
	const result = await merge('a.md', {
		base: row('title: Milk\n'),
		current: row('title: Bread\n'),
		change: row('title: "Milk" # old title\n'),
	});
	expect(document(result.content).fields.title).toBe('Bread');
	expect(result.content).toBe(row('title: Bread\n'));
});

test('independent frontmatter comments join a semantic edit without canonical rewriting', async () => {
	const result = await merge('a.md', {
		base: row('# heading\ntitle: Milk\n'),
		current: row('# useful heading\ntitle: Milk\n'),
		change: row('# heading\ntitle: Bread\n'),
	});
	expect(result.content).toBe(row('# useful heading\ntitle: Bread\n'));
	expect(result.overridden).toEqual([]);
});

test('an edit beats an unseen deletion in either role order', async () => {
	const base = row('title: Before\n');
	const edit = row('title: After\n');
	for (const [current, change] of [
		[null, edit],
		[edit, null],
	]) {
		const result = await merge('a.md', {
			base,
			current: current!,
			change: change!,
		});
		expect(result.content).toBe(edit);
		expect(result.overridden).toEqual([{ kind: 'file' }]);
	}
});

test('a deletion stands when the other side did not edit', async () => {
	const base = row('title: Before\n');
	expect(await merge('a.md', { base, current: base, change: null })).toEqual({
		content: null,
		overridden: [],
	});
	expect(await merge('a.md', { base, current: null, change: base })).toEqual({
		content: null,
		overridden: [],
	});
});

test('simultaneous appends survive current first without requiring an original final newline', async () => {
	const result = await merge('capture.txt', {
		base: 'Original',
		current: 'Original\nCurrent',
		change: 'Original\nChange\n',
	});
	expect(result).toEqual({
		content: 'Original\nCurrent\nChange\n',
		overridden: [],
	});
});

test('prefix and suffix containment deduplicate extended insertions', async () => {
	for (const longer of ['First\nSecond\n', 'Second\nFirst\n']) {
		for (const [current, change] of [
			['First\n', longer],
			[longer, 'First\n'],
		]) {
			expect(
				await merge('a.txt', { base: '', current: current!, change: change! }),
			).toEqual({ content: longer, overridden: [] });
		}
	}
});

test('overlapping body replacements take change and report its result location', async () => {
	const result = await merge('a.md', {
		base: row('title: Title\n', 'First\n\nOld\n\nLast\n'),
		current: row('title: Title\n', 'First\n\nCurrent\n\nLast\n'),
		change: row('title: Title\n', 'First\n\nChange\n\nLast\n'),
	});
	expect(document(result.content).body).toBe('First\n\nChange\n\nLast\n');
	expect(result.overridden).toEqual([
		{ kind: 'lines', part: 'body', line: 3, count: 1 },
	]);
});

test('JSON uses ordinary text regions instead of recursive key merging', async () => {
	const result = await merge('table.json', {
		base: '{"a":0,"b":0}\n',
		current: '{"a":1,"b":0}\n',
		change: '{"a":0,"b":2}\n',
	});
	expect(result.content).toBe('{"a":0,"b":2}\n');
	expect(result.overridden).toEqual([
		{ kind: 'lines', part: 'text', line: 1, count: 1 },
	]);
});

test('JSON simultaneous inserted lines union even when the result needs repair', async () => {
	const result = await merge('table.json', {
		base: '{\n}\n',
		current: '{\n"a": 1\n}\n',
		change: '{\n"b": 2\n}\n',
	});
	expect(result.content).toBe('{\n"a": 1\n"b": 2\n}\n');
	expect(result.overridden).toEqual([]);
});

test('binary fast paths preserve bytes and competing binary content takes change', async () => {
	const base = new Uint8Array([255, 254, 253]);
	const current = new Uint8Array([128, 129]);
	const change = new Uint8Array([192, 193]);
	expect((await merge('a.bin', { base, current, change: base })).content).toBe(
		current,
	);
	expect(await merge('a.bin', { base, current, change })).toEqual({
		content: change,
		overridden: [{ kind: 'file' }],
	});
	expect((await merge('a.bin', { base, current: null, change })).content).toBe(
		change,
	);
});

test('unchanged-side Markdown preserves BOM, CRLF, comments and byte representation', async () => {
	const base = '\uFEFF---\r\n# comment\r\ntitle: "Before"\r\n---\r\nBody\r\n';
	const current = new TextEncoder().encode(base.replace('Before', 'Current'));
	const result = await merge('a.md', { base, current, change: base });
	expect(result.content).toBe(current);
	expect(result.overridden).toEqual([]);
});

test('merging a field with a body edit preserves matching raw frontmatter bytes', async () => {
	const base = '\uFEFF---\r\n# comment\r\ntitle: "Before"\r\n---\r\nBody\r\n';
	const current = base.replace('Before', 'Current');
	const change = base.replace('Body', 'Changed body');
	const result = await merge('a.md', { base, current, change });
	expect(result.content).toBe(current.replace('Body', 'Changed body'));
	expect(result.overridden).toEqual([]);
});

test('synthesized frontmatter keeps current key order and appends new keys alphabetically', async () => {
	const result = await merge('a.md', {
		base: row('z: 0\na: 0\n'),
		current: row('z: 1\na: 0\n'),
		change: row('z: 0\na: 2\nnew_z: 3\nnew_a: 4\n'),
	});
	expect(result.content).toBe(row('z: 1\na: 2\nnew_a: 4\nnew_z: 3\n'));
});

test('unsafe YAML stays visible and merges body regions without destructive conversion', async () => {
	const result = await merge('a.md', {
		base: row('n: 9007199254740993\n', 'First\n\nLast\n'),
		current: row('n: 9007199254740993\n', 'Current\n\nLast\n'),
		change: row('n: 9007199254740993\n', 'First\n\nChanged\n'),
	});
	expect(result.content).toBe(
		row('n: 9007199254740993\n', 'Current\n\nChanged\n'),
	);
	expect(result.overridden).toEqual([]);
});

test('neighboring replacements and a removal beside an edit stay independent', async () => {
	const base = 'one\ntwo\nthree\n';
	expect(
		await merge('a.txt', {
			base,
			current: 'ONE\ntwo\nthree\n',
			change: 'one\nTWO\nthree\n',
		}),
	).toEqual({ content: 'ONE\nTWO\nthree\n', overridden: [] });
	expect(
		await merge('a.txt', {
			base,
			current: 'one\nTHREE\n',
			change: 'ONE\ntwo\nthree\n',
		}),
	).toEqual({ content: 'ONE\nTHREE\n', overridden: [] });
});

test('a competing line removal reports zero retained lines', async () => {
	const result = await merge('a.txt', {
		base: 'one\ntwo\nthree\n',
		current: 'one\nTWO\nthree\n',
		change: 'one\nthree\n',
	});
	expect(result).toEqual({
		content: 'one\nthree\n',
		overridden: [{ kind: 'lines', part: 'text', line: 2, count: 0 }],
	});
});

test('plain text keeps embedded carriage returns and Unicode separators as part of its lines', async () => {
	const result = await merge('a.txt', {
		base: 'a\rb\nc\u2028d\ne\u2029f',
		current: 'A\rb\nc\u2028d\ne\u2029f',
		change: 'a\rb\nc\u2028d\nE\u2029f',
	});
	expect(result).toEqual({
		content: 'A\rb\nc\u2028d\nE\u2029f',
		overridden: [],
	});
});

test('independent frontmatter additions to plain Markdown retain both fields, body edits and current framing', async () => {
	for (const bom of ['', '\ufeff']) {
		for (const newline of ['\n', '\r\n']) {
			const base = `${bom}one${newline}two${newline}three${newline}`;
			const current = `${bom}---${newline}a: 1${newline}---${newline}ONE${newline}two${newline}three${newline}`;
			const change = `${bom}---${newline}b: 2${newline}---${newline}one${newline}two${newline}THREE${newline}`;
			const result = await merge('plain.md', { base, current, change });
			expect(document(result.content)).toEqual({
				fields: { a: 1, b: 2 },
				body: `ONE${newline}two${newline}THREE${newline}`,
			});
			expect(result.content?.slice(0, bom.length + 3)).toBe(`${bom}---`);
			expect(result.overridden).toEqual([]);
			if (newline === '\r\n')
				expect((result.content as string).replaceAll('\r\n', '')).not.toContain(
					'\n',
				);
		}
	}
});
