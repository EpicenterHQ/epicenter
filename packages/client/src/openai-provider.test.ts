/**
 * The OpenAI-compatible engine builds an OpenAI Chat Completions request from the
 * transcript and tool catalog, and parses the streamed reply into the loop's
 * {@link EngineChunk} vocabulary. A fake `fetch` captures the request body and
 * returns a canned OpenAI SSE stream, so this exercises the real request builder
 * and the real defensive tool-call reducer without a network.
 *
 * The reducer is load-bearing (ADR-0050, Wave 1 gate): OpenAI fragments a call's
 * arguments across `index`-correlated deltas, while Gemini's compat endpoint
 * sends each parallel call complete in one delta but omits `index`. The
 * `does-not-merge-index-less-parallel-calls` test pins the Gemini case.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentEngineRequest, EngineChunk } from './agent-engine.js';
import { resolveConnection } from './connection.js';
import { createOpenAiAgentEngine } from './openai-provider.js';

/** Build an OpenAI SSE response: one `data:` frame per chunk, then `[DONE]`. */
function openAiSse(chunks: object[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
				);
			}
			controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

/**
 * Build an SSE response from raw byte chunks, so a test controls the exact line
 * endings and where the network splits them.
 */
function rawSse(parts: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(encoder.encode(part));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

/** A `fetch` that records the last request body and returns a fixed Response. */
function capturingFetch(response: Response) {
	const calls: Array<Record<string, unknown>> = [];
	const fetch = (async (_url: string, init?: RequestInit) => {
		calls.push(JSON.parse(String(init?.body)));
		return response;
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

async function drain(
	stream: AsyncIterable<EngineChunk>,
): Promise<EngineChunk[]> {
	const out: EngineChunk[] = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

function toolCalls(chunks: EngineChunk[]) {
	return chunks.filter(
		(c): c is Extract<EngineChunk, { type: 'tool-call' }> =>
			c.type === 'tool-call',
	);
}

const GATEWAY = 'https://example.test/v1';

describe('createOpenAiAgentEngine', () => {
	test('builds the OpenAI request: system prompts, mapped transcript, tools, streaming', async () => {
		const { fetch, calls } = capturingFetch(
			openAiSse([
				{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
			]),
		);
		const engine = createOpenAiAgentEngine({
			data: () => ({
				fetch,
				baseURL: GATEWAY,
				model: 'gpt-5.5',
				systemPrompts: ['be brief'],
			}),
		});

		const request: AgentEngineRequest = {
			messages: [
				{ role: 'user', content: 'weather?' },
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{
							id: 'call_1',
							type: 'function',
							function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
						},
					],
				},
				{
					role: 'tool',
					toolCallId: 'call_1',
					name: 'get_weather',
					content: '17C',
				},
			],
			tools: [
				{
					name: 'get_weather',
					description: 'Look up weather',
					inputSchema: {
						type: 'object',
						properties: { city: { type: 'string' } },
						required: ['city'],
					},
				},
			],
		};
		await drain(engine(request, new AbortController().signal));

		const body = calls[0] ?? {};
		expect(body.model).toBe('gpt-5.5');
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(body.messages).toEqual([
			{ role: 'system', content: 'be brief' },
			{ role: 'user', content: 'weather?' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
					},
				],
			},
			{ role: 'tool', tool_call_id: 'call_1', content: '17C' },
		]);
		expect(body.tools).toEqual([
			{
				type: 'function',
				function: {
					name: 'get_weather',
					description: 'Look up weather',
					parameters: {
						type: 'object',
						properties: { city: { type: 'string' } },
						required: ['city'],
					},
				},
			},
		]);
	});

	test('POSTs to <baseURL>/chat/completions and omits tools when the catalog is empty', async () => {
		const { fetch, calls } = capturingFetch(
			openAiSse([
				{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
			]),
		);
		let requestedUrl = '';
		const recordingFetch = (async (url: string, init?: RequestInit) => {
			requestedUrl = String(url);
			return fetch(url, init);
		}) as unknown as typeof globalThis.fetch;
		const engine = createOpenAiAgentEngine({
			data: () => ({
				fetch: recordingFetch,
				baseURL: 'https://example.test/v1/',
				model: 'gpt-5.5',
				systemPrompts: [],
			}),
		});

		await drain(
			engine(
				{ messages: [{ role: 'user', content: 'hi' }], tools: [] },
				new AbortController().signal,
			),
		);

		expect(requestedUrl).toBe('https://example.test/v1/chat/completions');
		expect('tools' in (calls[0] ?? {})).toBe(false);
	});

	test('streams text deltas in order', async () => {
		const { fetch } = capturingFetch(
			openAiSse([
				{ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
				{ choices: [{ delta: { content: ', world' }, finish_reason: null }] },
				{ choices: [{ delta: {}, finish_reason: 'stop' }] },
				{ usage: { total_tokens: 5 }, choices: [] },
			]),
		);
		const engine = createOpenAiAgentEngine({
			data: () => ({
				fetch,
				baseURL: GATEWAY,
				model: 'gpt-5.5',
				systemPrompts: [],
			}),
		});

		const chunks = await drain(
			engine(
				{ messages: [{ role: 'user', content: 'hi' }], tools: [] },
				new AbortController().signal,
			),
		);
		expect(
			chunks
				.filter((c) => c.type === 'text-delta')
				.map((c) => (c as { delta: string }).delta)
				.join(''),
		).toBe('Hello, world');
	});

	test('reduces an OpenAI tool call from index-correlated fragmented deltas', async () => {
		const { fetch } = capturingFetch(
			openAiSse([
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'call_1',
										type: 'function',
										function: { name: 'get_weather', arguments: '' },
									},
								],
							},
							finish_reason: null,
						},
					],
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
							},
							finish_reason: null,
						},
					],
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
							},
							finish_reason: null,
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
			]),
		);
		const engine = createOpenAiAgentEngine({
			data: () => ({
				fetch,
				baseURL: GATEWAY,
				model: 'gpt-5.5',
				systemPrompts: [],
			}),
		});

		const ends = toolCalls(
			await drain(
				engine(
					{ messages: [{ role: 'user', content: 'go' }], tools: [] },
					new AbortController().signal,
				),
			),
		);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({
			toolCallId: 'call_1',
			toolName: 'get_weather',
			input: { city: 'Paris' },
		});
	});

	// The Wave 1 gate: Gemini's compat endpoint sends two parallel calls as two
	// complete deltas with NO `index`. A reducer keying everything by `index ?? 0`
	// would merge them and concatenate their args into invalid JSON. Each must
	// stay its own call.
	test('parses a stream framed with CRLF line endings', async () => {
		// The SSE spec allows CRLF, LF, or CR line endings, and servers built on
		// sse-starlette (its default separator is `\r\n`) frame every event with
		// `\r\n\r\n`. The frame boundary here also lands between reads.
		const frame = (chunk: object) => `data: ${JSON.stringify(chunk)}\r\n\r\n`;
		const stream = [
			frame({
				choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
			}),
			frame({
				choices: [{ delta: { content: ', world' }, finish_reason: null }],
			}),
			frame({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: 'call_1',
									type: 'function',
									function: { name: 'lookup', arguments: '{"q":"hi"}' },
								},
							],
						},
						finish_reason: 'tool_calls',
					},
				],
			}),
			'data: [DONE]\r\n\r\n',
		].join('');
		// Split one read inside the first `\r\n\r\n`, and another mid-JSON.
		const cut = stream.indexOf('\r\n\r\n') + 3;
		const { fetch } = capturingFetch(
			rawSse([
				stream.slice(0, cut),
				stream.slice(cut, cut + 20),
				stream.slice(cut + 20),
			]),
		);
		const engine = createOpenAiAgentEngine({
			data: () => ({
				fetch,
				baseURL: GATEWAY,
				model: 'local-model',
				systemPrompts: [],
			}),
		});

		const chunks = await drain(
			engine(
				{ messages: [{ role: 'user', content: 'hi' }], tools: [] },
				new AbortController().signal,
			),
		);
		expect(
			chunks
				.filter((c) => c.type === 'text-delta')
				.map((c) => (c as { delta: string }).delta)
				.join(''),
		).toBe('Hello, world');
		expect(toolCalls(chunks)).toEqual([
			{
				type: 'tool-call',
				toolCallId: 'call_1',
				toolName: 'lookup',
				input: { q: 'hi' },
			},
		]);
	});

	test('does not merge index-less parallel calls (Gemini compat shape)', async () => {
		const { fetch } = capturingFetch(
			openAiSse([
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
											arguments: '{"city":"Paris","unit":"celsius"}',
										},
									},
								],
							},
							finish_reason: null,
						},
					],
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										id: 'call_b',
										type: 'function',
										function: {
											name: 'get_weather',
											arguments: '{"city":"Tokyo","unit":"celsius"}',
										},
									},
								],
							},
							// Gemini sometimes finishes 'stop' while emitting a tool call.
							finish_reason: 'stop',
						},
					],
				},
			]),
		);
		const engine = createOpenAiAgentEngine({
			data: () => ({
				fetch,
				baseURL: GATEWAY,
				model: 'gemini-3.5-flash',
				systemPrompts: [],
			}),
		});

		const ends = toolCalls(
			await drain(
				engine(
					{ messages: [{ role: 'user', content: 'weather both' }], tools: [] },
					new AbortController().signal,
				),
			),
		);
		expect(ends).toHaveLength(2);
		expect(ends.map((c) => c.input)).toEqual([
			{ city: 'Paris', unit: 'celsius' },
			{ city: 'Tokyo', unit: 'celsius' },
		]);
		expect(ends.map((c) => c.toolCallId)).toEqual(['call_a', 'call_b']);
	});

	test('maps a non-2xx OpenAI error body to a run-error, preserving the code', async () => {
		const errorResponse = new Response(
			JSON.stringify({
				error: { message: 'Out of credits', code: 'InsufficientCredits' },
			}),
			{ status: 402, headers: { 'content-type': 'application/json' } },
		);
		const { fetch } = capturingFetch(errorResponse);
		const engine = createOpenAiAgentEngine({
			data: () => ({
				fetch,
				baseURL: GATEWAY,
				model: 'gpt-5.5',
				systemPrompts: [],
			}),
		});

		const chunks = await drain(
			engine(
				{ messages: [{ role: 'user', content: 'go' }], tools: [] },
				new AbortController().signal,
			),
		);
		const error = chunks.find((c) => c.type === 'run-error') as
			| { message?: string; code?: string }
			| undefined;
		expect(error?.message).toBe('Out of credits');
		expect(error?.code).toBe('InsufficientCredits');
	});

	// End-to-end custom backend: the resolver + engine reach a custom URL with the
	// user's key. The hosted (Epicenter) bearer is structurally unreachable here:
	// `resolveConnection` takes only the connection data and never an Epicenter fetch,
	// so a custom turn cannot carry the session (ADR-0053/0060). This is the
	// non-interactive stand-in for "switch tab-manager to a local Ollama"; the live
	// extension test is the remaining manual check.
	test('drives a custom backend through the resolver: custom URL, user key as Bearer', async () => {
		const realFetch = globalThis.fetch;
		const calls: Array<{ url: string; authorization: string | null }> = [];
		globalThis.fetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			calls.push({
				url: String(url),
				authorization: new Headers(init?.headers).get('authorization'),
			});
			return openAiSse([
				{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
			]);
		}) as typeof globalThis.fetch;
		try {
			const engine = createOpenAiAgentEngine({
				data: () => ({
					...resolveConnection({
						baseUrl: 'http://localhost:11434/v1',
						apiKey: 'sk-user',
					}),
					model: 'qwen2.5:3b',
					systemPrompts: [],
				}),
			});
			await drain(
				engine(
					{ messages: [{ role: 'user', content: 'hi' }], tools: [] },
					new AbortController().signal,
				),
			);
			expect(calls).toEqual([
				{
					url: 'http://localhost:11434/v1/chat/completions',
					authorization: 'Bearer sk-user',
				},
			]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
