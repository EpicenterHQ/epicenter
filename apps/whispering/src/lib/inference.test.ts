/**
 * Inference Request Tests
 *
 * The two requests Whispering makes, through the endpoints merged at the
 * moment each is sent: a stub `fetch` stands where the network would be, so
 * no socket, provider, or key leaves the test.
 *
 * Key behaviors:
 * - A transcription uploads the audio with the target's model; a
 *   transformation sends its instructions as the system message and the text,
 *   unchanged, as the user message, and reads the streamed answer whole
 * - A request goes only to the endpoint it was prepared for: one removed or
 *   moved since, even while the audio was read, is not sent anywhere; signing
 *   in moves nothing, so a run prepared signed out is sent once signed in
 * - A refusal before sending says nothing was sent; an endpoint that never
 *   answered leaves the outcome unknown; neither carries the key
 */
import { expect, test } from 'bun:test';
import type { Account, AuthState } from '@epicenter/account';
import { custom, hosted, type LiveAccount, openAi } from '@epicenter/ai';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	addressOf,
	type CurrentAi,
	type Target,
	transcribeAt,
	transformAt,
} from './inference.js';

const KEY = 'sk-local-test-key';
const BASE_URL = 'http://127.0.0.1:18080/v1';

type Seen = { url: string; authorization: string | null; request: Request };

/** An endpoint answered by `respond`, with every request it sent recorded. */
function provider(
	respond: (request: Request) => Response | Promise<Response>,
	{ baseUrl = BASE_URL } = {},
) {
	const seen: Seen[] = [];
	const endpoint = custom({
		id: 'provider',
		name: 'Provider',
		baseUrl,
		key: KEY,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			seen.push({
				url: request.url,
				authorization: request.headers.get('authorization'),
				request,
			});
			return respond(request);
		},
		models: ['whisper-1', 'chat-model'],
	});
	return { endpoint, seen };
}

/** The target a request prepared for `endpoint` names. */
const targetOf = (
	endpoint: { id: string; name: string; baseUrl?: string },
	model: string,
): Target => ({
	endpoint: endpoint.id,
	model,
	name: endpoint.name,
	address: addressOf(endpoint),
});

const streamed = (...parts: unknown[]) =>
	new Response(
		`${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('')}data: [DONE]\n\n`,
		{ headers: { 'content-type': 'text/event-stream' } },
	);

const delta = (content: string, finish: string | null = null) => ({
	choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});

const audio = async () =>
	Ok({
		bytes: new Uint8Array([1, 2, 3]),
		filename: 'a.webm',
		mimeType: 'audio/webm',
	});

test('a transcription uploads the audio with the target’s model and reads the text', async () => {
	const { endpoint, seen } = provider(() =>
		Response.json({ text: ' a steady tone ' }),
	);
	const ai = openAi([endpoint]);
	const answer = expectOk(
		await transcribeAt(() => ai, targetOf(endpoint, 'whisper-1'), audio),
	);
	expect(answer).toEqual({ text: 'a steady tone' });
	expect(seen[0]?.url).toBe(`${BASE_URL}/audio/transcriptions`);
	expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
	const form = await seen[0]!.request.formData();
	expect(form.get('model')).toBe('whisper-1');
	const file = form.get('file') as File;
	expect(file.name).toBe('a.webm');
	expect(new Uint8Array(await file.arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3]),
	);
});

test('a transformation sends its instructions and the text unchanged, and reads the streamed answer whole', async () => {
	const { endpoint, seen } = provider(() =>
		streamed(delta('A steady '), delta('tone.', 'stop')),
	);
	const ai = openAi([endpoint]);
	const answer = expectOk(
		await transformAt(() => ai, targetOf(endpoint, 'chat-model'), {
			prompt: 'Fix the punctuation.',
			input: 'um so a steady tone',
		}),
	);
	expect(answer).toEqual({ text: 'A steady tone.' });
	expect(seen[0]?.url).toBe(`${BASE_URL}/chat/completions`);
	const body = (await seen[0]!.request.json()) as Record<string, unknown>;
	expect(body.model).toBe('chat-model');
	expect(body.messages).toEqual([
		{ role: 'system', content: 'Fix the punctuation.' },
		{ role: 'user', content: 'um so a steady tone' },
	]);
});

test('an endpoint removed or moved since the request was prepared is not sent anywhere', async () => {
	const { endpoint, seen } = provider(() => Response.json({ text: 'no' }));
	const target = targetOf(endpoint, 'whisper-1');

	const gone = expectErr(await transcribeAt(() => openAi([]), target, audio));
	expect(gone.name).toBe('EndpointGone');
	expect(gone.message).toContain('Provider is no longer set up');

	const moved = provider(() => Response.json({ text: 'no' }), {
		baseUrl: 'https://elsewhere.test/v1',
	});
	const changed = expectErr(
		await transformAt(() => openAi([moved.endpoint]), target, {
			prompt: 'p',
			input: 'i',
		}),
	);
	expect(changed.name).toBe('EndpointMoved');
	expect(changed.message).toContain(
		`prepared for Provider at ${BASE_URL}, which now sends to https://elsewhere.test/v1`,
	);
	expect(seen).toEqual([]);
	expect(moved.seen).toEqual([]);
});

test('a connection moved while the audio was read is not sent to either', async () => {
	const before = provider(() => Response.json({ text: 'no' }));
	const after = provider(() => Response.json({ text: 'no' }), {
		baseUrl: 'https://elsewhere.test/v1',
	});
	let current = openAi([before.endpoint]);
	const merged: CurrentAi = () => current;
	const error = expectErr(
		await transcribeAt(
			merged,
			targetOf(before.endpoint, 'whisper-1'),
			async () => {
				current = openAi([after.endpoint]);
				return audio();
			},
		),
	);
	expect(error.name).toBe('EndpointMoved');
	expect(before.seen).toEqual([]);
	expect(after.seen).toEqual([]);
});

/** A sign-in a test signs in, as the account's client does; everything it sends is answered `text`. */
function liveAccount(text: string) {
	const seen: string[] = [];
	const listeners = new Set<(state: AuthState) => void>();
	let state: AuthState = { status: 'signed-out' };
	const account: LiveAccount = {
		baseURL: 'https://api.epicenter.test',
		getState: () => state,
		onStateChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		account,
		seen,
		signIn() {
			state = {
				status: 'signed-in',
				account: {
					baseURL: 'https://api.epicenter.test',
					signal: new AbortController().signal,
					fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
						seen.push(new Request(input, init).url);
						return Response.json({ text });
					},
				} as unknown as Account,
			};
			for (const listener of listeners) listener(state);
		},
	};
}

test('a run prepared while signed out, tried again once signed in, is sent where it was prepared for', async () => {
	const live = liveAccount('signed in now');
	const ai = openAi([hosted(live.account)]);
	const target = targetOf(ai.endpoints()[0]!, 'whisper-1');
	const before = expectErr(await transcribeAt(() => ai, target, audio));
	expect(before.name).toBe('NotSent');

	live.signIn();
	expect(expectOk(await transcribeAt(() => ai, target, audio))).toEqual({
		text: 'signed in now',
	});
	expect(live.seen).toEqual([
		'https://api.epicenter.test/v1/audio/transcriptions',
	]);
});

test('a refusal before sending says nothing was sent; no answer leaves the outcome unknown', async () => {
	const signedOut = hosted(liveAccount('never').account);
	const notSent = expectErr(
		await transcribeAt(
			() => openAi([signedOut]),
			targetOf(signedOut, 'whisper-1'),
			audio,
		),
	);
	expect(notSent.name).toBe('NotSent');
	expect(notSent.message).toContain('Nothing was sent');

	const shellRefused = provider(() => {
		throw { name: 'OriginRefused', message: 'Saved for another endpoint.' };
	});
	expect(
		expectErr(
			await transcribeAt(
				() => openAi([shellRefused.endpoint]),
				targetOf(shellRefused.endpoint, 'whisper-1'),
				audio,
			),
		).name,
	).toBe('NotSent');

	const silent = provider(() => {
		throw new TypeError(`connection reset (authorization ${KEY})`);
	});
	const unknown = expectErr(
		await transformAt(
			() => openAi([silent.endpoint]),
			targetOf(silent.endpoint, 'chat-model'),
			{ prompt: 'p', input: 'i' },
		),
	);
	expect(unknown.name).toBe('OutcomeUnknown');
	expect(unknown.message).toContain(
		'it is not known whether the request was sent',
	);
	expect(unknown.message).toContain(
		'Nothing is sent again unless you try again',
	);
});

test('a refusal, an error mid-answer, and an empty answer each say so, and none carries the key', async () => {
	const refusing = provider(() =>
		Response.json(
			{ error: { message: `Incorrect API key provided: ${KEY}` } },
			{ status: 401 },
		),
	);
	const rejected = expectErr(
		await transcribeAt(
			() => openAi([refusing.endpoint]),
			targetOf(refusing.endpoint, 'whisper-1'),
			audio,
		),
	);
	expect(rejected.name).toBe('Rejected');
	expect(rejected.message).toContain('Provider answered 401');
	expect(JSON.stringify(rejected)).not.toContain(KEY);

	const failing = provider(() =>
		streamed(delta('half'), { error: { message: 'overloaded' } }),
	);
	const failed = expectErr(
		await transformAt(
			() => openAi([failing.endpoint]),
			targetOf(failing.endpoint, 'chat-model'),
			{ prompt: 'p', input: 'i' },
		),
	);
	expect(failed.name).toBe('Failed');
	expect(failed.message).toContain('overloaded');

	const empty = provider(() => streamed(delta('  ', 'stop')));
	expect(
		expectErr(
			await transformAt(
				() => openAi([empty.endpoint]),
				targetOf(empty.endpoint, 'chat-model'),
				{ prompt: 'p', input: 'i' },
			),
		).name,
	).toBe('Empty');
});
