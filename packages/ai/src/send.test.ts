/**
 * The pieces `epicenter send` and a page share: the keychain entry and its
 * endpoint check, the request's URL below its endpoint, the stdin format,
 * and a response's lines read back into a `Response`. The CLI's own tests
 * run them end to end against a server (`packages/cli/src/ai-commands.test.ts`).
 */
import { expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
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
	expect(account.error?.name).toBe('NoAccessToken');
	const signedOut = await sendRequest({
		target: { kind: 'epicenter', connection: 'account' },
		request,
		secrets,
		epicenter: async () => Err('run epicenter auth login'),
		fetch,
	});
	expect(signedOut.error).toMatchObject({
		name: 'NoAccessToken',
		reason: 'run epicenter auth login',
	});
	expect(sent).toEqual([]);
	const viaAccount = await sendRequest({
		target: { kind: 'epicenter', connection: 'account' },
		request,
		secrets,
		epicenter: async () =>
			Ok({ endpoint: 'https://api.example.test/v1', key: 'ep_at_1' }),
		fetch,
	});
	expect(viaAccount.error).toBeNull();
	const toAccount = sent.pop();
	expect(toAccount?.url).toBe('https://api.example.test/v1/chat/completions');
	expect(toAccount?.headers.get('authorization')).toBe('Bearer ep_at_1');
	expect(toAccount?.headers.get('cookie')).toBeNull();

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

test('an account request goes below /api/ on the deployment, with the token for its audience', async () => {
	const secrets = createMemorySecrets();
	const sent: Request[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(new Request(input, init));
		return new Response('{}');
	}) as typeof globalThis.fetch;
	const minted: string[] = [];
	const account = async (audience: 'api' | 'git') => {
		minted.push(audience);
		return Ok({ endpoint: 'https://api.example.test', key: `at_${audience}` });
	};
	const request = (path: string) => ({
		method: 'POST',
		path,
		headers: [
			['authorization', 'Bearer page'] as const,
			['cookie', 'a=b'] as const,
		],
	});

	const connected = await sendRequest({
		target: { kind: 'account', audience: 'git' },
		request: request('api/git/connect'),
		secrets,
		account,
		fetch,
	});
	expect(connected.error).toBeNull();
	expect(sent[0]?.url).toBe('https://api.example.test/api/git/connect');
	expect(sent[0]?.headers.get('authorization')).toBe('Bearer at_git');
	expect(sent[0]?.headers.get('cookie')).toBeNull();
	expect(sent[0]?.redirect).toBe('error');

	for (const path of [
		'auth/oauth2/revoke',
		'api',
		'v1/chat/completions',
		'api/../auth/sign-out',
		'api/%2e%2e/auth/sign-out',
		'/api%2fx',
	]) {
		const refused = await sendRequest({
			target: { kind: 'account', audience: 'api' },
			request: request(path),
			secrets,
			account,
			fetch,
		});
		expect(refused.error?.name).toBe('InvalidRequest');
	}
	expect(minted).toEqual(['git']);

	const absent = await sendRequest({
		target: { kind: 'account', audience: 'api' },
		request: request('api/session'),
		secrets,
		fetch,
	});
	expect(absent.error?.name).toBe('NoAccountToken');
	const signedOut = await sendRequest({
		target: { kind: 'account', audience: 'api' },
		request: request('api/session'),
		secrets,
		account: async () => Err('run epicenter auth login --loopback'),
		fetch,
	});
	expect(signedOut.error).toMatchObject({
		name: 'NoAccountToken',
		audience: 'api',
		reason: 'run epicenter auth login --loopback',
	});
	expect(sent.length).toBe(1);
});

test('an account target reads back only with a known audience', () => {
	const head = (target: unknown) =>
		new TextEncoder().encode(
			`${JSON.stringify({ target, request: { method: 'GET', path: 'api/session', headers: [] } })}\n`,
		);
	expect(
		decodeSendInput(head({ kind: 'account', audience: 'git' })).data?.target,
	).toEqual({ kind: 'account', audience: 'git' });
	for (const audience of ['mcp', 'https://git.epicenter.so', undefined])
		expect(
			decodeSendInput(head({ kind: 'account', audience })).error?.name,
		).toBe('InvalidRequest');
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
