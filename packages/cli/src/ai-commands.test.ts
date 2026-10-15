/**
 * `epicenter send` and `epicenter auth key` in fresh processes, against a
 * local fake OpenAI-compatible server: a streamed response arrives line by
 * line while the server is still sending, a large body crosses both ways in
 * bounded lines, the key is added and nothing ambient is carried, and a
 * request prepared for another endpoint, an Epicenter connection or account
 * request with no sign-in, an account path outside `/api/`, or a missing key
 * sends nothing.
 *
 * The keychain is never touched: `EPICENTER_TEST_SECRETS` seeds a store held
 * in the process's memory (`secrets.ts`). Like `epicenter.test.ts`, these run
 * `src/bin.ts` under Bun, or the compiled binary `EPICENTER_BIN` names.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
	createResponseReader,
	encodeSendInput,
	type KeyEntry,
	type SendEvent,
	type SendRequest,
	type SendTarget,
} from '@epicenter/ai/send';

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];

const KEY = 'sk-test-0123456789';
const BIG = 3 * 1024 * 1024 + 17;

type Seen = {
	path: string;
	authorization: string | null;
	cookie: string | null;
	bytes: number;
};
const seen: Seen[] = [];
/** Releases the streamed reply's last event once the test has read its first. */
let releaseStream: (() => void) | undefined;
let server: ReturnType<typeof Bun.serve>;
let endpoint: string;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const url = new URL(request.url);
			const body = new Uint8Array(await request.arrayBuffer());
			seen.push({
				path: url.pathname,
				authorization: request.headers.get('authorization'),
				cookie: request.headers.get('cookie'),
				bytes: body.length,
			});
			switch (url.pathname) {
				case '/v1/chat/completions': {
					const released = new Promise<void>((done) => {
						releaseStream = done;
					});
					const encoder = new TextEncoder();
					const stream = new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] })}\n\n`,
								),
							);
							await released;
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
								),
							);
							controller.close();
						},
					});
					return new Response(stream, {
						headers: { 'content-type': 'text/event-stream' },
					});
				}
				case '/v1/audio/transcriptions':
					return Response.json({ text: `got ${body.length} bytes` });
				case '/v1/big': {
					const bytes = new Uint8Array(BIG);
					for (let index = 0; index < BIG; index++) bytes[index] = index % 251;
					return new Response(bytes);
				}
				case '/v1/redirect':
					return Response.redirect('http://127.0.0.1:1/elsewhere', 302);
				default:
					return new Response('no such route', { status: 404 });
			}
		},
	});
	endpoint = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
	server.stop(true);
});

function spawn(
	args: string[],
	stdin: Uint8Array | string,
	secrets: Record<string, KeyEntry> = { groq: { endpoint, key: KEY } },
) {
	return Bun.spawn([...command, ...args], {
		stdin: typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, EPICENTER_TEST_SECRETS: JSON.stringify(secrets) },
	});
}

/** Each NDJSON line of `stream` as it arrives. */
async function* lines(stream: ReadableStream<Uint8Array>) {
	const decoder = new TextDecoder();
	let pending = '';
	const reader = stream.getReader();
	for (;;) {
		const { done, value: chunk } = await reader.read();
		if (done) break;
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf('\n');
		while (newline !== -1) {
			yield pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			newline = pending.indexOf('\n');
		}
	}
	if (pending) yield pending;
}

const target = (
	overrides: Partial<{ endpoint: string; connection: string }> = {},
): SendTarget => ({
	kind: 'openai-compatible',
	connection: 'groq',
	endpoint,
	...overrides,
});
const request = (path: string, body?: Uint8Array): SendRequest => ({
	method: body ? 'POST' : 'GET',
	path,
	headers: [
		['content-type', 'application/json'],
		['cookie', 'session=ambient'],
		['authorization', 'Bearer page-supplied'],
	],
	...(body && { body }),
});

/** Run `send` to the end: its exit code and every event it printed. */
async function send(
	input: Uint8Array,
	secrets?: Record<string, KeyEntry>,
	flags: string[] = [],
) {
	const child = spawn(['send', '--json', ...flags], input, secrets);
	const events: SendEvent[] = [];
	let longest = 0;
	for await (const line of lines(child.stdout)) {
		longest = Math.max(longest, line.length);
		events.push(JSON.parse(line));
	}
	return { code: await child.exited, events, longest };
}

test('send streams the response while the server is still sending it', async () => {
	const before = seen.length;
	const child = spawn(
		['send', '--json'],
		encodeSendInput(
			target(),
			request('chat/completions', new TextEncoder().encode('{"stream":true}')),
		),
	);
	const reader = createResponseReader();
	const iterator = lines(child.stdout)[Symbol.asyncIterator]();
	const read = async () => {
		const { value, done } = await iterator.next();
		if (done) throw new Error('send ended early');
		const event = JSON.parse(value) as SendEvent;
		reader.push(event);
		return event;
	};
	expect(await read()).toMatchObject({ type: 'head', status: 200 });
	const first = await read();
	expect(first.type).toBe('chunk');
	// The server has not finished: its last event waits for this release.
	releaseStream?.();
	for (;;) if ((await read()).type === 'end') break;
	expect(await child.exited).toBe(0);
	const { data: response } = await reader.response;
	const text = await response!.text();
	expect(text).toContain('"content":"Hel"');
	expect(text).toContain('data: [DONE]');

	// The key is the keychain's, and nothing the page set reaches the server.
	expect(seen.slice(before)).toEqual([
		{
			path: '/v1/chat/completions',
			authorization: `Bearer ${KEY}`,
			cookie: null,
			bytes: 15,
		},
	]);
});

test('a large body crosses both ways, in lines that stay small', async () => {
	const upload = new Uint8Array(5 * 1024 * 1024).fill(7);
	const transcribed = await send(
		encodeSendInput(target(), request('audio/transcriptions', upload)),
	);
	expect(transcribed.code).toBe(0);
	const reader = createResponseReader();
	for (const event of transcribed.events) reader.push(event);
	const { data: answer } = await reader.response;
	expect(await answer!.json()).toEqual({ text: `got ${upload.length} bytes` });

	const downloaded = await send(encodeSendInput(target(), request('big')));
	expect(downloaded.code).toBe(0);
	expect(downloaded.longest).toBeLessThan(100 * 1024);
	const big = createResponseReader();
	for (const event of downloaded.events) big.push(event);
	const { data: response } = await big.response;
	const bytes = new Uint8Array(await response!.arrayBuffer());
	expect(bytes.length).toBe(BIG);
	expect(bytes.every((byte, index) => byte === index % 251)).toBe(true);
});

test('a request prepared for another endpoint is refused and sends nothing', async () => {
	const before = seen.length;
	const refused = await send(
		encodeSendInput(
			target({ endpoint: 'https://api.example.com/v1' }),
			request('chat/completions', new Uint8Array([1])),
		),
	);
	expect(refused.code).toBe(2);
	expect(refused.events).toEqual([
		expect.objectContaining({ type: 'error', name: 'EndpointChanged' }),
	]);
	expect(seen.length).toBe(before);
});

test('a missing key, an Epicenter connection, a signed-out account, a redirect, and bad input each fail typed', async () => {
	const before = seen.length;
	const missing = await send(
		encodeSendInput(target({ connection: 'other' }), request('big')),
	);
	expect(missing.code).toBe(2);
	expect(missing.events[0]).toMatchObject({ type: 'error', name: 'NoKey' });

	const account = await send(
		encodeSendInput(
			{ kind: 'epicenter', connection: 'account' },
			request('big'),
		),
	);
	expect(account.code).toBe(2);
	expect(account.events).toEqual([
		expect.objectContaining({ type: 'error', name: 'NoAccessToken' }),
	]);
	expect(JSON.stringify(account.events[0])).toContain('epicenter auth login');

	const signedOut = await send(
		encodeSendInput(
			{ kind: 'account', audience: 'git' },
			request('api/git/connect'),
		),
	);
	expect(signedOut.code).toBe(2);
	expect(signedOut.events).toEqual([
		expect.objectContaining({ type: 'error', name: 'NoAccountToken' }),
	]);
	expect(JSON.stringify(signedOut.events[0])).toContain('epicenter auth login');

	const desktop = await send(
		encodeSendInput(
			{ kind: 'account', audience: 'api' },
			request('api/session'),
		),
		undefined,
		['--desktop'],
	);
	expect(desktop.events[0]).toMatchObject({
		type: 'error',
		name: 'NoAccountToken',
	});
	expect(JSON.stringify(desktop.events[0])).toContain("Epicenter's Settings");

	const outsideApi = await send(
		encodeSendInput(
			{ kind: 'account', audience: 'api' },
			request('auth/oauth2/revoke'),
		),
	);
	expect(outsideApi.events[0]).toMatchObject({
		type: 'error',
		name: 'InvalidRequest',
	});

	const escaping = await send(
		encodeSendInput(target(), request('../elsewhere')),
	);
	expect(escaping.events[0]).toMatchObject({
		type: 'error',
		name: 'InvalidRequest',
	});
	expect(seen.length).toBe(before);

	const redirected = await send(encodeSendInput(target(), request('redirect')));
	expect(redirected.code).toBe(2);
	expect(redirected.events[0]).toMatchObject({
		type: 'error',
		name: 'Unreachable',
	});
	expect(JSON.stringify(redirected.events)).not.toContain(KEY);

	const garbage = await send(new TextEncoder().encode('not json\n'));
	expect(garbage.events[0]).toMatchObject({
		type: 'error',
		name: 'InvalidRequest',
	});
});

async function run(
	args: string[],
	stdin: string,
	secrets?: Record<string, KeyEntry>,
) {
	const child = spawn(args, stdin, secrets);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

test('auth key state answers with the endpoint and never the key', async () => {
	const saved = await run(['auth', 'key', 'state', 'groq', '--json'], '');
	expect(saved.code).toBe(0);
	expect(JSON.parse(saved.stdout)).toEqual({
		state: 'saved',
		endpoint,
		hasKey: true,
	});
	expect(saved.stdout + saved.stderr).not.toContain(KEY);

	const missing = await run(['auth', 'key', 'state', 'other', '--json'], '');
	expect(JSON.parse(missing.stdout)).toEqual({ state: 'missing' });

	const keyless = await run(['auth', 'key', 'state', 'local-llm'], '', {
		'local-llm': { endpoint: 'http://localhost:11434/v1', key: '' },
	});
	expect(keyless.stdout).toBe(
		'local-llm: saved for http://localhost:11434/v1 (no key)\n',
	);
});

test('auth key set reads the endpoint and key on stdin, never from arguments', async () => {
	const set = await run(
		['auth', 'key', 'set', 'groq', '--json'],
		JSON.stringify({
			endpoint: 'https://API.groq.com/openai/v1/',
			key: ` ${KEY} `,
		}),
	);
	expect(set.code).toBe(0);
	expect(JSON.parse(set.stdout)).toEqual({
		state: 'saved',
		endpoint: 'https://api.groq.com/openai/v1',
		hasKey: true,
	});
	expect(set.stdout).not.toContain(KEY);

	const inArguments = await run(['auth', 'key', 'set', 'groq', KEY], '');
	expect(inArguments.code).toBe(2);

	const notJson = await run(['auth', 'key', 'set', 'groq', '--json'], KEY);
	expect(notJson.code).toBe(2);
	expect(JSON.parse(notJson.stdout).error).toContain(
		'stdin must be one JSON object',
	);
	expect(notJson.stdout).not.toContain(KEY);

	const badId = await run(['auth', 'key', 'state', '../groq', '--json'], '');
	expect(badId.code).toBe(2);

	const removed = await run(['auth', 'key', 'remove', 'groq', '--json'], '');
	expect(JSON.parse(removed.stdout)).toEqual({ removed: true });
});
