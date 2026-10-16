/**
 * Transformation Request Tests
 *
 * Verifies the one request a transformation makes, against a deterministic
 * local endpoint: a function standing where `fetch` would be, so no socket,
 * provider, or key is involved. These establish the wire contract and how each
 * kind of answer is reported, not that any real provider accepts it.
 *
 * Key behaviors:
 * - POST `<base>/chat/completions` with the model, the prompt as the system
 *   message, and the transcript as the user message
 * - The text is read from `choices[0].message.content`
 * - A refusal, an unreachable endpoint, and an answer of the wrong shape are
 *   distinct errors, and none of them carries the key
 * - A request missing its model, prompt, or text is never sent
 * - A redirect is refused rather than followed, no ambient credential is
 *   sent, and a prepared base URL that does not name the stored connection is
 *   refused before sending
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { StoredConnection } from './connections.js';
import {
	type PreparedTransformation,
	transformOverConnection,
} from './transformation.js';

const KEY = 'sk-local-test-key';

type Seen = {
	url: string;
	method: string;
	authorization: string | null;
	contentType: string | null;
	credentials: RequestInit['credentials'];
	redirect: RequestInit['redirect'];
	body: unknown;
};

/** A deterministic endpoint: records each request and answers with `respond`. */
function endpoint(respond: (seen: Seen) => Response | Promise<Response>) {
	const seen: Seen[] = [];
	return {
		seen,
		fetch: async (input: string, init?: RequestInit) => {
			const request = new Request(input, init);
			const record: Seen = {
				url: request.url,
				method: request.method,
				authorization: request.headers.get('authorization'),
				contentType: request.headers.get('content-type'),
				credentials: init?.credentials,
				redirect: init?.redirect,
				body: await request.json(),
			};
			seen.push(record);
			return respond(record);
		},
	};
}

const completion = (content: unknown) =>
	Response.json({
		id: 'chatcmpl-test',
		object: 'chat.completion',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content },
				finish_reason: 'stop',
			},
		],
	});

const stored: StoredConnection = {
	baseUrl: 'http://127.0.0.1:18080/v1',
	model: 'stored-model',
	apiKey: KEY,
};

const prepared: PreparedTransformation = {
	expectedBaseUrl: 'http://127.0.0.1:18080/v1/',
	model: ' chat-model ',
	prompt: 'Fix the punctuation.\nAnswer with the text only.',
	input: 'um so a steady tone',
};

/** One transformation over `connection`, answered by `send`. */
const transform = (
	send: (input: string, init?: RequestInit) => Promise<Response>,
	change: Partial<PreparedTransformation> = {},
	connection: StoredConnection = stored,
) =>
	transformOverConnection(
		async () => connection,
		{ ...prepared, ...change },
		send,
	);

test('the request sends the chat completion with no ambient credentials and refuses redirects', async () => {
	const local = endpoint(() => completion('A steady tone.'));

	const answered = expectOk(await transform(local.fetch));

	expect(answered).toEqual({ text: 'A steady tone.' });
	expect(local.seen).toEqual([
		{
			url: 'http://127.0.0.1:18080/v1/chat/completions',
			method: 'POST',
			authorization: `Bearer ${KEY}`,
			contentType: 'application/json',
			credentials: 'omit',
			redirect: 'error',
			body: {
				model: 'chat-model',
				messages: [
					{
						role: 'system',
						content: 'Fix the punctuation.\nAnswer with the text only.',
					},
					{ role: 'user', content: 'um so a steady tone' },
				],
			},
		},
	]);
});

test('a prepared base URL that does not name the connection is refused before anything is sent', async () => {
	for (const expectedBaseUrl of [
		'  ',
		'ftp://127.0.0.1:18080/v1',
		'http://user:secret@127.0.0.1:18080/v1',
		'http://127.0.0.1:18080/v1?key=1',
		'http://127.0.0.1:18080/v1#part',
		'not a url',
		'http://127.0.0.1:18081/v1',
	]) {
		const local = endpoint(() => completion('never'));
		const error = expectErr(await transform(local.fetch, { expectedBaseUrl }));
		expect(error.name).toBe('ConnectionChanged');
		expect(JSON.stringify(error)).not.toContain(KEY);
		expect(local.seen).toHaveLength(0);
	}
});

test('no key sends no authorization header', async () => {
	const local = endpoint(() => completion('ok'));

	expectOk(
		await transform(
			local.fetch,
			{},
			{ baseUrl: stored.baseUrl, model: stored.model },
		),
	);

	expect(local.seen[0]!.authorization).toBeNull();
});

test('the endpoint URL is the connection’s base URL with one /chat/completions', async () => {
	for (const [baseUrl, expectedBaseUrl] of [
		['https://api.openai.com/v1', 'https://api.openai.com/v1'],
		['http://127.0.0.1:11434/v1', ' http://127.0.0.1:11434/v1// '],
	] as const) {
		const local = endpoint(() => completion('ok'));
		expectOk(
			await transform(local.fetch, { expectedBaseUrl }, { ...stored, baseUrl }),
		);
		expect(local.seen[0]!.url).toBe(`${baseUrl}/chat/completions`);
	}
});

test('a refusal reports the status and detail, with the key removed', async () => {
	const local = endpoint(() =>
		Response.json(
			{ error: { message: `Incorrect API key provided: ${KEY}` } },
			{ status: 401 },
		),
	);

	const error = expectErr(await transform(local.fetch));

	expect(error.name).toBe('Rejected');
	if (error.name !== 'Rejected') return;
	expect(error.status).toBe(401);
	expect(error.detail).toContain('Incorrect API key provided');
	expect(JSON.stringify(error)).not.toContain(KEY);
	expect(error.message).toContain('401');
});

test('an endpoint that cannot be reached is an Unreachable error, without the key', async () => {
	const error = expectErr(
		await transform(async () => {
			throw new TypeError(`connect ECONNREFUSED (authorization ${KEY})`);
		}),
	);

	expect(error.name).toBe('Unreachable');
	expect(error.message).toContain('ECONNREFUSED');
	expect(JSON.stringify(error)).not.toContain(KEY);
});

for (const [name, respond] of [
	['is not JSON', () => new Response('<html>gateway</html>')],
	['has no choices', () => Response.json({ object: 'chat.completion' })],
	['has an empty choices list', () => Response.json({ choices: [] })],
	['has a choice with no message', () => Response.json({ choices: [{}] })],
	['has content that is not text', () => completion([{ type: 'text' }])],
	['is the transcription shape', () => Response.json({ text: 'hello' })],
] as const) {
	test(`an answer that ${name} is Malformed`, async () => {
		const local = endpoint(respond);

		const error = expectErr(await transform(local.fetch));

		expect(error.name).toBe('Malformed');
	});
}

test('an answer with no text is Empty, so nothing empty is saved as a result', async () => {
	const local = endpoint(() => completion('  \n'));

	const error = expectErr(await transform(local.fetch));

	expect(error.name).toBe('Empty');
});

for (const [missing, change] of [
	['the model', { model: '' }],
	['the prompt', { prompt: '\n' }],
	['the input text', { input: '' }],
] as const) {
	test(`a request without ${missing} is not sent`, async () => {
		const local = endpoint(() => completion('never'));

		const error = expectErr(await transform(local.fetch, change));

		expect(error.name).toBe('NotConfigured');
		expect(error.message).toContain(missing);
		expect(local.seen).toHaveLength(0);
	});
}
