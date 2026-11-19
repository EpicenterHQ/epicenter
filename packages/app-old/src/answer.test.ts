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
		ActionError.NotStarted({ message: 'no', next: 'epicenter' }).error,
		ActionError.NotStarted({ message: 'no' }).error,
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
		{
			data: null,
			error: { ...platform, name: 'NotStarted', next: 42 },
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

test('any status but 200 is Unreachable, whatever its body says', async () => {
	const refusal = ActionError.NotStarted({ message: 'no' });
	for (const body of [
		'Not found',
		'',
		JSON.stringify(refusal),
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
