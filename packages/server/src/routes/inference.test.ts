/**
 * The OpenAI-compatible inference gateway: provider routing, house-key
 * resolution, pure passthrough (the client owns SSE normalization, ADR-0054),
 * and the OpenAI error convention. The upstream provider call is the global
 * `fetch`, stubbed here to a canned SSE response so the gateway is exercised
 * without a network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { mountInferenceApp } from './inference.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Build an OpenAI SSE body: one `data:` frame per chunk, then `[DONE]`. */
function sse(chunks: object[]): string {
	return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
}

type UpstreamCall = {
	url: string;
	headers: Record<string, string>;
	body: string;
};

/** Stub the upstream provider `fetch`, recording each call. */
function stubUpstream(response: Response): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: String(init?.body ?? ''),
		});
		return response;
	}) as typeof globalThis.fetch;
	return calls;
}

function createTestApp() {
	const app = new Hono<Env>();
	mountInferenceApp(app, {
		// Permissive auth for the slice under test.
		auth: async (_c, next) => next(),
	});
	return app;
}

async function post(
	app: Hono<Env>,
	body: object,
	env: Record<string, unknown>,
): Promise<Response> {
	return app.request(
		API_ROUTES.ai.completions.pattern,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
		env,
	);
}

describe('inference gateway', () => {
	test('answers ProviderNotConfigured in the OpenAI error shape when no key is available', async () => {
		const res = await post(
			createTestApp(),
			{ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] },
			{}, // no house key, no BYOK
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('ProviderNotConfigured');
	});

	test('rejects an unknown model with a 400 UnknownModel', async () => {
		const res = await post(
			createTestApp(),
			{ model: 'gpt-99', messages: [{ role: 'user', content: 'hi' }] },
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('UnknownModel');
	});

	test('OpenAI: forwards to the OpenAI endpoint with the house key and streams back', async () => {
		const upstream = sse([
			{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
		]);
		const calls = stubUpstream(
			new Response(upstream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}),
		);
		const res = await post(
			createTestApp(),
			{ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(upstream);

		expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(calls[0]?.headers.authorization).toBe('Bearer sk-house');
		const forwarded = JSON.parse(calls[0]?.body ?? '{}');
		expect(forwarded.model).toBe('gpt-5.5');
	});

	test('Gemini: routes to the compat endpoint with the house key and passes the stream through untouched', async () => {
		// The gateway no longer rewrites the stream (ADR-0054): the client
		// accumulates Gemini's index-less tool_calls itself, so an index-less delta
		// must reach the client exactly as the provider sent it.
		const upstream = sse([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									id: 'call_a',
									type: 'function',
									function: {
										name: 'get_weather',
										arguments: '{"city":"Paris"}',
									},
								},
							],
						},
						finish_reason: 'stop',
					},
				],
			},
		]);
		const calls = stubUpstream(
			new Response(upstream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}),
		);
		const res = await post(
			createTestApp(),
			{
				model: 'gemini-3.5-flash',
				messages: [{ role: 'user', content: 'go' }],
			},
			{ GEMINI_API_KEY: 'g-house' },
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(upstream);

		expect(calls[0]?.url).toBe(
			'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
		);
		expect(calls[0]?.headers.authorization).toBe('Bearer g-house');
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
		const res = await post(
			createTestApp(),
			{ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('rate_limit_exceeded');
	});
});
