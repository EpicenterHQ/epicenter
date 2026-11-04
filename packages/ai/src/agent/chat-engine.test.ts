/**
 * The chat engine builds an OpenAI chat request from the
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
import { custom } from '../custom.js';
import { openAi } from '../open-ai.js';
import { createChatEngine } from './chat-engine.js';
import type { AgentEngineRequest, EngineChunk } from './engine.js';

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

/** The engine over one custom endpoint at `baseURL`, sent through `fetch` with `apiKey`. */
function engineOver({
	fetch,
	baseURL,
	apiKey,
	model = 'model',
	systemPrompts = [],
}: {
	fetch?: typeof globalThis.fetch;
	baseURL: string;
	apiKey?: string;
	model?: string;
	systemPrompts?: string[];
}) {
	const ai = openAi([
		custom({ id: 'test', baseUrl: baseURL, key: apiKey, fetch }),
	]);
	return createChatEngine({
		turn: () => ({ ai, endpoint: 'test', model, systemPrompts }),
	});
}

describe('createChatEngine', () => {
	test('sends the system prompts before the transcript, with the tools as given, streaming', async () => {
		const { fetch, calls } = capturingFetch(
			openAiSse([
				{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
			]),
		);
		const engine = engineOver({
			fetch,
			baseURL: GATEWAY,
			apiKey: 'test',
			model: 'gpt-5.5',
			systemPrompts: ['be brief'],
		});

		const request: AgentEngineRequest = {
			messages: [
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
			],
			tools: [
				{
					type: 'function',
					function: {
						name: 'get_weather',
						parameters: { type: 'object', properties: {} },
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
			...request.messages,
		]);
		expect(body.tools).toEqual(request.tools);
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
		const engine = engineOver({
			fetch: recordingFetch,
			baseURL: 'https://example.test/v1/',
			apiKey: 'test',
			model: 'gpt-5.5',
			systemPrompts: [],
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
		const chunks = await drainFrames([
			{ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
			{ choices: [{ delta: { content: ', world' }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] },
			{ usage: { total_tokens: 5 }, choices: [] },
		]);
		expect(chunks).toEqual([
			{ type: 'text-delta', delta: 'Hello' },
			{ type: 'text-delta', delta: ', world' },
		]);
	});

	test('reduces an OpenAI tool call from index-correlated fragmented deltas', async () => {
		const ends = toolCalls(
			await drainFrames([
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
		const engine = engineOver({
			fetch,
			baseURL: GATEWAY,
			apiKey: 'test',
			model: 'gemini-3.5-flash',
			systemPrompts: [],
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
		const engine = engineOver({
			fetch,
			baseURL: GATEWAY,
			apiKey: 'test',
			model: 'gpt-5.5',
			systemPrompts: [],
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

	test('sends to the endpoint destination with its bearer', async () => {
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
			const engine = engineOver({
				baseURL: 'http://localhost:11434/v1',
				apiKey: 'sk-user',
				model: 'qwen2.5:3b',
				systemPrompts: [],
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

// Stream framing and failed-stream admission

test('decodes CRLF and multiline SSE data and stops at DONE', async () => {
	const response = new Response(
		[
			'data: {"choices": [\r\n',
			'data: {"delta": {"content": "hello"}, "finish_reason": "stop"}]}\r\n\r\n',
			'data: [DONE]\r\n\r\n',
			'data: {"choices":[{"delta":{"content":"ignored"}}]}\r\n\r\n',
		].join(''),
		{ headers: { 'content-type': 'text/event-stream' } },
	);
	const { fetch } = capturingFetch(response);
	const engine = engineOver({ fetch, baseURL: GATEWAY, apiKey: 'test' });
	expect(
		await drain(
			engine({ messages: [], tools: [] }, new AbortController().signal),
		),
	).toEqual([{ type: 'text-delta', delta: 'hello' }]);
});

test('an SSE API error preserves its code and discards pending tool calls', async () => {
	const { fetch } = capturingFetch(
		openAiSse([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: 'call',
									function: { name: 'write', arguments: '{}' },
								},
							],
						},
					},
				],
			},
			{ error: { message: 'Retired', code: 'AccountRetired' } },
		]),
	);
	const engine = engineOver({ fetch, baseURL: GATEWAY, apiKey: 'test' });
	expect(
		await drain(
			engine({ messages: [], tools: [] }, new AbortController().signal),
		),
	).toEqual([
		{ type: 'run-error', message: 'Retired', code: 'AccountRetired' },
	]);
});

test('malformed SSE JSON fails the run and discards pending tool calls', async () => {
	const { fetch } = capturingFetch(
		new Response('data: malformed\n\n', {
			headers: { 'content-type': 'text/event-stream' },
		}),
	);
	const engine = engineOver({ fetch, baseURL: GATEWAY, apiKey: 'test' });
	const chunks = await drain(
		engine({ messages: [], tools: [] }, new AbortController().signal),
	);
	expect(chunks).toEqual([
		{
			type: 'run-error',
			message:
				"The endpoint's answer did not read: malformed server-sent event JSON.",
			code: 'stream-error',
		},
	]);
});

test('abort after a text delta cancels the body and emits no pending tools', async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					`data: ${JSON.stringify({ choices: [{ delta: { content: 'before', tool_calls: [{ index: 0, id: 'call', function: { name: 'write', arguments: '{}' } }] } }] })}\n\n`,
				),
			);
		},
		cancel() {
			cancelled = true;
		},
	});
	const { fetch } = capturingFetch(
		new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
	);
	const engine = engineOver({ fetch, baseURL: GATEWAY, apiKey: 'test' });
	const controller = new AbortController();
	const chunks: EngineChunk[] = [];
	for await (const chunk of engine(
		{ messages: [], tools: [] },
		controller.signal,
	)) {
		chunks.push(chunk);
		controller.abort();
	}
	expect(chunks).toEqual([{ type: 'text-delta', delta: 'before' }]);
	expect(cancelled).toBe(true);
});

// Finish reasons: only a finished answer is a successful stream

async function drainFrames(frames: object[]) {
	const { fetch } = capturingFetch(openAiSse(frames));
	const engine = engineOver({ fetch, baseURL: GATEWAY, apiKey: 'test' });
	return drain(
		engine({ messages: [], tools: [] }, new AbortController().signal),
	);
}

const writeCall = {
	tool_calls: [
		{ index: 0, id: 'call', function: { name: 'write', arguments: '{}' } },
	],
};

test('an answer cut off at the output limit fails the run after its text', async () => {
	expect(
		await drainFrames([
			{ choices: [{ delta: { content: 'cut off' }, finish_reason: 'length' }] },
		]),
	).toEqual([
		{ type: 'text-delta', delta: 'cut off' },
		{
			type: 'run-error',
			message: 'The model reached its output limit before finishing.',
			code: 'length',
		},
	]);
});

test('a filtered answer fails the run', async () => {
	const chunks = await drainFrames([
		{ choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
		{ choices: [{ delta: {}, finish_reason: 'content_filter' }] },
	]);
	expect(chunks.at(-1)).toMatchObject({
		type: 'run-error',
		code: 'content_filter',
	});
});

test('a stream that ends without a finish reason fails the run, even after a usage frame', async () => {
	const chunks = await drainFrames([
		{ choices: [{ delta: { content: 'half' }, finish_reason: null }] },
		{ usage: { total_tokens: 5 }, choices: [] },
	]);
	expect(chunks).toEqual([
		{ type: 'text-delta', delta: 'half' },
		{
			type: 'run-error',
			message: 'The model stream ended before the answer finished.',
			code: 'incomplete-stream',
		},
	]);
});

test('a usage frame after the finish does not undo it', async () => {
	expect(
		await drainFrames([
			{ choices: [{ delta: { content: 'done' }, finish_reason: null }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] },
			{ usage: { total_tokens: 5 }, choices: [] },
		]),
	).toEqual([{ type: 'text-delta', delta: 'done' }]);
});

test('tool calls cut off at the output limit or left unfinished never run', async () => {
	for (const finish_reason of ['length', 'content_filter', null]) {
		const chunks = await drainFrames([
			{ choices: [{ delta: writeCall, finish_reason }] },
		]);
		expect(toolCalls(chunks)).toEqual([]);
		expect(chunks.map((chunk) => chunk.type)).toEqual(['run-error']);
	}
});

test('a tool_calls finish with no call fails the run', async () => {
	expect(
		await drainFrames([
			{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
		]),
	).toEqual([
		{
			type: 'run-error',
			message: 'The model announced tool calls and sent none.',
			code: 'incomplete-stream',
		},
	]);
});

test('a finish reason outside the OpenAI vocabulary fails the run', async () => {
	const chunks = await drainFrames([
		{ choices: [{ delta: { content: 'text' }, finish_reason: 'recitation' }] },
	]);
	expect(chunks.at(-1)).toMatchObject({
		type: 'run-error',
		code: 'incomplete-stream',
	});
});
