/**
 * Request tests.
 * Verifies the chat request a recipe run sends, and that only a whole chat
 * completion reads as an answer.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { readTransformation, transformationRequest } from './requests.js';

test('a recipe run sends its instructions as the system message and the text as the user’s', () => {
	const request = transformationRequest({
		model: 'connection-model',
		prompt: 'Clean this up.',
		input: 'um so hello',
	});
	expect(request.method).toBe('POST');
	expect(request.path).toBe('chat/completions');
	expect(request.headers).toEqual([['content-type', 'application/json']]);
	expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
		model: 'connection-model',
		messages: [
			{ role: 'system', content: 'Clean this up.' },
			{ role: 'user', content: 'um so hello' },
		],
	});
});

test('only a chat completion with text reads as an answer', async () => {
	const read = (body: unknown, status = 200) =>
		readTransformation(new Response(JSON.stringify(body), { status }));
	expect(
		expectOk(await read({ choices: [{ message: { content: 'Hello.' } }] })),
	).toEqual({ text: 'Hello.' });
	expect((await read({ choices: [] })).error?.message).toBe(
		'The endpoint did not answer with a chat completion',
	);
	expect(
		(await read({ choices: [{ message: { content: '  ' } }] })).error?.message,
	).toBe('The endpoint answered with no text');
	expect((await read({ error: 'no' }, 429)).error?.message).toBe(
		'The endpoint answered 429: {"error":"no"}',
	);
});
