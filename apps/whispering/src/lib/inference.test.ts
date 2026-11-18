/**
 * Inference Request Tests
 *
 * The request Whispering makes, through the endpoints merged at the
 * moment each is sent: a stub `fetch` stands where the network would be, so
 * no socket, provider, or key leaves the test.
 *
 * Key behaviors:
 * - A transcription uploads the audio with the target's model
 * - A request goes only to the endpoint it was prepared for: one removed or
 *   moved since is not sent anywhere
 * - A refusal before sending says nothing was sent; an endpoint that never
 *   answered leaves the outcome unknown; neither carries the key
 */
import { expect, test } from 'bun:test';
import { custom, openAi } from '@epicenter/ai';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { addressOf, type Target, transcribeAt } from './inference.js';

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
		models: ['whisper-1'],
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

const audio = {
	bytes: new Uint8Array([1, 2, 3]),
	name: 'a.webm',
	mimeType: 'audio/webm',
};

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
		await transcribeAt(() => openAi([moved.endpoint]), target, audio),
	);
	expect(changed.name).toBe('EndpointMoved');
	expect(changed.message).toContain(
		`Provider changed from ${BASE_URL} to https://elsewhere.test/v1`,
	);
	expect(seen).toEqual([]);
	expect(moved.seen).toEqual([]);
});

test('a refusal before sending says nothing was sent; no answer leaves the outcome unknown', async () => {
	const shellRefused = provider(() => {
		throw { name: 'OriginRefused', message: 'Saved for another endpoint.' };
	});
	const notSent = expectErr(
		await transcribeAt(
			() => openAi([shellRefused.endpoint]),
			targetOf(shellRefused.endpoint, 'whisper-1'),
			audio,
		),
	);
	expect(notSent.name).toBe('NotSent');
	expect(notSent.message).toContain('Nothing was sent');

	const silent = provider(() => {
		throw new TypeError(`connection reset (authorization ${KEY})`);
	});
	const unknown = expectErr(
		await transcribeAt(
			() => openAi([silent.endpoint]),
			targetOf(silent.endpoint, 'whisper-1'),
			audio,
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

test('a refusal says so, and does not carry the key', async () => {
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
});
