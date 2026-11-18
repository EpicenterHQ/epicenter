/**
 * The shared action error wire contract. Every factory's error is its name,
 * its message and its own fields, and survives JSON as it is; the name alone
 * says which error it is.
 */
import { expect, test } from 'bun:test';
import { ActionError } from './errors.ts';

test('every shared factory is its name, message and fields, unchanged through JSON', () => {
	for (const { error } of [
		ActionError.Changed({ path: 'data/a.md', cause: 'quote' }),
		ActionError.Missing({ path: 'data/a.md' }),
		ActionError.Misfit({
			path: 'data/a.md',
			problems: [{ line: 'title is missing', kind: 'title is missing' }],
		}),
		ActionError.Misfit({
			path: 'data/notes/a.md',
			id: 'a',
			problems: [],
			record: { path: 'data/notes/a.md', id: 'a', body: '' },
		}),
		ActionError.Threw({
			message: 'failed',
			thrown: { name: 'Custom', message: 'custom', id: 7 },
		}),
		ActionError.Refused({ message: 'declined', next: 'Try another input' }),
		ActionError.Problems({ message: 'one problem', report: { checked: 1 } }),
		ActionError.Unreachable({ message: 'The connection dropped' }),
		ActionError.NotStarted({
			message: 'notes: epicenter.ts does not load',
			cause: 'app-problems',
			app: 'notes',
			problems: ['epicenter.ts does not load'],
		}),
	]) {
		expect(error).not.toHaveProperty('namespace');
		expect(JSON.parse(JSON.stringify(error))).toEqual(error);
	}
	expect(ActionError.Changed({ path: 'data/a.md', cause: 'there' })).toEqual({
		data: null,
		error: {
			name: 'Changed',
			message: 'data/a.md is already there',
			path: 'data/a.md',
			cause: 'there',
		},
	});
});
