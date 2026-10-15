/**
 * The pieces `epicenter send` and a page share: the keychain entry and its
 * endpoint check, the request's URL below its endpoint, the stdin format,
 * and a response's lines read back into a `Response`. The CLI's own tests
 * run them end to end against a server (`packages/cli/src/ai-commands.test.ts`).
 */
import { expect, test } from 'bun:test';
import {
	createMemorySecrets,
	createResponseReader,
	decodeSendInput,
	encodeSendInput,
	keyState,
	removeKey,
	requestUrl,
	responseEvents,
	saveKey,
	sendRequest,
	toSendRequest,
} from './send.js';

const endpoint = 'https://api.groq.com/openai/v1';

test('a key is saved for one canonical endpoint, and its state never carries it', async () => {
	const secrets = createMemorySecrets();
	expect((await keyState(secrets, 'groq')).data).toEqual({ state: 'missing' });
	const saved = await saveKey(secrets, 'groq', {
		endpoint: 'https://API.groq.com:443/openai/v1/',
		key: ' sk-1 ',
	});
	expect(saved.data).toEqual({ state: 'saved', endpoint, hasKey: true });
	expect(await secrets.get('groq')).toBe(
		JSON.stringify({ endpoint, key: 'sk-1' }),
	);
	expect(
		(await saveKey(secrets, 'groq', { endpoint: 'ftp://x' })).error?.name,
	).toBe('InvalidRequest');
	expect((await saveKey(secrets, 'a/b', { endpoint })).error?.name).toBe(
		'InvalidRequest',
	);
	expect((await removeKey(secrets, 'groq')).data).toEqual({ removed: true });
	expect((await keyState(secrets, 'groq')).data).toEqual({ state: 'missing' });
});

test('a keychain that throws, or an entry this module did not write, is reported', async () => {
	const broken = {
		get: async () => {
			throw new Error('libsecret not available');
		},
		set: async () => {},
		delete: async () => false,
	};
	expect((await keyState(broken, 'groq')).error).toMatchObject({
		name: 'KeychainUnavailable',
		reason: 'libsecret not available',
	});
	const odd = createMemorySecrets();
	await odd.set('groq', 'plain key');
	expect((await keyState(odd, 'groq')).error?.name).toBe('EntryUnreadable');
});

test('a path stays below its endpoint', () => {
	expect(requestUrl(endpoint, '/audio/transcriptions').data).toBe(
		`${endpoint}/audio/transcriptions`,
	);
	for (const path of ['', '../x', 'a/../../x', 'a/./b', 'x#y', '\\x'])
		expect(requestUrl(endpoint, path).error?.name).toBe('InvalidRequest');
});

test('the keychain endpoint, not the page, decides where a request goes', async () => {
	const secrets = createMemorySecrets({ groq: { endpoint, key: 'sk-1' } });
	const sent: Request[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(new Request(input, init));
		return new Response('{}');
	}) as typeof globalThis.fetch;
	const request = {
		method: 'POST',
		path: 'chat/completions',
		headers: [['cookie', 'a=b'] as const, ['x-test', '1'] as const],
		body: new Uint8Array([1, 2]),
	};
	const moved = await sendRequest({
		target: {
			kind: 'openai-compatible',
			connection: 'groq',
			endpoint: 'https://evil.example/v1',
		},
		request,
		secrets,
		fetch,
	});
	expect(moved.error?.name).toBe('EndpointChanged');
	expect(sent).toEqual([]);
	const account = await sendRequest({
		target: { kind: 'epicenter', connection: 'account' },
		request,
		secrets,
		fetch,
	});
	expect(account.error?.name).toBe('SignInUnavailable');

	const { error } = await sendRequest({
		target: {
			kind: 'openai-compatible',
			connection: 'groq',
			endpoint: `${endpoint}/`,
		},
		request,
		secrets,
		fetch,
	});
	expect(error).toBeNull();
	expect(sent[0]!.url).toBe(`${endpoint}/chat/completions`);
	expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-1');
	expect(sent[0]!.headers.get('cookie')).toBeNull();
	expect(sent[0]!.redirect).toBe('error');
});

test('stdin carries one JSON line and the raw body, and reads back the same', async () => {
	const { data: request } = await toSendRequest(
		endpoint,
		`${endpoint}/audio/transcriptions`,
		{ method: 'POST', body: new Uint8Array([0, 10, 255]) },
	);
	const decoded = decodeSendInput(
		encodeSendInput(
			{ kind: 'openai-compatible', connection: 'groq', endpoint },
			request!,
		),
	);
	expect(decoded.data?.target).toEqual({
		kind: 'openai-compatible',
		connection: 'groq',
		endpoint,
	});
	expect(decoded.data?.request.path).toBe('audio/transcriptions');
	expect([...decoded.data!.request.body!]).toEqual([0, 10, 255]);
	const form = new FormData();
	form.append(
		'file',
		new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
		'a.wav',
	);
	const { data: multipart } = await toSendRequest(
		endpoint,
		`${endpoint}/audio/transcriptions`,
		{
			method: 'POST',
			body: form,
		},
	);
	const sent = new Request('http://x/', {
		method: 'POST',
		headers: multipart!.headers as [string, string][],
		body: multipart!.body as Uint8Array<ArrayBuffer>,
	});
	expect(((await sent.formData()).get('file') as File).name).toBe('a.wav');
	expect(
		(await toSendRequest(endpoint, 'https://evil.example/v1/x')).error?.name,
	).toBe('InvalidRequest');
	expect(decodeSendInput(new TextEncoder().encode('{}')).error?.name).toBe(
		'InvalidRequest',
	);
});

test('a response becomes lines and back, and a failure before its head is the result', async () => {
	const body = new Uint8Array(200_000).map((_, index) => index % 256);
	const reader = createResponseReader();
	for await (const event of responseEvents(
		new Response(body, { status: 201, headers: { 'x-a': 'b' } }),
	))
		reader.push(event);
	const { data: response } = await reader.response;
	expect(response!.status).toBe(201);
	expect(response!.headers.get('x-a')).toBe('b');
	expect(new Uint8Array(await response!.arrayBuffer())).toEqual(body);

	const refused = createResponseReader();
	refused.push({ type: 'error', name: 'NoKey', message: 'no key' });
	expect((await refused.response).error).toEqual({
		name: 'NoKey',
		message: 'no key',
	});

	const cut = createResponseReader();
	cut.push({ type: 'head', status: 200, statusText: 'OK', headers: [] });
	cut.fail({ name: 'Failed', message: 'the CLI stopped' });
	const { data: partial } = await cut.response;
	expect(partial!.text()).rejects.toThrow('the CLI stopped');
});
