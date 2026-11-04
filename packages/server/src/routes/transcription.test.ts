/**
 * The OpenAI-compatible speech-to-text gateway: model validation, house-key
 * resolution, multipart forwarding with a forced `verbose_json` response, and
 * the OpenAI error convention. The upstream provider call is the global `fetch`,
 * stubbed here so the gateway is exercised without a network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { API_ROUTES } from '@epicenter/server/api-routes';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { mountTranscriptionApp } from './transcription.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

type UpstreamCall = {
	url: string;
	headers: Record<string, string>;
	form: FormData;
};

/** Stub the upstream provider `fetch`, capturing the forwarded multipart form. */
function stubUpstream(response: Response): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			form: init?.body as FormData,
		});
		return response;
	}) as typeof globalThis.fetch;
	return calls;
}

function createTestApp() {
	const app = new Hono<Env>();
	mountTranscriptionApp(app, {
		auth: async (_c, next) => next(),
	});
	return app;
}

function audioForm(fields: Record<string, string>, withFile = true): FormData {
	const form = new FormData();
	if (withFile) {
		form.append('file', new File([new Uint8Array([1, 2, 3])], 'audio.webm'));
	}
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	return form;
}

async function post(
	app: Hono<Env>,
	form: FormData,
	env: Record<string, unknown>,
): Promise<Response> {
	return app.request(
		API_ROUTES.ai.transcriptions.pattern,
		{ method: 'POST', body: form },
		env,
	);
}

describe('transcription gateway', () => {
	test('answers ProviderNotConfigured in the OpenAI error shape when no key is available', async () => {
		const res = await post(
			createTestApp(),
			audioForm({ model: 'whisper-1' }),
			{}, // no house key
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('ProviderNotConfigured');
	});

	test('rejects an unknown model with a 400 UnknownModel', async () => {
		const res = await post(
			createTestApp(),
			audioForm({ model: 'whisper-99' }),
			{
				OPENAI_API_KEY: 'sk-house',
			},
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('UnknownModel');
	});

	test('rejects a body with no audio file with a 400 invalid_request', async () => {
		const res = await post(
			createTestApp(),
			audioForm({ model: 'whisper-1' }, false),
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('invalid_request');
	});

	test('forwards multipart to OpenAI with the house key, forces verbose_json, returns the body verbatim', async () => {
		const calls = stubUpstream(
			new Response(
				JSON.stringify({
					text: '  hello world  ',
					duration: 12.34,
					language: 'en',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		);
		const res = await post(
			createTestApp(),
			audioForm({
				model: 'whisper-1',
				language: 'en',
				prompt: 'Epicenter',
				response_format: 'text',
			}),
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(res.status).toBe(200);
		// Verbatim verbose_json: text untrimmed, duration preserved for metering.
		const body = (await res.json()) as { text: string; duration: number };
		expect(body.text).toBe('  hello world  ');
		expect(body.duration).toBe(12.34);

		expect(calls[0]?.url).toBe(
			'https://api.openai.com/v1/audio/transcriptions',
		);
		expect(calls[0]?.headers.authorization).toBe('Bearer sk-house');
		const forwarded = calls[0]?.form;
		expect(forwarded?.get('response_format')).toBe('verbose_json');
		expect(forwarded?.get('model')).toBe('whisper-1');
		expect(forwarded?.get('language')).toBe('en');
		expect(forwarded?.get('prompt')).toBe('Epicenter');
		expect(forwarded?.get('file')).toBeInstanceOf(File);
	});

	test('forwards an upstream OpenAI-shaped error with its status', async () => {
		stubUpstream(
			new Response(
				JSON.stringify({
					error: { message: 'rate limited', code: 'rate_limit_exceeded' },
				}),
				{ status: 429, headers: { 'content-type': 'application/json' } },
			),
		);
		const res = await post(createTestApp(), audioForm({ model: 'whisper-1' }), {
			OPENAI_API_KEY: 'sk-house',
		});
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('rate_limit_exceeded');
	});
});
