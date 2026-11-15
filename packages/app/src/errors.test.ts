/**
 * The shared action error wire contract. Every factory survives JSON and
 * validates; namesakes and malformed marked payloads remain unrecognized.
 */
import { expect, test } from 'bun:test';
import { ActionError, isActionError } from './errors.ts';

test('every shared factory carries its namespace and fields through JSON', () => {
	for (const { error } of [
		ActionError.Changed({ path: 'data/a.md', why: 'quote' }),
		ActionError.Missing({ path: 'data/a.md' }),
		ActionError.Threw({
			message: 'failed',
			thrown: { name: 'Custom', message: 'custom', id: 7 },
		}),
		ActionError.Refused({ message: 'declined', next: 'Try another input' }),
		ActionError.Unreachable({ message: 'The model did not answer' }),
		ActionError.Stopped({ message: 'Work stopped' }),
	]) {
		const received: unknown = JSON.parse(
			JSON.stringify({ ...error, extra: 7 }),
		);
		expect(error.namespace).toBe('epicenter/action-error');
		expect(isActionError(received)).toBe(true);
		expect(received).toMatchObject(error);
	}
});

test('the marker and the complete variant payload are required', () => {
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
		{ ...base, name: 'Missing' },
		{ ...base, name: 'Missing', path: 7 },
		{ ...base, name: 'Changed', path: 'data/a.md' },
		{ ...base, name: 'Changed', path: 'data/a.md', why: 'toString' },
		{ ...base, name: 'Threw', thrown: { name: 'Custom' } },
		{ ...base, name: 'Refused', next: 7 },
		{ ...base, name: 'Unreachable', message: 7 },
		{ ...base, name: 'Stopped', message: null },
	])
		expect(isActionError(value)).toBe(false);
});
