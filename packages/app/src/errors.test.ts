/**
 * The shared action error wire contract. Every factory survives JSON and is
 * recognized; a foreign namespace, an unknown name, or a message that is
 * not text is not. The other fields are not checked.
 */
import { expect, test } from 'bun:test';
import { ActionError, isActionError } from './errors.ts';

test('every shared factory carries its namespace and fields through JSON', () => {
	for (const { error } of [
		ActionError.Changed({ path: 'data/a.md', why: 'quote' }),
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
		ActionError.Unreachable({ message: 'The connection dropped' }),
		ActionError.NotStarted({
			message: 'notes: epicenter.ts does not load',
			cause: 'app-problems',
			app: 'notes',
			problems: ['epicenter.ts does not load'],
		}),
	]) {
		const received: unknown = JSON.parse(
			JSON.stringify({ ...error, extra: 7 }),
		);
		expect(error.namespace).toBe('epicenter/action-error');
		expect(isActionError(received)).toBe(true);
		expect(received).toMatchObject(error);
	}
});

test('a foreign namespace, an unknown name, or a message that is not text is not an ActionError', () => {
	const base = { namespace: 'epicenter/action-error', message: 'failed' };
	for (const value of [
		null,
		[],
		'failed',
		{},
		{ name: 'Missing', message: 'missing', path: 'data/a.md' },
		{ ...base, namespace: 'another/error', name: 'Missing', path: 'data/a.md' },
		{ ...base, name: 'constructor' },
		{ ...base, name: 'Unknown' },
		{ ...base, name: 'Unreachable', message: 7 },
	])
		expect(isActionError(value)).toBe(false);
});
