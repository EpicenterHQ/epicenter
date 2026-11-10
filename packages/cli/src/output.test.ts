/**
 * Human output renders returned values by structure, without assigning meaning
 * to keys such as path, body, problems, or added. JSON mode keeps the answer.
 */
import { expect, test } from 'bun:test';
import { renderAnswer } from './output.ts';

const returned = (value: unknown) => renderAnswer({ returned: value });

test('objects keep every defined key in order and render nested values as compact JSON', () => {
	expect(
		returned({
			path: 'words/hello.md',
			body: 'First line\nSecond line\n',
			problems: ['one problem'],
			other: { old: true },
			added: true,
			missing: undefined,
		}),
	).toEqual({
		stdout:
			'path: words/hello.md\nbody: |\n  First line\n  Second line\nproblems: ["one problem"]\nother: {"old":true}\nadded: true\n',
		stderr: '',
		code: 0,
	});
});

test('ambiguous strings are quoted and other strings stay plain', () => {
	expect(
		returned({
			empty: '',
			spaced: ' hello ',
			quoted: '"hello"',
			pipe: '|literal',
			json: '{"a":1}',
			numeric: '42',
			word: 'true',
			phrase: 'hello world',
		}),
	).toEqual({
		stdout:
			'empty: ""\nspaced: " hello "\nquoted: "\\"hello\\""\npipe: "|literal"\njson: "{\\"a\\":1}"\nnumeric: "42"\nword: true\nphrase: hello world\n',
		stderr: '',
		code: 0,
	});
});

test('arrays of objects use rows unless a string has multiple lines', () => {
	expect(
		returned([
			{ path: 'a.md', done: false },
			{ path: 'b.md', done: true },
		]),
	).toEqual({
		stdout: 'path: a.md  done: false\npath: b.md  done: true\n',
		stderr: '',
		code: 0,
	});
	expect(
		returned([
			{ path: 'a.md', body: 'a\nb' },
			{ path: 'b.md', body: '' },
		]),
	).toEqual({
		stdout: 'path: a.md\nbody: |\n  a\n  b\n\npath: b.md\nbody: ""\n',
		stderr: '',
		code: 0,
	});
});

test('strings print as is, empty arrays print nothing, and other values use JSON', () => {
	expect(returned('plain answer')).toEqual({
		stdout: 'plain answer\n',
		stderr: '',
		code: 0,
	});
	expect(returned('already ended\n')).toEqual({
		stdout: 'already ended\n',
		stderr: '',
		code: 0,
	});
	expect(returned([])).toEqual({ stdout: '', stderr: '', code: 0 });
	expect(returned({})).toEqual({ stdout: '', stderr: '', code: 0 });
	expect(returned([1, 'two'])).toEqual({
		stdout: '[1,"two"]\n',
		stderr: '',
		code: 0,
	});
	expect(returned(null)).toEqual({ stdout: 'null\n', stderr: '', code: 0 });
});
