/**
 * The one reader of serve's answer, which a page and the CLI share. An answer
 * is exactly `{ data, error }`; whatever is not one is `Unreachable`, whatever
 * the HTTP status says.
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { checkAnswer, readAnswer } from './answer.ts';
import { ActionError } from './errors.ts';

const line = (fields: unknown) => `${JSON.stringify(fields)}\n`;
const invalid = {
	name: 'Unreachable',
	message: 'serve sent an invalid answer',
};

test('an answer is data, the error itself, or a platform error with its fields', () => {
	expect(expectOk(checkAnswer({ data: [1], error: null }))).toEqual([1]);
	for (const error of [
		{ name: 'NoRoute', message: 'no', airport: 'LAX' },
		ActionError.Refused({ message: 'no title' }).error,
		ActionError.Threw({ message: 'bad' }).error,
		ActionError.Threw({
			message: 'bad',
			thrown: { name: 'Custom', message: 'bad', id: 7 },
		}).error,
		...(['usage', 'unavailable'] as const).map(
			(cause) =>
				ActionError.NotStarted({ message: 'no', cause, next: 'epicenter' })
					.error,
		),
		ActionError.NotStarted({ message: 'no', cause: 'usage' }).error,
		ActionError.NotStarted({ message: 'no', cause: 'internal' }).error,
		ActionError.NotStarted({
			message: 'no',
			cause: 'app-problems',
			app: 'notes',
			problems: ['a'],
		}).error,
		ActionError.Unreachable({ message: 'lost' }).error,
	])
		expect(expectErr(checkAnswer({ data: null, error }))).toEqual(error);
});

test('a value of the wrong shape is Unreachable', () => {
	const platform = { message: 'm' };
	for (const value of [
		undefined,
		null,
		[],
		'answer',
		{},
		{ data: 1 },
		{ data: 1, error: null, extra: 1 },
		{ data: 1, error: { name: 'E', message: 'm' } },
		{ data: null, error: 'failed' },
		{ data: null, error: { name: 'E' } },
		// The envelope 0.6 sent.
		{ data: null, error: { kind: 'fault', message: 'bad' } },
		{
			data: null,
			error: { kind: 'returned', reason: { name: 'E', message: 'm' } },
		},
		{ data: null, error: { ...platform, name: 'Threw', thrown: {} } },
		{ data: null, error: { ...platform, name: 'NotStarted' } },
		{ data: null, error: { ...platform, name: 'NotStarted', cause: 'other' } },
		{
			data: null,
			error: { ...platform, name: 'NotStarted', cause: 'usage', next: 42 },
		},
		{
			data: null,
			error: { ...platform, name: 'NotStarted', cause: 'unavailable', next: 1 },
		},
		{
			data: null,
			error: { ...platform, name: 'NotStarted', cause: 'refused' },
		},
		// Each cause carries its own fields.
		{
			data: null,
			error: {
				...platform,
				name: 'NotStarted',
				cause: 'app-problems',
				app: 'notes',
				problems: [1],
			},
		},
		{
			data: null,
			error: {
				...platform,
				name: 'NotStarted',
				cause: 'app-problems',
				problems: ['a'],
			},
		},
	])
		expect(expectErr(checkAnswer(value))).toEqual(invalid);
});

test('a 200 whose lines are not frames is Unreachable', async () => {
	for (const text of [
		'not-json\n',
		line([1]),
		line({ neither: true }),
		line({ answer: null }),
		line({ answer: {} }),
		line({ answer: { data: null, error: { kind: 'fault', message: 'm' } } }),
		'<html>garbage</html>\n',
	])
		expect(expectErr(await readAnswer(new Response(text)))).toEqual(invalid);
});

test('a stream that ends with no answer is Unreachable, after its updates', async () => {
	for (const text of [
		'',
		line({ update: 1 }),
		line({ answer: { data: 1, error: null } }).slice(0, -3),
	]) {
		const heard: unknown[] = [];
		const error = expectErr(
			await readAnswer(new Response(text), (value) => heard.push(value)),
		);
		expect(error.name).toBe('Unreachable');
		expect(error.message).toStartWith('The connection ended before the answer');
		expect(heard).toEqual(text.startsWith('{"update"') ? [1] : []);
	}
});

test('an HTTP error carries an answer only as NotStarted', async () => {
	const refusal = ActionError.NotStarted({ message: 'no', cause: 'usage' });
	expect(
		expectErr(
			await readAnswer(new Response(JSON.stringify(refusal), { status: 400 })),
		),
	).toEqual(refusal.error);
	for (const body of [
		'Not found',
		'',
		JSON.stringify({ data: 1, error: null }),
		JSON.stringify(ActionError.Missing({ path: 'x' })),
	])
		expect(
			expectErr(
				await readAnswer(
					new Response(body, { status: 404, statusText: 'Not Found' }),
				),
			),
		).toMatchObject({
			name: 'Unreachable',
			message: 'serve answered 404 Not Found',
		});
});
