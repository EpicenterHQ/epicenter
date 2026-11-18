/**
 * Human output renders Ok data by structure, without assigning meaning to keys
 * such as path, body, problems, or added, and an error as its message and next
 * step. JSON mode keeps the answer.
 */
import { expect, spyOn, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { ActionError, type Answer } from '../index.ts';
import { presentAnswer } from './output.ts';

/** What `presentAnswer` writes for a person, and the exit code it returns. */
function present(answer: Answer) {
	const written = { stdout: '', stderr: '' };
	const stdout = spyOn(process.stdout, 'write').mockImplementation((text) => {
		written.stdout += String(text);
		return true;
	});
	const stderr = spyOn(process.stderr, 'write').mockImplementation((text) => {
		written.stderr += String(text);
		return true;
	});
	try {
		const code = presentAnswer(answer, false);
		return { ...written, code };
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
	}
}

const ok = (value: unknown) => present(Ok(value));

test('objects keep every defined key in order; a nested object renders beneath its key, and other values as compact JSON', () => {
	expect(
		ok({
			path: 'data/words/hello.md',
			body: 'First line\nSecond line\n',
			problems: ['one problem'],
			other: { old: true },
			added: true,
			missing: undefined,
		}),
	).toEqual({
		stdout:
			'path: data/words/hello.md\nbody: |\n  First line\n  Second line\nproblems: ["one problem"]\nother:\n  old: true\nadded: true\n',
		stderr: '',
		code: 0,
	});
});

test('a string that could read as something else is quoted, any JSON among them, and other strings stay plain', () => {
	expect(
		ok({
			empty: '',
			spaced: ' hello ',
			quoted: '"hello"',
			pipe: '|literal',
			json: '{"a":1}',
			numeric: '42',
			boolean: 'true',
			nothing: 'null',
			word: 'hello',
			phrase: 'hello world',
		}),
	).toEqual({
		stdout:
			'empty: ""\nspaced: " hello "\nquoted: "\\"hello\\""\npipe: "|literal"\njson: "{\\"a\\":1}"\nnumeric: "42"\nboolean: "true"\nnothing: "null"\nword: hello\nphrase: hello world\n',
		stderr: '',
		code: 0,
	});
});

test('arrays of objects use rows unless a string has multiple lines', () => {
	expect(
		ok([
			{ path: 'data/a.md', done: false },
			{ path: 'data/b.md', done: true },
		]),
	).toEqual({
		stdout: 'path: data/a.md  done: false\npath: data/b.md  done: true\n',
		stderr: '',
		code: 0,
	});
	expect(
		ok([
			{ path: 'data/a.md', body: 'a\nb' },
			{ path: 'data/b.md', body: '' },
		]),
	).toEqual({
		stdout: 'path: data/a.md\nbody: |\n  a\n  b\n\npath: data/b.md\nbody: ""\n',
		stderr: '',
		code: 0,
	});
});

test('a field holding a list of objects renders its rows beneath its key, as capture recent returns them', () => {
	expect(
		ok({
			total: 2,
			captures: [
				{
					path: 'data/captures/b.md',
					capturedAt: '2026-11-11T09:30:00-08:00',
					text: 'Call the dentist',
					thoughts: 0,
				},
				{
					path: 'data/captures/a.md',
					capturedAt: '2026-11-10T21:05:00-08:00',
					text: 'A line from the book',
					thoughts: 2,
				},
			],
		}),
	).toEqual({
		stdout: [
			'total: 2',
			'captures:',
			'  path: data/captures/b.md  capturedAt: 2026-11-11T09:30:00-08:00  text: Call the dentist  thoughts: 0',
			'  path: data/captures/a.md  capturedAt: 2026-11-10T21:05:00-08:00  text: A line from the book  thoughts: 2',
			'',
		].join('\n'),
		stderr: '',
		code: 0,
	});
	expect(
		ok({
			week: { minutes: 210, books: [{ title: 'Dune', notes: 'a\nb' }] },
			empty: {},
			tags: [],
		}),
	).toEqual({
		stdout: [
			'week:',
			'  minutes: 210',
			'  books:',
			'    title: Dune',
			'    notes: |',
			'      a',
			'      b',
			'empty: {}',
			'tags: []',
			'',
		].join('\n'),
		stderr: '',
		code: 0,
	});
});

test('strings print as is, empty arrays print nothing, and other values use JSON', () => {
	expect(ok('plain answer')).toEqual({
		stdout: 'plain answer\n',
		stderr: '',
		code: 0,
	});
	expect(ok('already ended\n')).toEqual({
		stdout: 'already ended\n',
		stderr: '',
		code: 0,
	});
	expect(ok([])).toEqual({ stdout: '', stderr: '', code: 0 });
	expect(ok({})).toEqual({ stdout: '', stderr: '', code: 0 });
	expect(ok([1, 'two'])).toEqual({
		stdout: '[1,"two"]\n',
		stderr: '',
		code: 0,
	});
	expect(ok(null)).toEqual({ stdout: 'null\n', stderr: '', code: 0 });
});

test('an error renders its message and next step, and exits 2 only for NotStarted', () => {
	expect(
		present(
			Err({ name: 'NoRoute', message: 'No route from LAX', airport: 'LAX' }),
		),
	).toEqual({ stdout: '', stderr: 'No route from LAX\n', code: 1 });
	expect(
		present(
			ActionError.Refused({
				message: 'Declined',
				next: 'epicenter flights add',
			}),
		),
	).toEqual({
		stdout: '',
		stderr: 'Declined\nRun: epicenter flights add\n',
		code: 1,
	});
	expect(
		present(ActionError.Threw({ message: 'Unexpected end of input' })),
	).toEqual({ stdout: '', stderr: 'Unexpected end of input\n', code: 1 });
	expect(
		present(ActionError.Unreachable({ message: 'The connection ended' })),
	).toEqual({ stdout: '', stderr: 'The connection ended\n', code: 1 });
	for (const cause of ['usage', 'unavailable'] as const)
		expect(
			present(ActionError.NotStarted({ message: 'm', cause, next: 'n' })),
		).toEqual({ stdout: '', stderr: 'm\nRun: n\n', code: 2 });
	for (const error of [
		ActionError.NotStarted({ message: 'm', cause: 'internal' }),
		ActionError.NotStarted({
			message: 'm',
			cause: 'app-problems',
			app: 'a',
			problems: ['p'],
		}),
	])
		expect(present(error)).toEqual({
			stdout: '',
			stderr: 'm\n',
			code: 2,
		});
	// An error that carries a report renders it where data would be, by the
	// field and not the name, and its message still goes to stderr.
	expect(
		present(
			ActionError.Problems({
				message: '1 file has problems',
				report: { checked: 3, bad: ['a.md'] },
			}),
		),
	).toEqual({
		stdout: 'checked: 3\nbad: ["a.md"]\n',
		stderr: '1 file has problems\n',
		code: 1,
	});
	expect(
		present(Err({ name: 'Partial', message: 'm', report: 'what it did' })),
	).toEqual({ stdout: 'what it did\n', stderr: 'm\n', code: 1 });
	// The name is what counts: an app's own `NotStarted` never reaches here,
	// because serve answers it as `Threw`.
	expect(present(Err({ name: 'Refused', message: 'm' })).code).toBe(1);
});
